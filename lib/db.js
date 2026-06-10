// IndexedDB 封装 - Promise 化 + 加密层集成 + 修订号 + 基线快照
const DB = (() => {
  const DB_NAME = 'MedicalFollowupDB';
  const DB_VERSION = 2;
  let _db = null;

  const STORES = {
    patients: { keyPath: 'id', indexes: ['name', 'lastVisitDate', 'riskLevel', 'syncStatus'] },
    visits: { keyPath: 'id', indexes: ['patientId', 'date', 'riskLevel', 'isDraft', 'syncStatus'] },
    questionnaire_templates: { keyPath: 'id', indexes: ['diseaseType', 'version'] },
    sync_queue: { keyPath: 'id', indexes: ['entityType', 'priority', 'createdAt', 'entityId'] },
    sync_conflicts: { keyPath: 'id', indexes: ['entityType', 'resolved'] },
    base_snapshots: { keyPath: 'entityId' },
    settings: { keyPath: 'key' }
  };

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = event => {
        const db = event.target.result;
        const tx = event.target.transaction;
        for (const [name, config] of Object.entries(STORES)) {
          let store;
          if (!db.objectStoreNames.contains(name)) {
            store = db.createObjectStore(name, { keyPath: config.keyPath });
          } else {
            store = tx.objectStore(name);
          }
          if (config.indexes) {
            config.indexes.forEach(idx => {
              if (!store.indexNames.contains(idx)) {
                store.createIndex(idx, idx, { unique: false });
              }
            });
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

  // --- 带加密的 Patient 操作 ---

  async function savePatient(patient) {
    const db = await open();
    const existing = await get(db, 'patients', patient.id);
    const isNew = !existing;
    if (!patient.id) patient.id = Utils.uuid();
    patient.updatedAt = Utils.now();
    if (isNew) {
      patient.createdAt = Utils.now();
      patient.syncStatus = 'pending';
      patient.revision = 1;
    } else {
      patient.revision = (existing.revision || 0) + 1;
      // 在首次离线编辑时保存基线快照（用于三方合并）
      if (existing.syncStatus === 'synced' && !await getBaseSnapshot(patient.id)) {
        await saveBaseSnapshot(patient.id, existing);
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

    // Add to sync queue (with dedup)
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

  // --- 带加密的 Visit 操作 ---

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
      visit.revision = 1;
    } else {
      visit.revision = (existing.revision || 0) + 1;
      // 首次离线编辑时保存基线快照
      if (existing.syncStatus === 'synced' && !await getBaseSnapshot(visit.id)) {
        await saveBaseSnapshot(visit.id, existing);
      }
    }

    // HMAC 包含模板版本信息
    visit._hmac = await CryptoManager.computeHMAC({
      id: visit.id, patientId: visit.patientId, date: visit.date,
      templateId: visit.templateId || null,
      templateVersion: visit.templateVersion || null
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
        {
          id: visit.id, patientId: visit.patientId, date: visit.date,
          templateId: visit.templateId || null,
          templateVersion: visit.templateVersion || null
        },
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

  // --- 同步队列操作（带去重） ---

  async function addToSyncQueue(entityType, entityId, action, payload) {
    const db = await open();

    // 去重：如果同一实体已有待同步项，更新 payload 而非重复添加
    const existingItems = await getByIndex(db, 'sync_queue', 'entityId', entityId);
    const pendingItem = existingItems.find(item =>
      item.entityType === entityType && !item.syncStatus
    );

    if (pendingItem) {
      // 更新现有队列项的 payload
      let encryptedPayload = payload;
      if (CryptoManager.isReady() && typeof payload === 'object') {
        try {
          const plain = JSON.stringify(payload);
          const encrypted = await CryptoManager.encrypt(plain);
          encryptedPayload = { _encrypted: encrypted };
        } catch { /* store unencrypted as fallback */ }
      }
      pendingItem.payload = encryptedPayload;
      pendingItem.updatedAt = Utils.now();
      // 保留 create 动作（如果原始是 create，后续编辑仍视为 create）
      if (pendingItem.action === 'create') action = 'create';
      pendingItem.action = action;
      await put(db, 'sync_queue', pendingItem);
      return pendingItem;
    }

    const priority = action === 'create' ? 1 : 2;
    let encryptedPayload = payload;
    if (CryptoManager.isReady() && typeof payload === 'object') {
      try {
        const plain = JSON.stringify(payload);
        const encrypted = await CryptoManager.encrypt(plain);
        encryptedPayload = { _encrypted: encrypted };
      } catch { /* store unencrypted as fallback */ }
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
      priority
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
    return getByIndex(db, 'sync_conflicts', 'resolved', false);
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

  // --- 基线快照操作（三方合并的祖先版本） ---

  async function saveBaseSnapshot(entityId, data) {
    const db = await open();
    const snapshot = {
      entityId,
      data: JSON.parse(JSON.stringify(data)), // deep clone
      savedAt: Utils.now()
    };
    await put(db, 'base_snapshots', snapshot);
    return snapshot;
  }

  async function getBaseSnapshot(entityId) {
    const db = await open();
    const snapshot = await get(db, 'base_snapshots', entityId);
    return snapshot ? snapshot.data : null;
  }

  async function removeBaseSnapshot(entityId) {
    const db = await open();
    await deleteRecord(db, 'base_snapshots', entityId);
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

  return {
    open, get, put, deleteRecord, getAll, getByIndex, query, count, clear,
    savePatient, loadPatient, loadAllPatients,
    saveVisit, loadVisit, loadVisitsByPatient,
    addToSyncQueue, getSyncQueue, removeSyncQueueItem,
    saveConflict, getUnresolvedConflicts,
    saveTemplate, getTemplatesByDisease, getAllTemplates,
    getSetting, setSetting,
    saveDraft, loadDraft, clearDraft,
    saveBaseSnapshot, getBaseSnapshot, removeBaseSnapshot,
    getStorageStats, checkDuplicateVisit
  };
})();
