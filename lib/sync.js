// 同步系统 - 三方合并、队列管理、重试、冲突检测、幂等性
const SyncManager = (() => {
  let _syncing = false;
  let _currentBatch = 0;
  let _aborted = false;
  let _listeners = [];
  let _processedIdempotencyKeys = new Set(); // 防止重复同步请求
  const BATCH_SIZE = 10;
  const MAX_RETRIES = 5;
  const BASE_DELAY = 1000;
  const MAX_DELAY = 60000;
  const CHECK_INTERVAL = 30000;
  let _intervalId = null;

  // 模拟远程服务器
  const _mockServer = {
    data: {},
    _processedKeys: new Set(), // 幂等性去重
    delay: () => new Promise(r => setTimeout(r, 200 + Math.random() * 800)),

    async push(entityType, entityId, payload, localVersion, idempotencyKey) {
      await this.delay();

      // 幂等性检查：相同 key 直接返回上次结果
      if (idempotencyKey && this._processedKeys.has(idempotencyKey)) {
        const key = `${entityType}:${entityId}`;
        const existing = this.data[key];
        return { success: true, version: existing ? existing.version : localVersion, idempotent: true };
      }

      // 模拟网络失败 (10% 概率)
      if (Math.random() < 0.1) {
        throw new Error('网络请求失败');
      }

      const key = `${entityType}:${entityId}`;
      const existing = this.data[key];

      // 模拟冲突 (如果远程版本比本地基线新)
      if (existing && existing.version > localVersion) {
        const error = new Error('CONFLICT');
        error.remoteData = existing.payload;
        error.remoteVersion = existing.version;
        error.remoteBaseSnapshot = existing.baseSnapshot || null;
        throw error;
      }

      // 存储到模拟服务器
      const newVersion = (existing ? existing.version : 0) + 1;
      this.data[key] = {
        payload: payload,
        version: newVersion,
        baseSnapshot: payload, // 同步后当前状态成为新的 base
        updatedAt: new Date().toISOString()
      };

      if (idempotencyKey) {
        this._processedKeys.add(idempotencyKey);
      }

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

  // 启动周期性同步检查
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

  // ==================== 三方合并核心算法 ====================

  /**
   * 三方合并 (Three-way merge)
   *
   * @param {Object} base   - 基础版本（上次同步时的状态，_baseSnapshot）
   * @param {Object} local  - 本地版本（离线编辑后的状态）
   * @param {Object} remote - 远程版本（服务器上的状态）
   * @returns {{ merged: Object, conflicts: Array, autoMerged: Array }}
   */
  function threeWayMerge(base, local, remote) {
    const merged = {};
    const conflicts = [];
    const autoMerged = [];

    // 收集所有字段
    const allKeys = new Set();
    if (base) Object.keys(base).forEach(k => allKeys.add(k));
    if (local) Object.keys(local).forEach(k => allKeys.add(k));
    if (remote) Object.keys(remote).forEach(k => allKeys.add(k));

    for (const key of allKeys) {
      // 跳过内部字段
      if (key.startsWith('_')) continue;
      if (key === 'syncStatus' || key === 'syncVersion') continue;

      const baseVal = base ? base[key] : undefined;
      const localVal = local ? local[key] : undefined;
      const remoteVal = remote ? remote[key] : undefined;

      const localChanged = !_deepEqual(localVal, baseVal);
      const remoteChanged = !_deepEqual(remoteVal, baseVal);

      if (localChanged && remoteChanged) {
        // 双方都修改了 → 冲突
        if (_deepEqual(localVal, remoteVal)) {
          // 双方做了相同修改 → 自动合并
          merged[key] = localVal;
          autoMerged.push({ field: key, choice: 'same-change' });
        } else {
          // 真正的冲突 → 需要人工处理
          conflicts.push({
            field: key,
            baseValue: baseVal,
            localValue: localVal,
            remoteValue: remoteVal,
            localRev: local?._rev || 0,
            remoteVersion: remote?.syncVersion || 0
          });
          // 默认使用远程值（可被人工覆盖）
          merged[key] = remoteVal;
        }
      } else if (localChanged) {
        // 仅本地修改 → 保留本地
        merged[key] = localVal;
        autoMerged.push({ field: key, choice: 'local' });
      } else if (remoteChanged) {
        // 仅远程修改 → 保留远程
        merged[key] = remoteVal;
        autoMerged.push({ field: key, choice: 'remote' });
      } else {
        // 双方都未修改 → 保持 base 值
        merged[key] = baseVal !== undefined ? baseVal : (localVal !== undefined ? localVal : remoteVal);
      }
    }

    return { merged, conflicts, autoMerged };
  }

  /**
   * 带模板版本的三方合并（问卷数据专用）
   */
  function threeWayMergeWithTemplate(base, local, remote, templateInfo) {
    // 先做普通三方合并
    const result = threeWayMerge(base, local, remote);

    // 额外检查模板版本一致性
    if (templateInfo) {
      const localVersions = local?._templateVersions || [];
      const remoteVersions = remote?._templateVersions || [];

      for (const lv of localVersions) {
        const rv = remoteVersions.find(r => r.templateId === lv.templateId);
        if (rv && lv.version !== rv.version) {
          result.conflicts.push({
            field: `_templateVersion_${lv.templateId}`,
            baseValue: templateInfo.baseVersion,
            localValue: lv.version,
            remoteValue: rv.version,
            type: 'template_version_conflict',
            templateId: lv.templateId,
            diseaseType: lv.diseaseType
          });
        }
      }
    }

    return result;
  }

  /**
   * 三层冲突合并（患者 + 问卷 + 附件）
   * 按层级分别处理合并逻辑，保留本地补访链路和服务端最新计划
   */
  function threeWayMergeMultiLevel(base, local, remote, entityType) {
    if (entityType !== 'visits') {
      return threeWayMerge(base, local, remote);
    }

    // === 第一层：患者基础数据（非问卷、非附件字段） ===
    const baseCore = _extractCoreFields(base);
    const localCore = _extractCoreFields(local);
    const remoteCore = _extractCoreFields(remote);
    const coreResult = threeWayMerge(baseCore, localCore, remoteCore);

    // === 第二层：问卷数据合并 ===
    const qResult = _mergeQuestionnaires(
      base ? base.questionnaires : null,
      local ? local.questionnaires : null,
      remote ? remote.questionnaires : null
    );

    // === 第三层：附件数据合并 ===
    const attResult = _mergeAttachments(
      base ? base.attachments : null,
      local ? local.attachments : null,
      remote ? remote.attachments : null
    );

    // 合并三层结果
    const merged = {
      ...coreResult.merged,
      questionnaires: qResult.merged,
      attachments: attResult.merged
    };

    const conflicts = [
      ...coreResult.conflicts,
      ...qResult.conflicts.map(c => ({ ...c, level: 'questionnaire' })),
      ...attResult.conflicts.map(c => ({ ...c, level: 'attachment' }))
    ];

    const autoMerged = [
      ...coreResult.autoMerged,
      ...qResult.autoMerged.map(m => ({ ...m, level: 'questionnaire' })),
      ...attResult.autoMerged.map(m => ({ ...m, level: 'attachment' }))
    ];

    return { merged, conflicts, autoMerged };
  }

  /** 提取核心字段（排除问卷和附件） */
  function _extractCoreFields(obj) {
    if (!obj) return null;
    const core = {};
    for (const key of Object.keys(obj)) {
      if (key === 'questionnaires' || key === 'attachments') continue;
      core[key] = obj[key];
    }
    return core;
  }

  /** 第二层：问卷数据合并 */
  function _mergeQuestionnaires(baseQ, localQ, remoteQ) {
    const result = { merged: [], conflicts: [], autoMerged: [] };

    if (!baseQ && !localQ && !remoteQ) return result;
    if (!baseQ) baseQ = [];
    if (!localQ) localQ = [];
    if (!remoteQ) remoteQ = [];

    const baseMap = new Map((baseQ || []).map(q => [q.templateId, q]));
    const localMap = new Map((localQ || []).map(q => [q.templateId, q]));
    const remoteMap = new Map((remoteQ || []).map(q => [q.templateId, q]));

    const allTemplateIds = new Set([
      ...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()
    ]);

    for (const tId of allTemplateIds) {
      const bq = baseMap.get(tId) || null;
      const lq = localMap.get(tId) || null;
      const rq = remoteMap.get(tId) || null;

      const localChanged = !_deepEqual(lq, bq);
      const remoteChanged = !_deepEqual(rq, bq);

      if (localChanged && remoteChanged) {
        if (_deepEqual(lq, rq)) {
          result.merged.push(lq);
          result.autoMerged.push({ field: `questionnaire_${tId}`, choice: 'same-change' });
        } else if (lq && rq && lq.version !== rq.version) {
          // 模板版本不同：优先远程新版本，但保留本地答案中的匹配项
          const mergedQ = { ...rq };
          if (lq.answers && rq.answers) {
            mergedQ.answers = { ...rq.answers };
            for (const [key, val] of Object.entries(lq.answers)) {
              if (mergedQ.answers[key] === undefined || mergedQ.answers[key] === null || mergedQ.answers[key] === '') {
                mergedQ.answers[key] = val;
              }
            }
          }
          result.merged.push(mergedQ);
          result.autoMerged.push({ field: `questionnaire_${tId}`, choice: 'merged-template-upgrade' });
        } else {
          // 同版本双方修改答案 → 冲突
          result.conflicts.push({
            field: `questionnaire_${tId}`,
            baseValue: bq,
            localValue: lq,
            remoteValue: rq,
            type: 'questionnaire_conflict'
          });
          result.merged.push(rq); // 默认远程
        }
      } else if (localChanged) {
        result.merged.push(lq);
        result.autoMerged.push({ field: `questionnaire_${tId}`, choice: 'local' });
      } else if (remoteChanged) {
        result.merged.push(rq);
        result.autoMerged.push({ field: `questionnaire_${tId}`, choice: 'remote' });
      } else {
        result.merged.push(bq || lq || rq);
      }
    }

    return result;
  }

  /** 第三层：附件数据合并 */
  function _mergeAttachments(baseAtt, localAtt, remoteAtt) {
    const result = { merged: [], conflicts: [], autoMerged: [] };

    if (!baseAtt) baseAtt = [];
    if (!localAtt) localAtt = [];
    if (!remoteAtt) remoteAtt = [];

    const baseMap = new Map(baseAtt.map(a => [a.id, a]));
    const localMap = new Map(localAtt.map(a => [a.id, a]));
    const remoteMap = new Map(remoteAtt.map(a => [a.id, a]));

    const allIds = new Set([
      ...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()
    ]);

    for (const id of allIds) {
      const ba = baseMap.get(id) || null;
      const la = localMap.get(id) || null;
      const ra = remoteMap.get(id) || null;

      if (!ba) {
        // 新增附件
        if (la && ra) {
          // 双方都新增同ID（极少见），合并元数据优先远程上传状态
          const merged = { ...la };
          if (ra.uploadStatus === 'uploaded' || ra.compressionState === 'uploaded') {
            merged.uploadStatus = ra.uploadStatus;
            merged.compressionState = ra.compressionState;
            merged.serverUrl = ra.serverUrl;
          }
          result.merged.push(merged);
          result.autoMerged.push({ field: `attachment_${id}`, choice: 'merged' });
        } else {
          result.merged.push(la || ra);
          result.autoMerged.push({ field: `attachment_${id}`, choice: la ? 'local-new' : 'remote-new' });
        }
      } else if (!la && !ra) {
        // 双方都删除 → 不保留
      } else if (!la) {
        // 本地删除，远程保留
        if (!_deepEqual(ra, ba)) {
          // 远程有修改 → 冲突
          result.conflicts.push({
            field: `attachment_${id}`,
            baseValue: ba, localValue: null, remoteValue: ra,
            type: 'attachment_delete_conflict'
          });
          result.merged.push(ra);
        }
        // 远程未修改 → 本地删除生效
      } else if (!ra) {
        // 远程删除，本地保留
        if (!_deepEqual(la, ba)) {
          result.conflicts.push({
            field: `attachment_${id}`,
            baseValue: ba, localValue: la, remoteValue: null,
            type: 'attachment_delete_conflict'
          });
          result.merged.push(la);
        }
      } else {
        // 双方都有
        const localChanged = !_deepEqual(la, ba);
        const remoteChanged = !_deepEqual(ra, ba);

        if (localChanged && remoteChanged) {
          // 合并：保留本地数据但采纳远程上传状态
          const merged = { ...la };
          if (ra.uploadStatus === 'uploaded' || ra.compressionState === 'uploaded') {
            merged.uploadStatus = ra.uploadStatus;
            merged.compressionState = ra.compressionState;
            merged.serverUrl = ra.serverUrl;
            merged.uploadedAt = ra.uploadedAt;
          }
          result.merged.push(merged);
          result.autoMerged.push({ field: `attachment_${id}`, choice: 'merged-status' });
        } else if (localChanged) {
          result.merged.push(la);
          result.autoMerged.push({ field: `attachment_${id}`, choice: 'local' });
        } else if (remoteChanged) {
          result.merged.push(ra);
          result.autoMerged.push({ field: `attachment_${id}`, choice: 'remote' });
        } else {
          result.merged.push(ba);
        }
      }
    }

    return result;
  }

  /**
   * 深度比较两个值
   */
  function _deepEqual(a, b) {
    if (a === b) return true;
    if (a === null || a === undefined || b === null || b === undefined) return a === b;
    if (typeof a !== typeof b) return false;
    if (typeof a !== 'object') return a === b;
    if (Array.isArray(a) !== Array.isArray(b)) return false;

    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      return a.every((v, i) => _deepEqual(v, b[i]));
    }

    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every(k => _deepEqual(a[k], b[k]));
  }

  // ==================== 主同步流程 ====================

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

      // 按批次处理
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

          // 幂等性检查：本地已处理的 key 直接跳过
          if (item.idempotencyKey && _processedIdempotencyKeys.has(item.idempotencyKey)) {
            synced++;
            await DB.removeSyncQueueItem(item.id);
            continue;
          }

          try {
            await _syncItem(item);
            synced++;
            if (item.idempotencyKey) _processedIdempotencyKeys.add(item.idempotencyKey);
            await DB.removeSyncQueueItem(item.id);
            _notify('item-synced', { itemId: item.id, entityId: item.entityId });
          } catch (err) {
            if (err.message === 'CONFLICT') {
              conflicts++;
              await _handleConflict(item, err);
              await DB.removeSyncQueueItem(item.id);
              _notify('conflict', { itemId: item.id, entityId: item.entityId });
            } else {
              failed++;
              await _handleRetry(item, err.message);
              _notify('item-failed', { itemId: item.id, error: err.message });
            }
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

    // 解密 payload
    if (payload && payload._encrypted && CryptoManager.isReady()) {
      try {
        const decrypted = await CryptoManager.decrypt(payload._encrypted);
        payload = JSON.parse(decrypted);
      } catch {
        throw new Error('数据解密失败');
      }
    }

    // 获取本地版本和基础快照
    const db = await DB.open();
    let localVersion = 0;
    let localRecord = null;
    if (item.entityType === 'patients') {
      localRecord = await DB.get(db, 'patients', item.entityId);
      if (localRecord) localVersion = localRecord.syncVersion || 0;
    } else if (item.entityType === 'visits') {
      localRecord = await DB.get(db, 'visits', item.entityId);
      if (localRecord) localVersion = localRecord.syncVersion || 0;
    }

    const result = await _mockServer.push(
      item.entityType, item.entityId, payload, localVersion,
      item.idempotencyKey
    );

    // 同步成功后：更新基础快照
    if (result.success) {
      await DB.updateBaseSnapshot(item.entityType, item.entityId, result.version);

      // 同步成功后处理附件队列
      if (item.entityType === 'visits' && payload.attachments && payload.attachments.length > 0) {
        await _queueAttachmentsForUpload(item.entityId, payload.attachments);
      }
    }
  }

  // 将附件加入上传队列
  async function _queueAttachmentsForUpload(visitId, attachments) {
    for (const att of attachments) {
      if (att.compressionState !== 'uploaded') {
        await DB.addToAttachmentQueue({
          ...att,
          visitId,
          compressionState: att.compressionState || 'compressed'
        });
      }
    }
  }

  // ==================== 冲突处理（三方合并） ====================

  async function _handleConflict(item, error) {
    let localData = item.payload;
    if (localData && localData._encrypted && CryptoManager.isReady()) {
      try {
        localData = JSON.parse(await CryptoManager.decrypt(localData._encrypted));
      } catch { /* keep as is */ }
    }

    const remoteData = error.remoteData;
    const remoteVersion = error.remoteVersion;

    // 获取基础快照
    const baseSnapshot = localData?._baseSnapshot || error.remoteBaseSnapshot || null;

    // 执行三层冲突合并（患者/问卷/附件分层）
    let mergeResult;
    if (item.entityType === 'visits') {
      mergeResult = threeWayMergeMultiLevel(baseSnapshot, localData, remoteData, 'visits');
    } else {
      mergeResult = threeWayMerge(baseSnapshot, localData, remoteData);
    }

    const hasAutoResolvableConflicts = mergeResult.conflicts.length === 0;

    const conflict = {
      id: Utils.uuid(),
      entityType: item.entityType,
      entityId: item.entityId,
      localData: localData,
      remoteData: remoteData,
      baseData: baseSnapshot,
      localVersion: (localData && localData._rev) || 0,
      remoteVersion: remoteVersion,
      resolved: hasAutoResolvableConflicts, // 无冲突字段则自动解决
      resolvedData: hasAutoResolvableConflicts ? mergeResult.merged : null,
      mergeResult: {
        conflicts: mergeResult.conflicts,
        autoMerged: mergeResult.autoMerged
      },
      createdAt: Utils.now()
    };

    if (hasAutoResolvableConflicts) {
      // 自动合并成功 → 直接保存并推送
      const mergedRecord = {
        ...mergeResult.merged,
        _baseSnapshot: DB._cleanSnapshot(mergeResult.merged),
        syncStatus: 'pending',
        syncVersion: remoteVersion,
        _rev: (localData?._rev || 0) + 1
      };
      await DB.putResolved(item.entityType, mergedRecord);
      // 重新加入同步队列以推送合并结果
      await DB.addToSyncQueue(item.entityType, item.entityId, 'update', mergedRecord);
    } else {
      // 存在无法自动合并的冲突 → 保存冲突记录等待人工处理
      await DB.saveConflict(conflict);
    }
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

    // 指数退避延迟
    const delay = Math.min(BASE_DELAY * Math.pow(2, item.retryCount - 1), MAX_DELAY);
    await new Promise(r => setTimeout(r, delay));

    await DB.put(db, 'sync_queue', item);
  }

  // 中止同步
  function abort() {
    _aborted = true;
    _notify('aborted', {});
  }

  // ==================== 解决冲突 ====================

  async function resolveConflict(conflictId, resolvedData, choice) {
    const db = await DB.open();
    const conflict = await DB.get(db, 'sync_conflicts', conflictId);
    if (!conflict) return;

    conflict.resolved = true;
    conflict.resolvedData = resolvedData;
    conflict.choice = choice; // 'local', 'remote', 'merged', 'field-by-field'
    conflict.resolvedAt = Utils.now();
    await DB.put(db, 'sync_conflicts', conflict);

    // 将解决后的数据写入本地（更新基础快照）
    const record = {
      ...resolvedData,
      _baseSnapshot: DB._cleanSnapshot(resolvedData),
      syncStatus: 'pending',
      syncVersion: conflict.remoteVersion,
      _rev: (resolvedData._rev || conflict.localVersion || 0) + 1
    };

    await DB.putResolved(conflict.entityType, record);

    // 重新加入同步队列推送合并结果
    await DB.addToSyncQueue(conflict.entityType, conflict.entityId, 'update', record);
  }

  // 获取同步状态摘要
  async function getStatus() {
    const db = await DB.open();
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

  // ==================== 差异比对 + 旧版兼容 ====================

  // 比较两个对象，返回差异字段（兼容旧接口）
  function diffObjects(local, remote) {
    const diffs = [];
    const allKeys = new Set([...Object.keys(local || {}), ...Object.keys(remote || {})]);

    for (const key of allKeys) {
      if (key.startsWith('_')) continue;
      if (key === 'syncStatus' || key === 'syncVersion') continue;
      const localVal = local ? local[key] : undefined;
      const remoteVal = remote ? remote[key] : undefined;

      if (!_deepEqual(localVal, remoteVal)) {
        diffs.push({
          field: key,
          localValue: localVal,
          remoteValue: remoteVal
        });
      }
    }
    return diffs;
  }

  /**
   * 带基础版本的差异比对（三方对比）
   */
  function diffObjectsThreeWay(base, local, remote) {
    const diffs = [];
    const allKeys = new Set();
    if (base) Object.keys(base).forEach(k => allKeys.add(k));
    if (local) Object.keys(local).forEach(k => allKeys.add(k));
    if (remote) Object.keys(remote).forEach(k => allKeys.add(k));

    for (const key of allKeys) {
      if (key.startsWith('_')) continue;
      if (key === 'syncStatus' || key === 'syncVersion') continue;

      const baseVal = base ? base[key] : undefined;
      const localVal = local ? local[key] : undefined;
      const remoteVal = remote ? remote[key] : undefined;

      const localChanged = !_deepEqual(localVal, baseVal);
      const remoteChanged = !_deepEqual(remoteVal, baseVal);

      if (localChanged || remoteChanged) {
        diffs.push({
          field: key,
          baseValue: baseVal,
          localValue: localVal,
          remoteValue: remoteVal,
          localChanged,
          remoteChanged,
          conflict: localChanged && remoteChanged && !_deepEqual(localVal, remoteVal)
        });
      }
    }
    return diffs;
  }

  // 旧版合并函数（向后兼容，内部已改用三方合并）
  function autoMerge(local, remote) {
    // 无基础快照时退化为简单合并（优先远程）
    const merged = { ...remote };
    for (const key of Object.keys(local || {})) {
      if (key.startsWith('_')) continue;
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

  // 获取内部 mock 服务器（用于测试）
  function _getMockServer() {
    return _mockServer;
  }

  // 重置状态（用于测试）
  function _reset() {
    _syncing = false;
    _aborted = false;
    _processedIdempotencyKeys.clear();
    _mockServer.data = {};
    _mockServer._processedKeys.clear();
  }

  return {
    addListener, removeListener, startAutoSync, stopAutoSync,
    syncAll, abort, resolveConflict, getStatus,
    diffObjects, diffObjectsThreeWay, autoMerge,
    threeWayMerge, threeWayMergeWithTemplate, threeWayMergeMultiLevel,
    isSyncing: () => _syncing,
    _getMockServer, _reset, _deepEqual,
    _mergeQuestionnaires, _mergeAttachments
  };
})();
