// 同步系统 - 队列管理、重试、冲突检测、手动合并
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

  // 模拟远程服务器
  const _mockServer = {
    data: {},
    delay: () => new Promise(r => setTimeout(r, 200 + Math.random() * 800)),

    async push(entityType, entityId, payload, localVersion) {
      await this.delay();

      // 模拟网络失败 (10% 概率)
      if (Math.random() < 0.1) {
        throw new Error('网络请求失败');
      }

      const key = `${entityType}:${entityId}`;
      const existing = this.data[key];

      // 模拟冲突 (如果远程版本更新)
      if (existing && existing.version > localVersion) {
        const error = new Error('CONFLICT');
        error.remoteData = existing.payload;
        error.remoteVersion = existing.version;
        throw error;
      }

      // 存储到模拟服务器
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

  // 启动周期性同步检查
  function startAutoSync() {
    if (_intervalId) return;
    _intervalId = setInterval(() => {
      if (navigator.onLine && !_syncing) {
        syncAll();
      }
    }, CHECK_INTERVAL);

    // 监听网络恢复
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

          try {
            await _syncItem(item);
            synced++;
            await DB.removeSyncQueueItem(item.id);
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

    // 获取本地版本
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

    // 更新本地同步状态
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

  // 处理冲突
  async function _handleConflict(item, remoteData, remoteVersion) {
    let localData = item.payload;
    if (localData && localData._encrypted && CryptoManager.isReady()) {
      try {
        localData = JSON.parse(await CryptoManager.decrypt(localData._encrypted));
      } catch { /* keep as is */ }
    }

    const conflict = {
      id: Utils.uuid(),
      entityType: item.entityType,
      entityId: item.entityId,
      localData: localData,
      remoteData: remoteData,
      localVersion: (localData && localData.syncVersion) || 0,
      remoteVersion: remoteVersion,
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

  // 解决冲突
  async function resolveConflict(conflictId, resolvedData, choice) {
    const db = await DB.open();
    const conflict = await DB.get(db, 'sync_conflicts', conflictId);
    if (!conflict) return;

    conflict.resolved = true;
    conflict.resolvedData = resolvedData;
    conflict.choice = choice; // 'local', 'remote', 'merged'
    conflict.resolvedAt = Utils.now();
    await DB.put(db, 'sync_conflicts', conflict);

    // 将解决后的数据保存到本地
    if (conflict.entityType === 'patients') {
      await DB.savePatient(resolvedData);
    } else if (conflict.entityType === 'visits') {
      await DB.saveVisit(resolvedData);
    }
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

  // 比较两个对象，返回差异字段
  function diffObjects(local, remote) {
    const diffs = [];
    const allKeys = new Set([...Object.keys(local || {}), ...Object.keys(remote || {})]);

    for (const key of allKeys) {
      if (key.startsWith('_')) continue; // skip internal fields
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

  // 合并两个版本（取每个字段的最新值）
  function autoMerge(local, remote) {
    const merged = { ...remote };
    // 保留本地非空且更新的字段
    for (const key of Object.keys(local || {})) {
      if (key.startsWith('_')) continue;
      if (local[key] !== null && local[key] !== undefined && local[key] !== '' &&
          (remote[key] === null || remote[key] === undefined || remote[key] === '')) {
        merged[key] = local[key];
      }
    }
    // 使用更新的时间戳
    if (local && remote) {
      if (new Date(local.updatedAt || 0) > new Date(remote.updatedAt || 0)) {
        merged.updatedAt = local.updatedAt;
      }
    }
    return merged;
  }

  return {
    addListener, removeListener, startAutoSync, stopAutoSync,
    syncAll, abort, resolveConflict, getStatus,
    diffObjects, autoMerge,
    isSyncing: () => _syncing
  };
})();
