// 同步系统 - 队列管理、重试、三方合并、模板版本感知冲突检测
const SyncManager = (() => {
  let _syncing = false;
  let _currentBatch = 0;
  let _aborted = false;
  let _listeners = [];
  const BATCH_SIZE = 10;
  const MAX_RETRIES = 5;
  const BASE_DELAY = 1000;
  const MAX_DELAY = 60000;
  const CHECK_INTERVAL = 30000;
  let _intervalId = null;

  // 实体级同步锁（防止对同一实体发起重复同步请求）
  const _syncingEntities = new Set();

  // 内部字段列表（合并时跳过）
  const INTERNAL_FIELDS = new Set([
    '_hmac', '_encrypted_idCard', '_dataCorrupted',
    'syncStatus', 'syncVersion', 'revision'
  ]);

  // 模拟远程服务器
  const _mockServer = {
    data: {},
    delay: () => new Promise(r => setTimeout(r, 200 + Math.random() * 800)),

    async push(entityType, entityId, payload, localVersion) {
      await this.delay();

      if (Math.random() < 0.1) {
        throw new Error('网络请求失败');
      }

      const key = `${entityType}:${entityId}`;
      const existing = this.data[key];

      if (existing && existing.version > localVersion) {
        const error = new Error('CONFLICT');
        error.remoteData = existing.payload;
        error.remoteVersion = existing.version;
        throw error;
      }

      const newVersion = (existing ? existing.version : 0) + 1;
      this.data[key] = {
        payload: payload,
        version: newVersion,
        updatedAt: new Date().toISOString()
      };

      return { success: true, version: newVersion };
    },

    async pull(entityType, entityId) {
      await this.delay();
      const key = `${entityType}:${entityId}`;
      return this.data[key] || null;
    }
  };

  function addListener(fn) {
    _listeners.push(fn);
  }

  function removeListener(fn) {
    _listeners = _listeners.filter(l => l !== fn);
  }

  function _notify(event, data) {
    _listeners.forEach(fn => {
      try { fn(event, data); } catch (e) { console.error('Sync listener error:', e); }
    });
  }

  function startAutoSync() {
    if (_intervalId) return;
    _intervalId = setInterval(() => {
      if (navigator.onLine && !_syncing) {
        syncAll();
      }
    }, CHECK_INTERVAL);

    window.addEventListener('online', () => {
      Utils.showToast('网络已恢复，开始同步...', 'success');
      if (!_syncing) syncAll();
    });
  }

  function stopAutoSync() {
    if (_intervalId) {
      clearInterval(_intervalId);
      _intervalId = null;
    }
  }

  // 主同步流程
  async function syncAll() {
    if (_syncing || !navigator.onLine) return;
    _syncing = true;
    _aborted = false;
    _currentBatch = 0;

    _notify('start', {});

    try {
      const queue = await DB.getSyncQueue();
      if (queue.length === 0) {
        _notify('complete', { synced: 0, conflicts: 0, failed: 0 });
        _syncing = false;
        return;
      }

      let synced = 0;
      let conflicts = 0;
      let failed = 0;

      for (let i = 0; i < queue.length; i += BATCH_SIZE) {
        if (_aborted || !navigator.onLine) {
          _notify('interrupted', { synced, conflicts, failed, remaining: queue.length - i });
          break;
        }

        _currentBatch = Math.floor(i / BATCH_SIZE) + 1;
        const batch = queue.slice(i, i + BATCH_SIZE);
        _notify('batch', { batch: _currentBatch, total: Math.ceil(queue.length / BATCH_SIZE) });

        for (const item of batch) {
          if (_aborted || !navigator.onLine) break;

          // 实体级去重锁
          const entityKey = `${item.entityType}:${item.entityId}`;
          if (_syncingEntities.has(entityKey)) {
            continue; // 跳过正在同步的实体
          }

          _syncingEntities.add(entityKey);
          try {
            await _syncItem(item);
            synced++;
            await DB.removeSyncQueueItem(item.id);
            // 同步成功后清除基线快照
            await DB.removeBaseSnapshot(item.entityId);
            _notify('item-synced', { itemId: item.id, entityId: item.entityId });
          } catch (err) {
            if (err.message === 'CONFLICT') {
              conflicts++;
              await _handleConflict(item, err.remoteData, err.remoteVersion);
              await DB.removeSyncQueueItem(item.id);
              _notify('conflict', { itemId: item.id, entityId: item.entityId });
            } else {
              failed++;
              await _handleRetry(item, err.message);
              _notify('item-failed', { itemId: item.id, error: err.message });
            }
          } finally {
            _syncingEntities.delete(entityKey);
          }
        }
      }

      if (!_aborted && navigator.onLine) {
        await DB.setSetting('lastSyncTime', Utils.now());
        _notify('complete', { synced, conflicts, failed });
        if (synced > 0) {
          Utils.showToast(`同步完成：${synced} 条成功`, 'success');
        }
      }
    } catch (err) {
      console.error('Sync error:', err);
      _notify('error', { error: err.message });
    } finally {
      _syncing = false;
    }
  }

  // 同步单条记录
  async function _syncItem(item) {
    let payload = item.payload;

    if (payload && payload._encrypted && CryptoManager.isReady()) {
      try {
        const decrypted = await CryptoManager.decrypt(payload._encrypted);
        payload = JSON.parse(decrypted);
      } catch {
        throw new Error('数据解密失败');
      }
    }

    const db = await DB.open();
    let localVersion = 0;
    if (item.entityType === 'patients') {
      const p = await DB.get(db, 'patients', item.entityId);
      if (p) localVersion = p.syncVersion || 0;
    } else if (item.entityType === 'visits') {
      const v = await DB.get(db, 'visits', item.entityId);
      if (v) localVersion = v.syncVersion || 0;
    }

    const result = await _mockServer.push(
      item.entityType, item.entityId, payload, localVersion
    );

    if (result.success) {
      if (item.entityType === 'patients') {
        const p = await DB.get(db, 'patients', item.entityId);
        if (p) {
          p.syncStatus = 'synced';
          p.syncVersion = result.version;
          await DB.put(db, 'patients', p);
        }
      } else if (item.entityType === 'visits') {
        const v = await DB.get(db, 'visits', item.entityId);
        if (v) {
          v.syncStatus = 'synced';
          v.syncVersion = result.version;
          await DB.put(db, 'visits', v);
        }
      }
    }
  }

  // 处理冲突（附带基线快照和模板版本信息）
  async function _handleConflict(item, remoteData, remoteVersion) {
    let localData = item.payload;
    if (localData && localData._encrypted && CryptoManager.isReady()) {
      try {
        localData = JSON.parse(await CryptoManager.decrypt(localData._encrypted));
      } catch { /* keep as is */ }
    }

    // 获取基线快照（三方合并的祖先）
    const baseData = await DB.getBaseSnapshot(item.entityId);

    // 检测模板版本不一致
    let templateVersionMismatch = false;
    let localTemplateVersion = null;
    let remoteTemplateVersion = null;
    if (item.entityType === 'visits') {
      localTemplateVersion = localData && localData.templateVersion;
      remoteTemplateVersion = remoteData && remoteData.templateVersion;
      if (localTemplateVersion && remoteTemplateVersion &&
          localTemplateVersion !== remoteTemplateVersion) {
        templateVersionMismatch = true;
      }
    }

    const conflict = {
      id: Utils.uuid(),
      entityType: item.entityType,
      entityId: item.entityId,
      localData: localData,
      remoteData: remoteData,
      baseData: baseData || null,
      localVersion: (localData && localData.syncVersion) || 0,
      remoteVersion: remoteVersion,
      localRevision: (localData && localData.revision) || 0,
      remoteRevision: (remoteData && remoteData.revision) || 0,
      templateVersionMismatch,
      localTemplateVersion,
      remoteTemplateVersion,
      resolved: false,
      resolvedData: null,
      createdAt: Utils.now()
    };

    await DB.saveConflict(conflict);
  }

  // 处理重试
  async function _handleRetry(item, errorMessage) {
    const db = await DB.open();
    item.retryCount = (item.retryCount || 0) + 1;
    item.lastError = errorMessage;

    if (item.retryCount >= MAX_RETRIES) {
      item.syncStatus = 'failed';
      await DB.put(db, 'sync_queue', item);
      _notify('max-retries', { itemId: item.id, entityId: item.entityId });
      return;
    }

    const delay = Math.min(BASE_DELAY * Math.pow(2, item.retryCount - 1), MAX_DELAY);
    await new Promise(r => setTimeout(r, delay));

    await DB.put(db, 'sync_queue', item);
  }

  function abort() {
    _aborted = true;
    _notify('aborted', {});
  }

  // 解决冲突
  async function resolveConflict(conflictId, resolvedData, choice) {
    const db = await DB.open();
    const conflict = await DB.get(db, 'sync_conflicts', conflictId);
    if (!conflict) return;

    conflict.resolved = true;
    conflict.resolvedData = resolvedData;
    conflict.choice = choice;
    conflict.resolvedAt = Utils.now();
    await DB.put(db, 'sync_conflicts', conflict);

    // 清除基线快照
    await DB.removeBaseSnapshot(conflict.entityId);

    if (conflict.entityType === 'patients') {
      await DB.savePatient(resolvedData);
    } else if (conflict.entityType === 'visits') {
      await DB.saveVisit(resolvedData);
    }
  }

  // 获取同步状态摘要
  async function getStatus() {
    const queue = await DB.getSyncQueue();
    const conflicts = await DB.getUnresolvedConflicts();
    const lastSync = await DB.getSetting('lastSyncTime');
    const pending = queue.filter(q => !q.lastError).length;
    const failed = queue.filter(q => q.lastError).length;

    return {
      syncing: _syncing,
      pending,
      failed,
      conflicts: conflicts.length,
      lastSync: lastSync,
      online: navigator.onLine,
      currentBatch: _currentBatch
    };
  }

  // --- 三方合并核心 ---

  // 三方 diff：对比 base/local/remote，返回每个字段的变更情况
  function diffThreeWay(base, local, remote) {
    const result = [];
    const allKeys = new Set([
      ...Object.keys(base || {}),
      ...Object.keys(local || {}),
      ...Object.keys(remote || {})
    ]);

    for (const key of allKeys) {
      if (key.startsWith('_') || INTERNAL_FIELDS.has(key)) continue;

      const baseVal = base ? base[key] : undefined;
      const localVal = local ? local[key] : undefined;
      const remoteVal = remote ? remote[key] : undefined;

      const baseStr = JSON.stringify(baseVal);
      const localStr = JSON.stringify(localVal);
      const remoteStr = JSON.stringify(remoteVal);

      const localChanged = localStr !== baseStr;
      const remoteChanged = remoteStr !== baseStr;

      if (!localChanged && !remoteChanged) continue; // 无变更

      let status;
      if (localChanged && remoteChanged) {
        status = localStr === remoteStr ? 'both_same' : 'conflict';
      } else if (localChanged) {
        status = 'local_only';
      } else {
        status = 'remote_only';
      }

      result.push({
        field: key,
        baseValue: baseVal,
        localValue: localVal,
        remoteValue: remoteVal,
        localChanged,
        remoteChanged,
        status // 'local_only' | 'remote_only' | 'both_same' | 'conflict'
      });
    }

    return result;
  }

  // 两方 diff（向后兼容，无 base 时使用）
  function diffObjects(local, remote) {
    const diffs = [];
    const allKeys = new Set([...Object.keys(local || {}), ...Object.keys(remote || {})]);

    for (const key of allKeys) {
      if (key.startsWith('_') || INTERNAL_FIELDS.has(key)) continue;
      const localVal = local ? local[key] : undefined;
      const remoteVal = remote ? remote[key] : undefined;

      if (JSON.stringify(localVal) !== JSON.stringify(remoteVal)) {
        diffs.push({
          field: key,
          localValue: localVal,
          remoteValue: remoteVal
        });
      }
    }
    return diffs;
  }

  // 三方自动合并
  // 返回 { merged, autoResolved, conflicts, templateConflict }
  function threeWayMerge(base, local, remote, options) {
    options = options || {};
    const diffs = diffThreeWay(base, local, remote);
    const merged = { ...(remote || {}) }; // 以远程为基础
    const autoResolved = [];
    const conflicts = [];
    let templateConflict = false;

    // 检测模板版本不一致
    if (options.checkTemplateVersion) {
      const localTV = local && local.templateVersion;
      const remoteTV = remote && remote.templateVersion;
      if (localTV && remoteTV && localTV !== remoteTV) {
        templateConflict = true;
      }
    }

    for (const diff of diffs) {
      // 问卷答案字段在模板版本不一致时必须人工处理
      if (templateConflict && diff.field === 'questionnaireAnswers') {
        conflicts.push(diff);
        continue;
      }

      // 附件字段需要特殊合并
      if (diff.field === 'attachments') {
        const attachResult = Attachments.mergeAttachments(
          diff.baseValue, diff.localValue, diff.remoteValue
        );
        if (attachResult.conflicts.length > 0) {
          conflicts.push({
            ...diff,
            attachmentConflicts: attachResult.conflicts
          });
        } else {
          merged.attachments = attachResult.merged;
          autoResolved.push({ field: 'attachments', source: 'three_way_merge' });
        }
        continue;
      }

      switch (diff.status) {
        case 'local_only':
          // 仅本地改了 → 取本地
          merged[diff.field] = diff.localValue;
          autoResolved.push({ field: diff.field, source: 'local' });
          break;
        case 'remote_only':
          // 仅远程改了 → 取远程（已在 merged 中）
          autoResolved.push({ field: diff.field, source: 'remote' });
          break;
        case 'both_same':
          // 两端改成了相同的值
          autoResolved.push({ field: diff.field, source: 'both_same' });
          break;
        case 'conflict':
          // 真正的冲突 → 加入冲突列表
          conflicts.push(diff);
          break;
      }
    }

    // 提醒相关字段特殊处理：保留更合理的值，防止重复推进
    if (merged.date && local && remote && base) {
      const localDateChanged = local.date !== base.date;
      const remoteDateChanged = remote.date !== base.date;
      if (localDateChanged && remoteDateChanged && local.date !== remote.date) {
        // 日期冲突：标记，不自动取任一方
        if (!conflicts.find(c => c.field === 'date')) {
          conflicts.push({
            field: 'date',
            baseValue: base.date,
            localValue: local.date,
            remoteValue: remote.date,
            status: 'conflict',
            localChanged: true,
            remoteChanged: true
          });
        }
      }
    }

    return { merged, autoResolved, conflicts, templateConflict };
  }

  // 简单二方合并（向后兼容，无 base 时使用）
  function autoMerge(local, remote) {
    const merged = { ...remote };
    for (const key of Object.keys(local || {})) {
      if (key.startsWith('_') || INTERNAL_FIELDS.has(key)) continue;
      if (local[key] !== null && local[key] !== undefined && local[key] !== '' &&
          (remote[key] === null || remote[key] === undefined || remote[key] === '')) {
        merged[key] = local[key];
      }
    }
    if (local && remote) {
      if (new Date(local.updatedAt || 0) > new Date(remote.updatedAt || 0)) {
        merged.updatedAt = local.updatedAt;
      }
    }
    return merged;
  }

  // 尝试自动合并冲突（有 base 时使用三方，无 base 时降级为二方）
  function tryAutoMerge(conflict) {
    const { baseData, localData, remoteData, templateVersionMismatch } = conflict;

    // 模板版本不一致时不允许自动合并
    if (templateVersionMismatch) {
      return {
        success: false,
        reason: '模板版本不一致，需要人工处理',
        conflicts: diffObjects(localData, remoteData)
      };
    }

    if (baseData) {
      // 有基线 → 三方合并
      const result = threeWayMerge(baseData, localData, remoteData, {
        checkTemplateVersion: conflict.entityType === 'visits'
      });

      if (result.conflicts.length === 0) {
        return {
          success: true,
          merged: result.merged,
          autoResolved: result.autoResolved
        };
      } else {
        return {
          success: false,
          reason: `有 ${result.conflicts.length} 个字段冲突`,
          merged: result.merged, // 部分合并结果
          conflicts: result.conflicts,
          autoResolved: result.autoResolved
        };
      }
    } else {
      // 无基线 → 降级为二方合并
      return {
        success: true,
        merged: autoMerge(localData, remoteData),
        autoResolved: [],
        degraded: true
      };
    }
  }

  return {
    addListener, removeListener, startAutoSync, stopAutoSync,
    syncAll, abort, resolveConflict, getStatus,
    diffObjects, diffThreeWay, threeWayMerge, autoMerge, tryAutoMerge,
    isSyncing: () => _syncing
  };
})();
