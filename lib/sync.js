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

  /**
   * 三层级冲突合并：患者层级、问卷层级、附件层级
   * @param {Object} base - 基础快照
   * @param {Object} local - 本地数据
   * @param {Object} remote - 远程数据
   * @param {string} entityType - 实体类型
   * @returns {{ merged, conflicts, autoMerged, levelDetails }}
   */
  function threeLevelMerge(base, local, remote, entityType) {
    const result = threeWayMerge(base, local, remote);
    const levelDetails = { patient: [], questionnaire: [], attachment: [] };

    if (entityType !== 'visits') {
      // 患者层级：标准字段合并已经足够
      levelDetails.patient = result.autoMerged.map(a => ({
        field: a.field, choice: a.choice, level: 'patient'
      }));
      return { ...result, levelDetails };
    }

    // === 问卷层级合并 ===
    if (local?.questionnaires || remote?.questionnaires) {
      const baseQ = (base?.questionnaires || []);
      const localQ = (local?.questionnaires || []);
      const remoteQ = (remote?.questionnaires || []);

      const mergedQuestionnaires = _mergeQuestionnaireArrays(baseQ, localQ, remoteQ, levelDetails);
      result.merged.questionnaires = mergedQuestionnaires;
    }

    // === 附件层级合并 ===
    if (local?.attachments || remote?.attachments) {
      const baseA = (base?.attachments || []);
      const localA = (local?.attachments || []);
      const remoteA = (remote?.attachments || []);

      const mergedAttachments = _mergeAttachmentArrays(baseA, localA, remoteA, levelDetails);
      result.merged.attachments = mergedAttachments;
    }

    // 标记普通字段层级
    result.autoMerged.forEach(a => {
      if (a.field !== 'questionnaires' && a.field !== 'attachments') {
        levelDetails.patient.push({ field: a.field, choice: a.choice, level: 'patient' });
      }
    });

    return { ...result, levelDetails };
  }

  /**
   * 合并问卷数组 - 按 templateId 匹配
   */
  function _mergeQuestionnaireArrays(baseQ, localQ, remoteQ, levelDetails) {
    const merged = [];
    const allIds = new Set();

    localQ.forEach(q => allIds.add(q.templateId));
    remoteQ.forEach(q => allIds.add(q.templateId));

    for (const tid of allIds) {
      const baseItem = baseQ.find(q => q.templateId === tid);
      const localItem = localQ.find(q => q.templateId === tid);
      const remoteItem = remoteQ.find(q => q.templateId === tid);

      if (localItem && remoteItem) {
        // 双方都有此问卷 - 合并答案
        const baseAnswers = baseItem ? baseItem.answers : {};
        const localAnswers = localItem.answers || {};
        const remoteAnswers = remoteItem.answers || {};
        const answerMerge = threeWayMerge(baseAnswers, localAnswers, remoteAnswers);

        // 使用更高版本
        const version = Math.max(localItem.version || 0, remoteItem.version || 0);

        merged.push({
          templateId: tid,
          templateName: localItem.templateName || remoteItem.templateName,
          version: version,
          diseaseType: localItem.diseaseType || remoteItem.diseaseType,
          answers: answerMerge.merged,
          completedAt: new Date(localItem.completedAt || 0) > new Date(remoteItem.completedAt || 0)
            ? localItem.completedAt : remoteItem.completedAt,
          _mergeConflicts: answerMerge.conflicts.length
        });

        if (answerMerge.conflicts.length > 0) {
          levelDetails.questionnaire.push({
            templateId: tid,
            conflicts: answerMerge.conflicts,
            level: 'questionnaire'
          });
        } else {
          levelDetails.questionnaire.push({
            templateId: tid,
            autoMerged: answerMerge.autoMerged.length,
            level: 'questionnaire'
          });
        }
      } else if (localItem) {
        // 仅本地有此问卷
        merged.push(localItem);
        levelDetails.questionnaire.push({ templateId: tid, choice: 'local', level: 'questionnaire' });
      } else if (remoteItem) {
        // 仅远程有此问卷
        merged.push(remoteItem);
        levelDetails.questionnaire.push({ templateId: tid, choice: 'remote', level: 'questionnaire' });
      }
    }

    return merged;
  }

  /**
   * 合并附件数组 - 按 attachment id 匹配
   */
  function _mergeAttachmentArrays(baseA, localA, remoteA, levelDetails) {
    const merged = [];
    const allIds = new Set();

    localA.forEach(a => { if (a.id) allIds.add(a.id); });
    remoteA.forEach(a => { if (a.id) allIds.add(a.id); });

    for (const aid of allIds) {
      const baseItem = baseA.find(a => a.id === aid);
      const localItem = localA.find(a => a.id === aid);
      const remoteItem = remoteA.find(a => a.id === aid);

      if (localItem && remoteItem) {
        // 双方都有 - 取最新上传状态的
        if (localItem.uploadStatus === 'uploaded' && remoteItem.uploadStatus !== 'uploaded') {
          merged.push(localItem);
        } else if (remoteItem.uploadStatus === 'uploaded') {
          merged.push(remoteItem);
        } else {
          // 都未上传，取压缩率更高的
          const localSize = localItem.compressedSize || Infinity;
          const remoteSize = remoteItem.compressedSize || Infinity;
          merged.push(localSize <= remoteSize ? localItem : remoteItem);
        }
        levelDetails.attachment.push({ id: aid, choice: 'merged', level: 'attachment' });
      } else if (localItem) {
        merged.push(localItem);
        levelDetails.attachment.push({ id: aid, choice: 'local', level: 'attachment' });
      } else if (remoteItem) {
        merged.push(remoteItem);
        levelDetails.attachment.push({ id: aid, choice: 'remote', level: 'attachment' });
      }
    }

    return merged;
  }

  async function _handleConflict(item, error) {
    // 从 IndexedDB 重新读取最新本地数据，而非使用 sync queue 中过时的 payload
    const db = await DB.open();
    let localData;
    const freshLocal = await DB.get(db, item.entityType, item.entityId);
    if (freshLocal) {
      localData = freshLocal;
    } else {
      // 回退到 sync queue payload
      localData = item.payload;
      if (localData && localData._encrypted && CryptoManager.isReady()) {
        try {
          localData = JSON.parse(await CryptoManager.decrypt(localData._encrypted));
        } catch { /* keep as is */ }
      }
    }

    const remoteData = error.remoteData;
    const remoteVersion = error.remoteVersion;

    // 从最新本地记录获取基础快照（而非 sync queue 的旧 payload）
    const baseSnapshot = localData?._baseSnapshot || error.remoteBaseSnapshot || null;

    // 执行三方合并（三层级）
    let mergeResult;
    if (item.entityType === 'visits') {
      mergeResult = threeLevelMerge(baseSnapshot, localData, remoteData, item.entityType);
    } else {
      mergeResult = threeWayMerge(baseSnapshot, localData, remoteData);
      mergeResult.levelDetails = { patient: mergeResult.autoMerged.map(a => ({
        field: a.field, choice: a.choice, level: 'patient'
      })), questionnaire: [], attachment: [] };
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

      // 冲突合并后重排提醒和随访计划
      await _rescheduleAfterMerge(item.entityType, item.entityId, mergeResult.merged);
    } else {
      // 存在无法自动合并的冲突 → 保存冲突记录等待人工处理
      await DB.saveConflict(conflict);
    }
  }

  // 冲突合并后触发提醒和计划重排
  async function _rescheduleAfterMerge(entityType, entityId, mergedData) {
    try {
      if (typeof FollowupPlan !== 'undefined' && FollowupPlan.rescheduleAfterMerge) {
        await FollowupPlan.rescheduleAfterMerge(entityType, entityId, mergedData);
      } else if (typeof Reminders !== 'undefined' && Reminders.rescheduleAfterMerge) {
        await Reminders.rescheduleAfterMerge(entityType, entityId, mergedData);
      }
    } catch (e) {
      console.error('Reschedule after merge failed:', e);
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

    // 冲突解决后重排提醒和随访计划
    await _rescheduleAfterMerge(conflict.entityType, conflict.entityId, resolvedData);
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
    threeWayMerge, threeWayMergeWithTemplate, threeLevelMerge,
    isSyncing: () => _syncing,
    _getMockServer, _reset, _deepEqual
  };
})();
