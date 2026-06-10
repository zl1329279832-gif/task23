// IndexedDB 封装 - Promise 化 + 加密层集成 + 三方合并基础快照 + 修订号
const DB = (() => {
  const DB_NAME = 'MedicalFollowupDB';
  const DB_VERSION = 2;
  let _db = null;

  const STORES = {
    patients: { keyPath: 'id', indexes: ['name', 'lastVisitDate', 'riskLevel', 'syncStatus'] },
    visits: { keyPath: 'id', indexes: ['patientId', 'date', 'riskLevel', 'isDraft', 'syncStatus'] },
    questionnaire_templates: { keyPath: 'id', indexes: ['diseaseType', 'version'] },
    sync_queue: { keyPath: 'id', indexes: ['entityType', 'entityId', 'priority', 'createdAt'] },
    sync_conflicts: { keyPath: 'id', indexes: ['entityType', 'resolved'] },
    settings: { keyPath: 'key' },
    attachment_queue: { keyPath: 'id', indexes: ['visitId', 'status'] }
  };

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = event => {
        const db = event.target.result;
        for (const [name, config] of Object.entries(STORES)) {
          if (!db.objectStoreNames.contains(name)) {
            const store = db.createObjectStore(name, { keyPath: config.keyPath });
            if (config.indexes) {
              config.indexes.forEach(idx => store.createIndex(idx, idx, { unique: false }));
            }
          }
        }
      };
      request.onsuccess = event => {
        _db = event.target.result;
        _db.onclose = () => { _db = null; };
        resolve(_db);
      };
      request.onerror = event => reject(event.target.error);
    });
  }

  function get(db, storeName, key) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  function put(db, storeName, data) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.put(data);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function deleteRecord(db, storeName, key) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  function getAll(db, storeName) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  function getByIndex(db, storeName, indexName, value) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const index = store.index(indexName);
      const req = index.getAll(value);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  function query(db, storeName, predicate) {
    return getAll(db, storeName).then(items => items.filter(predicate));
  }

  function count(db, storeName) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function clear(db, storeName) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  // --- 创建干净的快照副本（去除内部字段） ---
  function _cleanSnapshot(record) {
    if (!record) return null;
    const snap = {};
    for (const key of Object.keys(record)) {
      if (key.startsWith('_')) continue;
      if (key === 'syncStatus' || key === 'syncVersion') continue;
      snap[key] = JSON.parse(JSON.stringify(record[key]));
    }
    return snap;
  }

  // --- 带加密 + 修订号 + 基础快照的 Patient 操作 ---

  async function savePatient(patient) {
    const db = await open();
    const existing = await get(db, 'patients', patient.id);
    const isNew = !existing;
    if (!patient.id) patient.id = Utils.uuid();
    patient.updatedAt = Utils.now();

    if (isNew) {
      patient.createdAt = Utils.now();
      patient.syncStatus = 'pending';
      patient._rev = 1;
      patient._baseSnapshot = null; // 新建记录无基础快照
    } else {
      // 递增本地修订号
      patient._rev = (existing._rev || 0) + 1;
      // 保留基础快照（上次同步时的状态）
      if (!patient._baseSnapshot && existing._baseSnapshot) {
        patient._baseSnapshot = existing._baseSnapshot;
      }
      // 编辑已同步记录 → 重置为待同步
      if (existing.syncStatus === 'synced') {
        patient.syncStatus = 'pending';
      }
    }

    // Encrypt sensitive fields
    if (patient.idCard && CryptoManager.isReady()) {
      patient._encrypted_idCard = await CryptoManager.encrypt(patient.idCard);
      delete patient.idCard;
    }
    // Compute integrity HMAC
    patient._hmac = await CryptoManager.computeHMAC({
      id: patient.id, name: patient.name, age: patient.age, diseases: patient.diseases
    });

    await put(db, 'patients', patient);

    // Add to sync queue (upsert, no duplicates)
    if (patient.syncStatus !== 'synced') {
      await addToSyncQueue('patients', patient.id, isNew ? 'create' : 'update', patient);
    }
    return patient;
  }

  async function loadPatient(id) {
    const db = await open();
    const patient = await get(db, 'patients', id);
    if (!patient) return null;

    // Verify integrity
    if (patient._hmac && CryptoManager.isReady()) {
      const valid = await CryptoManager.verifyHMAC(
        { id: patient.id, name: patient.name, age: patient.age, diseases: patient.diseases },
        patient._hmac
      );
      if (!valid) {
        patient._dataCorrupted = true;
        Utils.showToast(`患者 ${patient.name || ''} 数据可能已损坏`, 'warning');
      }
    }

    // Decrypt sensitive fields
    if (patient._encrypted_idCard && CryptoManager.isReady()) {
      try {
        patient.idCard = await CryptoManager.decrypt(patient._encrypted_idCard);
      } catch {
        patient.idCard = '***解密失败***';
      }
    }
    return patient;
  }

  async function loadAllPatients() {
    const db = await open();
    const patients = await getAll(db, 'patients');
    for (const p of patients) {
      if (p._encrypted_idCard && CryptoManager.isReady()) {
        try { p.idCard = await CryptoManager.decrypt(p._encrypted_idCard); } catch { p.idCard = '***'; }
      }
    }
    return patients;
  }

  // --- 带加密 + 修订号 + 模板版本的 Visit 操作 ---

  async function saveVisit(visit) {
    const db = await open();
    const existing = await get(db, 'visits', visit.id);
    const isNew = !existing;
    if (!visit.id) visit.id = Utils.uuid();
    visit.updatedAt = Utils.now();

    if (isNew) {
      visit.createdAt = Utils.now();
      visit.syncStatus = 'pending';
      visit.syncVersion = 0;
      visit._rev = 1;
      visit._baseSnapshot = null;
    } else {
      visit._rev = (existing._rev || 0) + 1;
      if (!visit._baseSnapshot && existing._baseSnapshot) {
        visit._baseSnapshot = existing._baseSnapshot;
      }
      // 编辑已同步记录 → 重置为待同步
      if (existing.syncStatus === 'synced') {
        visit.syncStatus = 'pending';
      }
    }

    // 追踪问卷模板版本
    if (visit.questionnaires && visit.questionnaires.length > 0) {
      visit._templateVersions = visit.questionnaires.map(q => ({
        templateId: q.templateId,
        version: q.version,
        diseaseType: q.diseaseType
      }));
    }

    visit._hmac = await CryptoManager.computeHMAC({
      id: visit.id, patientId: visit.patientId, date: visit.date
    });

    await put(db, 'visits', visit);

    if (visit.syncStatus !== 'synced') {
      await addToSyncQueue('visits', visit.id, isNew ? 'create' : 'update', visit);
    }
    return visit;
  }

  async function loadVisit(id) {
    const db = await open();
    const visit = await get(db, 'visits', id);
    if (!visit) return null;

    if (visit._hmac && CryptoManager.isReady()) {
      const valid = await CryptoManager.verifyHMAC(
        { id: visit.id, patientId: visit.patientId, date: visit.date },
        visit._hmac
      );
      if (!valid) {
        visit._dataCorrupted = true;
        Utils.showToast('随访记录数据可能已损坏', 'warning');
      }
    }
    return visit;
  }

  async function loadVisitsByPatient(patientId) {
    const db = await open();
    return getByIndex(db, 'visits', 'patientId', patientId);
  }

  // --- 同步队列操作（去重 upsert） ---

  async function addToSyncQueue(entityType, entityId, action, payload) {
    const db = await open();
    const priority = action === 'create' ? 1 : 2;

    // 去重：检查是否已有该实体的队列项
    const existingItems = await getByIndex(db, 'sync_queue', 'entityId', entityId);
    const existingForEntity = existingItems.filter(
      item => item.entityType === entityType && item.entityId === entityId
    );

    let encryptedPayload = payload;
    if (CryptoManager.isReady() && typeof payload === 'object') {
      try {
        const plain = JSON.stringify(payload);
        const encrypted = await CryptoManager.encrypt(plain);
        encryptedPayload = { _encrypted: encrypted };
      } catch { /* store unencrypted as fallback */ }
    }

    if (existingForEntity.length > 0) {
      // 更新现有队列项（合并操作，保留最早的 action）
      const existing = existingForEntity[0];
      existing.payload = encryptedPayload;
      existing.updatedAt = Utils.now();
      existing.retryCount = 0;
      existing.lastError = null;
      // 如果原来是 create 保持 create，否则更新为最新 action
      if (existing.action !== 'create') {
        existing.action = action;
      }
      await put(db, 'sync_queue', existing);

      // 删除多余重复项
      for (let i = 1; i < existingForEntity.length; i++) {
        await deleteRecord(db, 'sync_queue', existingForEntity[i].id);
      }
      return existing;
    }

    const item = {
      id: Utils.uuid(),
      entityType,
      entityId,
      action,
      payload: encryptedPayload,
      retryCount: 0,
      lastError: null,
      createdAt: Utils.now(),
      updatedAt: Utils.now(),
      priority,
      idempotencyKey: `${entityType}:${entityId}:${Utils.now()}:${Math.random().toString(36).slice(2, 8)}`
    };
    await put(db, 'sync_queue', item);
    return item;
  }

  async function getSyncQueue() {
    const db = await open();
    const items = await getAll(db, 'sync_queue');
    items.sort((a, b) => a.priority - b.priority || new Date(a.createdAt) - new Date(b.createdAt));
    return items;
  }

  async function removeSyncQueueItem(id) {
    const db = await open();
    await deleteRecord(db, 'sync_queue', id);
  }

  // --- 冲突操作 ---

  async function saveConflict(conflict) {
    const db = await open();
    if (!conflict.id) conflict.id = Utils.uuid();
    conflict.createdAt = Utils.now();
    await put(db, 'sync_conflicts', conflict);
    return conflict;
  }

  async function getUnresolvedConflicts() {
    const db = await open();
    return query(db, 'sync_conflicts', c => !c.resolved);
  }

  // --- 模板操作 ---

  async function saveTemplate(template) {
    const db = await open();
    await put(db, 'questionnaire_templates', template);
    return template;
  }

  async function getTemplatesByDisease(diseaseType) {
    const db = await open();
    return getByIndex(db, 'questionnaire_templates', 'diseaseType', diseaseType);
  }

  async function getAllTemplates() {
    const db = await open();
    return getAll(db, 'questionnaire_templates');
  }

  // --- 设置操作 ---

  async function getSetting(key) {
    const db = await open();
    const s = await get(db, 'settings', key);
    return s ? s.value : null;
  }

  async function setSetting(key, value) {
    const db = await open();
    await put(db, 'settings', { key, value });
  }

  // --- 草稿操作 ---

  async function saveDraft(type, data) {
    const db = await open();
    const key = `draft_${type}_${data.patientId || 'new'}`;
    await put(db, 'settings', { key, value: JSON.stringify(data), savedAt: Utils.now() });
  }

  async function loadDraft(type, patientId) {
    const db = await open();
    const key = `draft_${type}_${patientId || 'new'}`;
    const s = await get(db, 'settings', key);
    if (!s) return null;
    try { return JSON.parse(s.value); } catch { return null; }
  }

  async function clearDraft(type, patientId) {
    const db = await open();
    const key = `draft_${type}_${patientId || 'new'}`;
    await deleteRecord(db, 'settings', key);
  }

  // --- 附件上传队列 ---

  async function addToAttachmentQueue(attachment) {
    const db = await open();
    const item = {
      id: attachment.id || Utils.uuid(),
      visitId: attachment.visitId,
      attachmentId: attachment.id,
      data: attachment.data,
      thumbnail: attachment.thumbnail,
      name: attachment.name,
      compressionState: attachment.compressionState || 'compressed',
      status: 'pending', // pending | uploading | uploaded | failed
      retryCount: 0,
      lastError: null,
      createdAt: Utils.now()
    };
    await put(db, 'attachment_queue', item);
    return item;
  }

  async function getAttachmentQueue() {
    const db = await open();
    const items = await getAll(db, 'attachment_queue');
    return items.filter(i => i.status !== 'uploaded').sort(
      (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
    );
  }

  async function updateAttachmentQueueItem(id, updates) {
    const db = await open();
    const item = await get(db, 'attachment_queue', id);
    if (!item) return null;
    Object.assign(item, updates);
    await put(db, 'attachment_queue', item);
    return item;
  }

  async function removeAttachmentQueueItem(id) {
    const db = await open();
    await deleteRecord(db, 'attachment_queue', id);
  }

  // --- 统计 ---

  async function getStorageStats() {
    const db = await open();
    const stats = {};
    for (const storeName of Object.keys(STORES)) {
      stats[storeName] = await count(db, storeName);
    }
    return stats;
  }

  // --- 检测重复随访 ---

  async function checkDuplicateVisit(patientId, date) {
    const db = await open();
    const visits = await getByIndex(db, 'visits', 'patientId', patientId);
    return visits.filter(v => v.date === date && !v.isDraft);
  }

  // --- 同步后更新基础快照 ---

  async function updateBaseSnapshot(entityType, entityId, serverVersion) {
    const db = await open();
    const record = await get(db, entityType, entityId);
    if (!record) return;

    record.syncStatus = 'synced';
    record.syncVersion = serverVersion;
    // 更新基础快照为当前状态
    record._baseSnapshot = _cleanSnapshot(record);
    await put(db, entityType, record);
  }

  // --- 直接写入已解决的数据（跳过队列） ---

  async function putResolved(entityType, record) {
    const db = await open();
    await put(db, entityType, record);
  }

  return {
    open, get, put, deleteRecord, getAll, getByIndex, query, count, clear,
    savePatient, loadPatient, loadAllPatients,
    saveVisit, loadVisit, loadVisitsByPatient,
    addToSyncQueue, getSyncQueue, removeSyncQueueItem,
    saveConflict, getUnresolvedConflicts,
    saveTemplate, getTemplatesByDisease, getAllTemplates,
    getSetting, setSetting,
    saveDraft, loadDraft, clearDraft,
    addToAttachmentQueue, getAttachmentQueue, updateAttachmentQueueItem, removeAttachmentQueueItem,
    getStorageStats, checkDuplicateVisit,
    updateBaseSnapshot, putResolved,
    _cleanSnapshot
  };
})();
