/**
 * 医疗随访 PWA 综合测试套件
 *
 * 测试场景：
 *   1. 离线新建记录
 *   2. 离线编辑记录
 *   3. 模板升级后同步冲突
 *   4. 附件上传失败重试
 *   5. 重复同步请求幂等性
 *   6. 三方合并算法
 *   7. 提醒日期幂等性
 *   8. 加密存储一致性
 *
 * 运行：node tests/test-runner.js
 */

// ==================== 测试基础设施 ====================

let _testCount = 0;
let _passCount = 0;
let _failCount = 0;
const _failures = [];

function assert(condition, message) {
  _testCount++;
  if (condition) {
    _passCount++;
  } else {
    _failCount++;
    _failures.push(message);
    console.error(`  ✗ FAIL: ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  assert(pass, `${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertDeepEqual(actual, expected, message) {
  assert(_deepEqual(actual, expected), `${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function _deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => _deepEqual(v, b[i]));
  const keysA = Object.keys(a).filter(k => !k.startsWith('_'));
  const keysB = Object.keys(b).filter(k => !k.startsWith('_'));
  if (keysA.length !== keysB.length) return false;
  return keysA.every(k => _deepEqual(a[k], b[k]));
}

function suite(name, fn) {
  console.log(`\n═══ ${name} ═══`);
  fn();
}

async function asyncSuite(name, fn) {
  console.log(`\n═══ ${name} ═══`);
  await fn();
}

function summary() {
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`测试结果: ${_passCount}/${_testCount} 通过, ${_failCount} 失败`);
  if (_failures.length > 0) {
    console.log('\n失败项:');
    _failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  }
  console.log('═'.repeat(50));
  process.exit(_failCount > 0 ? 1 : 0);
}

// ==================== Mock 环境 ====================

// Mock Utils
const Utils = {
  uuid: () => `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  now: () => new Date().toISOString(),
  today: () => new Date().toISOString().slice(0, 10),
  formatDate: (d) => d ? d.slice(0, 10) : '-',
  formatDateTime: (d) => d || '-',
  daysBetween: (d1, d2) => Math.floor((new Date(d2) - new Date(d1)) / 86400000),
  addDays: (dateStr, days) => {
    const d = new Date(dateStr);
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  },
  riskColor: (l) => ({ high: '#e53935', medium: '#fb8c00', low: '#43a047', none: '#9e9e9e' }[l] || '#9e9e9e'),
  riskLabel: (l) => ({ high: '高风险', medium: '中风险', low: '低风险', none: '未评估' }[l] || '未评估'),
  diseaseLabel: (c) => ({
    hypertension: '高血压', diabetes: '糖尿病', copd: '慢阻肺',
    heart_disease: '冠心病', stroke: '脑卒中', mental_illness: '严重精神障碍', tuberculosis: '肺结核'
  }[c] || c),
  debounce: (fn) => fn,
  escapeHTML: (s) => s || '',
  showToast: () => {},
  showModal: async () => true,
  downloadFile: () => {},
  bytesToSize: (b) => `${b} B`
};

// Mock CryptoManager (bypass encryption for testing)
const CryptoManager = {
  _ready: true,
  isReady: () => true,
  encrypt: async (text) => `ENC:${typeof text === 'string' ? text : JSON.stringify(text)}`,
  decrypt: async (enc) => {
    if (typeof enc === 'string' && enc.startsWith('ENC:')) return enc.slice(4);
    return enc;
  },
  computeHMAC: async (data) => `HMAC:${JSON.stringify(data)}`,
  verifyHMAC: async (data, sig) => sig === `HMAC:${JSON.stringify(data)}`,
  init: async () => true,
  verifyPin: async () => true
};

// ==================== In-Memory IndexedDB Mock ====================

class MockObjectStore {
  constructor(keyPath) {
    this.keyPath = keyPath;
    this.data = new Map();
    this.indexes = {};
  }
  get(key) { return this.data.get(key) || null; }
  put(record) {
    const key = record[this.keyPath];
    this.data.set(key, JSON.parse(JSON.stringify(record)));
    // Update indexes
    for (const [idxName, idxStore] of Object.entries(this.indexes)) {
      const val = record[idxName];
      if (val !== undefined) {
        if (!idxStore.has(val)) idxStore.set(val, []);
        const arr = idxStore.get(val).filter(k => k !== key);
        arr.push(key);
        idxStore.set(val, arr);
      }
    }
    return key;
  }
  delete(key) {
    const record = this.data.get(key);
    this.data.delete(key);
    if (record) {
      for (const [idxName, idxStore] of Object.entries(this.indexes)) {
        const val = record[idxName];
        if (val !== undefined && idxStore.has(val)) {
          idxStore.set(val, idxStore.get(val).filter(k => k !== key));
        }
      }
    }
  }
  getAll() { return Array.from(this.data.values()).map(v => JSON.parse(JSON.stringify(v))); }
  getByIndex(idxName, value) {
    const keys = (this.indexes[idxName] || new Map()).get(value) || [];
    return keys.map(k => this.data.get(k)).filter(Boolean).map(v => JSON.parse(JSON.stringify(v)));
  }
  clear() { this.data.clear(); for (const idx of Object.values(this.indexes)) idx.clear(); }
  count() { return this.data.size; }
  addIndex(name) { if (!this.indexes[name]) this.indexes[name] = new Map(); }
}

class MockDB {
  constructor() {
    this.stores = {};
  }
  addStore(name, keyPath, indexes = []) {
    const store = new MockObjectStore(keyPath);
    indexes.forEach(idx => store.addIndex(idx));
    this.stores[name] = store;
  }
  store(name) { return this.stores[name]; }
}

let mockDB = null;

// Mock DB module
const DB = (() => {
  function open() {
    if (mockDB) return Promise.resolve(mockDB);
    mockDB = new MockDB();
    mockDB.addStore('patients', 'id', ['name', 'lastVisitDate', 'riskLevel', 'syncStatus']);
    mockDB.addStore('visits', 'id', ['patientId', 'date', 'riskLevel', 'isDraft', 'syncStatus']);
    mockDB.addStore('questionnaire_templates', 'id', ['diseaseType', 'version']);
    mockDB.addStore('sync_queue', 'id', ['entityType', 'entityId', 'priority', 'createdAt']);
    mockDB.addStore('sync_conflicts', 'id', ['entityType', 'resolved']);
    mockDB.addStore('settings', 'key', []);
    mockDB.addStore('attachment_queue', 'id', ['visitId', 'status']);
    mockDB.addStore('followup_plans', 'id', ['patientId', 'status', 'planDate', 'priority']);
    mockDB.addStore('risk_config', 'id', ['priority']);
    return Promise.resolve(mockDB);
  }

  async function get(db, storeName, key) {
    const s = db.store(storeName);
    return s ? s.get(key) : null;
  }

  async function put(db, storeName, data) {
    return db.store(storeName).put(data);
  }

  async function deleteRecord(db, storeName, key) {
    db.store(storeName).delete(key);
  }

  async function getAll(db, storeName) {
    return db.store(storeName).getAll();
  }

  async function getByIndex(db, storeName, indexName, value) {
    return db.store(storeName).getByIndex(indexName, value);
  }

  async function query(db, storeName, predicate) {
    return (await getAll(db, storeName)).filter(predicate);
  }

  async function count(db, storeName) {
    return db.store(storeName).count();
  }

  async function clear(db, storeName) {
    db.store(storeName).clear();
  }

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
      patient._baseSnapshot = null;
    } else {
      patient._rev = (existing._rev || 0) + 1;
      if (!patient._baseSnapshot && existing._baseSnapshot) {
        patient._baseSnapshot = existing._baseSnapshot;
      }
      // 编辑已同步记录 → 重置为待同步
      if (existing.syncStatus === 'synced') {
        patient.syncStatus = 'pending';
      }
    }

    if (patient.idCard && CryptoManager.isReady()) {
      patient._encrypted_idCard = await CryptoManager.encrypt(patient.idCard);
      delete patient.idCard;
    }
    patient._hmac = await CryptoManager.computeHMAC({
      id: patient.id, name: patient.name, age: patient.age, diseases: patient.diseases
    });

    await put(db, 'patients', patient);
    if (patient.syncStatus !== 'synced') {
      await addToSyncQueue('patients', patient.id, isNew ? 'create' : 'update', patient);
    }
    return patient;
  }

  async function loadPatient(id) {
    const db = await open();
    const patient = await get(db, 'patients', id);
    if (!patient) return null;
    if (patient._encrypted_idCard && CryptoManager.isReady()) {
      try { patient.idCard = await CryptoManager.decrypt(patient._encrypted_idCard); } catch {}
    }
    return patient;
  }

  async function loadAllPatients() {
    const db = await open();
    const patients = await getAll(db, 'patients');
    for (const p of patients) {
      if (p._encrypted_idCard && CryptoManager.isReady()) {
        try { p.idCard = await CryptoManager.decrypt(p._encrypted_idCard); } catch {}
      }
    }
    return patients;
  }

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

    if (visit.questionnaires && visit.questionnaires.length > 0) {
      visit._templateVersions = visit.questionnaires.map(q => ({
        templateId: q.templateId, version: q.version, diseaseType: q.diseaseType
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
    return get(db, 'visits', id);
  }

  async function loadVisitsByPatient(patientId) {
    const db = await open();
    return getByIndex(db, 'visits', 'patientId', patientId);
  }

  async function addToSyncQueue(entityType, entityId, action, payload) {
    const db = await open();
    const priority = action === 'create' ? 1 : 2;

    // Dedup
    const allItems = await getAll(db, 'sync_queue');
    const existingForEntity = allItems.filter(
      item => item.entityType === entityType && item.entityId === entityId
    );

    let encryptedPayload = payload;
    if (CryptoManager.isReady() && typeof payload === 'object') {
      try {
        encryptedPayload = { _encrypted: await CryptoManager.encrypt(JSON.stringify(payload)) };
      } catch {}
    }

    if (existingForEntity.length > 0) {
      const existing = existingForEntity[0];
      existing.payload = encryptedPayload;
      existing.updatedAt = Utils.now();
      existing.retryCount = 0;
      existing.lastError = null;
      if (existing.action !== 'create') existing.action = action;
      await put(db, 'sync_queue', existing);
      for (let i = 1; i < existingForEntity.length; i++) {
        await deleteRecord(db, 'sync_queue', existingForEntity[i].id);
      }
      return existing;
    }

    const item = {
      id: Utils.uuid(),
      entityType, entityId, action,
      payload: encryptedPayload,
      retryCount: 0, lastError: null,
      createdAt: Utils.now(), updatedAt: Utils.now(),
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

  async function saveTemplate(template) {
    const db = await open();
    await put(db, 'questionnaire_templates', template);
    return template;
  }

  async function getAllTemplates() {
    const db = await open();
    return getAll(db, 'questionnaire_templates');
  }

  async function getSetting(key) {
    const db = await open();
    const s = await get(db, 'settings', key);
    return s ? s.value : null;
  }

  async function setSetting(key, value) {
    const db = await open();
    await put(db, 'settings', { key, value });
  }

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
      status: 'pending',
      retryCount: 0, lastError: null,
      createdAt: Utils.now()
    };
    await put(db, 'attachment_queue', item);
    return item;
  }

  async function getAttachmentQueue() {
    const db = await open();
    const items = await getAll(db, 'attachment_queue');
    return items.filter(i => i.status !== 'uploaded');
  }

  async function updateAttachmentQueueItem(id, updates) {
    const db = await open();
    const item = await get(db, 'attachment_queue', id);
    if (!item) return null;
    Object.assign(item, updates);
    await put(db, 'attachment_queue', item);
    return item;
  }

  async function getStorageStats() {
    const db = await open();
    const stats = {};
    for (const name of Object.keys(mockDB.stores)) {
      stats[name] = await count(db, name);
    }
    return stats;
  }

  async function checkDuplicateVisit(patientId, date) {
    const db = await open();
    const visits = await getByIndex(db, 'visits', 'patientId', patientId);
    return visits.filter(v => v.date === date && !v.isDraft);
  }

  async function updateBaseSnapshot(entityType, entityId, serverVersion) {
    const db = await open();
    const record = await get(db, entityType, entityId);
    if (!record) return;
    record.syncStatus = 'synced';
    record.syncVersion = serverVersion;
    record._baseSnapshot = _cleanSnapshot(record);
    await put(db, entityType, record);
  }

  async function putResolved(entityType, record) {
    const db = await open();
    await put(db, entityType, record);
  }

  // --- 随访计划操作 ---
  async function savePlan(plan) {
    const db = await open();
    if (!plan.id) plan.id = Utils.uuid();
    plan.updatedAt = Utils.now();
    await put(db, 'followup_plans', plan);
    return plan;
  }
  async function getAllPlans() {
    const db = await open();
    return getAll(db, 'followup_plans');
  }
  async function getPlansByPatient(patientId) {
    const db = await open();
    return getByIndex(db, 'followup_plans', 'patientId', patientId);
  }
  async function deletePlan(id) {
    const db = await open();
    await deleteRecord(db, 'followup_plans', id);
  }

  // --- 风险配置操作 ---
  async function saveRiskConfig(rule) {
    const db = await open();
    if (!rule.id) rule.id = Utils.uuid();
    rule.updatedAt = Utils.now();
    await put(db, 'risk_config', rule);
    return rule;
  }
  async function getRiskConfig() {
    const db = await open();
    return getAll(db, 'risk_config');
  }
  async function clearRiskConfig() {
    const db = await open();
    await clear(db, 'risk_config');
  }

  return {
    open, get, put, deleteRecord, getAll, getByIndex, query, count, clear,
    savePatient, loadPatient, loadAllPatients,
    saveVisit, loadVisit, loadVisitsByPatient,
    addToSyncQueue, getSyncQueue, removeSyncQueueItem,
    saveConflict, getUnresolvedConflicts,
    saveTemplate, getAllTemplates,
    getSetting, setSetting,
    saveDraft, loadDraft, clearDraft,
    addToAttachmentQueue, getAttachmentQueue, updateAttachmentQueueItem,
    getStorageStats, checkDuplicateVisit,
    updateBaseSnapshot, putResolved, _cleanSnapshot,
    savePlan, getAllPlans, getPlansByPatient, deletePlan,
    saveRiskConfig, getRiskConfig, clearRiskConfig
  };
})();

// ==================== 三方合并（从 sync.js 提取核心逻辑） ====================

function _deepEqualFn(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => _deepEqualFn(v, b[i]));
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(k => _deepEqualFn(a[k], b[k]));
}

function threeWayMerge(base, local, remote) {
  const merged = {};
  const conflicts = [];
  const autoMerged = [];
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

    const localChanged = !_deepEqualFn(localVal, baseVal);
    const remoteChanged = !_deepEqualFn(remoteVal, baseVal);

    if (localChanged && remoteChanged) {
      if (_deepEqualFn(localVal, remoteVal)) {
        merged[key] = localVal;
        autoMerged.push({ field: key, choice: 'same-change' });
      } else {
        conflicts.push({
          field: key, baseValue: baseVal, localValue: localVal, remoteValue: remoteVal
        });
        merged[key] = remoteVal;
      }
    } else if (localChanged) {
      merged[key] = localVal;
      autoMerged.push({ field: key, choice: 'local' });
    } else if (remoteChanged) {
      merged[key] = remoteVal;
      autoMerged.push({ field: key, choice: 'remote' });
    } else {
      merged[key] = baseVal !== undefined ? baseVal : (localVal !== undefined ? localVal : remoteVal);
    }
  }
  return { merged, conflicts, autoMerged };
}

// ==================== 提醒系统（从 reminders.js 提取） ====================

const RISK_INTERVALS = { high: 7, medium: 14, low: 30, none: 60 };
const DISEASE_DEFAULT_INTERVALS = {
  hypertension: 14, diabetes: 14, copd: 30,
  heart_disease: 14, stroke: 14, mental_illness: 30, tuberculosis: 7
};

function getNextVisitDate(patient, riskLevel, visitDate) {
  const risk = riskLevel || patient.riskLevel || 'none';
  let interval = RISK_INTERVALS[risk] || RISK_INTERVALS.none;
  if (patient.diseases && patient.diseases.length > 0) {
    for (const disease of patient.diseases) {
      const di = DISEASE_DEFAULT_INTERVALS[disease];
      if (di && di < interval) interval = di;
    }
  }
  if (risk === 'high' && interval > 7) interval = 7;
  const baseDate = visitDate || Utils.today();
  return Utils.addDays(baseDate, interval);
}

// ==================== 测试用例 ====================

async function runTests() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  医疗随访 PWA 综合测试套件                      ║');
  console.log('╚══════════════════════════════════════════════╝');

  // ─────────────────────────────────────────────
  await asyncSuite('1. 三方合并基础算法', async () => {
    // 1.1 双方无修改
    const base1 = { name: '张三', age: 60, phone: '13800000001' };
    const r1 = threeWayMerge(base1, { ...base1 }, { ...base1 });
    assertEqual(r1.conflicts.length, 0, '1.1 无修改应无冲突');
    assertEqual(r1.merged.name, '张三', '1.1 合并值正确');

    // 1.2 仅本地修改
    const local2 = { ...base1, phone: '13900000001' };
    const r2 = threeWayMerge(base1, local2, { ...base1 });
    assertEqual(r2.conflicts.length, 0, '1.2 仅本地修改无冲突');
    assertEqual(r2.merged.phone, '13900000001', '1.2 应取本地值');
    assertEqual(r2.autoMerged.filter(m => m.choice === 'local').length, 1, '1.2 自动合并标记为 local');

    // 1.3 仅远程修改
    const remote3 = { ...base1, age: 61 };
    const r3 = threeWayMerge(base1, { ...base1 }, remote3);
    assertEqual(r3.conflicts.length, 0, '1.3 仅远程修改无冲突');
    assertEqual(r3.merged.age, 61, '1.3 应取远程值');

    // 1.4 双方修改不同字段
    const local4 = { ...base1, phone: '13900000002' };
    const remote4 = { ...base1, age: 62 };
    const r4 = threeWayMerge(base1, local4, remote4);
    assertEqual(r4.conflicts.length, 0, '1.4 修改不同字段无冲突');
    assertEqual(r4.merged.phone, '13900000002', '1.4 phone 取本地');
    assertEqual(r4.merged.age, 62, '1.4 age 取远程');

    // 1.5 双方修改同一字段（冲突）
    const local5 = { ...base1, phone: '13900000003' };
    const remote5 = { ...base1, phone: '13700000003' };
    const r5 = threeWayMerge(base1, local5, remote5);
    assertEqual(r5.conflicts.length, 1, '1.5 同一字段双方修改应有 1 个冲突');
    assertEqual(r5.conflicts[0].field, 'phone', '1.5 冲突字段为 phone');
    assertEqual(r5.conflicts[0].localValue, '13900000003', '1.5 冲突本地值');
    assertEqual(r5.conflicts[0].remoteValue, '13700000003', '1.5 冲突远程值');

    // 1.6 双方做相同修改
    const local6 = { ...base1, age: 65 };
    const remote6 = { ...base1, age: 65 };
    const r6 = threeWayMerge(base1, local6, remote6);
    assertEqual(r6.conflicts.length, 0, '1.6 相同修改无冲突');
    assertEqual(r6.merged.age, 65, '1.6 相同修改值正确');

    // 1.7 新增字段（仅本地新增）
    const local7 = { ...base1, address: '新地址' };
    const r7 = threeWayMerge(base1, local7, { ...base1 });
    assertEqual(r7.conflicts.length, 0, '1.7 新增字段无冲突');
    assertEqual(r7.merged.address, '新地址', '1.7 新增字段被保留');

    // 1.8 远程删除字段
    const local8 = { ...base1 };
    const remote8 = { ...base1 };
    delete remote8.phone;
    const r8 = threeWayMerge(base1, local8, remote8);
    assertEqual(r8.merged.phone, undefined, '1.8 远程删除字段后合并结果为 undefined');

    // 1.9 数组字段冲突
    const base9 = { diseases: ['hypertension'] };
    const local9 = { diseases: ['hypertension', 'diabetes'] };
    const remote9 = { diseases: ['hypertension', 'copd'] };
    const r9 = threeWayMerge(base9, local9, remote9);
    assertEqual(r9.conflicts.length, 1, '1.9 数组字段双方修改应有冲突');

    // 1.10 base 为 null（新建记录）
    const r10 = threeWayMerge(null, { name: '新建', age: 50 }, { name: '新建', age: 55 });
    assert(r10.conflicts.length >= 1, '1.10 base 为 null 时双方修改应冲突');
  });

  // ─────────────────────────────────────────────
  await asyncSuite('2. 离线新建记录', async () => {
    await DB.open();
    // 清空
    mockDB.store('patients').clear();
    mockDB.store('sync_queue').clear();
    mockDB.store('visits').clear();
    mockDB.store('sync_conflicts').clear();

    // 离线新建患者
    const patient = await DB.savePatient({
      name: '测试患者A',
      age: 55,
      gender: 'male',
      idCard: '310101196901011234',
      diseases: ['hypertension'],
      riskLevel: 'medium'
    });

    assert(patient.id !== undefined, '2.1 新建患者应有 ID');
    assertEqual(patient._rev, 1, '2.2 新建 _rev 应为 1');
    assertEqual(patient._baseSnapshot, null, '2.3 新建 _baseSnapshot 应为 null');
    assertEqual(patient.syncStatus, 'pending', '2.4 新建 syncStatus 应为 pending');

    // 验证加密字段
    assert(patient._encrypted_idCard !== undefined, '2.5 身份证应已加密');
    assert(patient.idCard === undefined, '2.6 明文身份证应已删除');
    assert(patient._hmac !== undefined, '2.7 应有 HMAC 校验和');

    // 验证同步队列
    const queue = await DB.getSyncQueue();
    assertEqual(queue.length, 1, '2.8 同步队列应有 1 条');
    assertEqual(queue[0].entityType, 'patients', '2.9 队列类型正确');
    assertEqual(queue[0].action, 'create', '2.10 队列操作为 create');
    assert(queue[0].idempotencyKey !== undefined, '2.11 应有权幂等 key');
  });

  // ─────────────────────────────────────────────
  await asyncSuite('3. 离线编辑记录', async () => {
    await DB.open();
    mockDB.store('patients').clear();
    mockDB.store('sync_queue').clear();
    mockDB.store('sync_conflicts').clear();

    // 先创建一个患者
    const patient = await DB.savePatient({
      name: '测试患者B',
      age: 60,
      diseases: ['diabetes'],
      riskLevel: 'low'
    });

    // 模拟同步成功（设置 baseSnapshot）
    await DB.updateBaseSnapshot('patients', patient.id, 1);
    mockDB.store('sync_queue').clear(); // 清除同步队列

    // 离线编辑
    const loaded = await DB.loadPatient(patient.id);
    loaded.riskLevel = 'high';
    loaded.phone = '13800001111';
    const updated = await DB.savePatient(loaded);

    assertEqual(updated._rev, 2, '3.1 编辑后 _rev 应为 2');
    assert(updated._baseSnapshot !== null, '3.2 编辑后应保留 _baseSnapshot');
    assertEqual(updated._baseSnapshot.riskLevel, 'low', '3.3 baseSnapshot 应为同步前的值');
    assertEqual(updated.riskLevel, 'high', '3.4 本地值应为 high');

    // 验证同步队列去重
    const queue = await DB.getSyncQueue();
    assertEqual(queue.length, 1, '3.5 同步队列应去重为 1 条');
    assertEqual(queue[0].action, 'update', '3.6 操作应为 update');

    // 再次编辑（应仍为 1 条队列项）
    loaded.address = '新地址';
    await DB.savePatient(loaded);
    const queue2 = await DB.getSyncQueue();
    assertEqual(queue2.length, 1, '3.7 多次编辑仍应去重为 1 条');
  });

  // ─────────────────────────────────────────────
  await asyncSuite('4. 同步队列去重（重复同步请求）', async () => {
    await DB.open();
    mockDB.store('patients').clear();
    mockDB.store('sync_queue').clear();

    const patient = await DB.savePatient({
      name: '测试患者C',
      age: 45,
      diseases: ['hypertension'],
      riskLevel: 'none'
    });

    // 多次调用 addToSyncQueue
    await DB.addToSyncQueue('patients', patient.id, 'update', { name: '修改1' });
    await DB.addToSyncQueue('patients', patient.id, 'update', { name: '修改2' });
    await DB.addToSyncQueue('patients', patient.id, 'update', { name: '修改3' });

    const queue = await DB.getSyncQueue();
    assertEqual(queue.length, 1, '4.1 同一实体多次入队应去重为 1');
    // action 保持 create（首次创建）
    assertEqual(queue[0].action, 'create', '4.2 首次 create 操作应保留');

    // 不同实体应各自独立
    const patient2 = await DB.savePatient({
      name: '测试患者D',
      age: 50,
      diseases: [],
      riskLevel: 'none'
    });
    const queue2 = await DB.getSyncQueue();
    assertEqual(queue2.length, 2, '4.3 不同实体应有 2 条队列项');
  });

  // ─────────────────────────────────────────────
  await asyncSuite('5. 模板升级 + 问卷版本冲突', async () => {
    await DB.open();
    mockDB.store('visits').clear();
    mockDB.store('sync_queue').clear();
    mockDB.store('sync_conflicts').clear();
    mockDB.store('questionnaire_templates').clear();

    // 保存 v1 模板
    await DB.saveTemplate({
      id: 'htn_v1', version: 1, name: '高血压问卷v1', diseaseType: 'hypertension',
      questions: [
        { id: 'bp_control', text: '血压控制', type: 'select', options: ['达标', '偏高'] },
        { id: 'medication', text: '用药', type: 'text' }
      ]
    });

    // 保存 v2 模板（新增题目）
    await DB.saveTemplate({
      id: 'htn_v2', version: 2, name: '高血压问卷v2', diseaseType: 'hypertension',
      questions: [
        { id: 'bp_control', text: '血压控制', type: 'select', options: ['达标', '偏高', '波动大'] },
        { id: 'medication', text: '用药', type: 'text' },
        { id: 'sleep_quality', text: '睡眠质量', type: 'select', options: ['好', '一般', '差'] },
        { id: 'mental_health', text: '情绪状态', type: 'select', options: ['良好', '焦虑'] }
      ]
    });

    // 创建使用 v1 模板的离线访问记录
    const visit = await DB.saveVisit({
      patientId: 'patient-1',
      date: '2026-06-01',
      questionnaires: [{
        templateId: 'htn_v1',
        version: 1,
        diseaseType: 'hypertension',
        answers: { bp_control: '达标', medication: '氨氯地平5mg' }
      }],
      riskLevel: 'low'
    });

    assert(visit._templateVersions !== undefined, '5.1 应记录模板版本');
    assertEqual(visit._templateVersions[0].version, 1, '5.2 模板版本应为 1');

    // 模拟远程端已用 v2 提交（远程模板版本为 2）
    const baseData = DB._cleanSnapshot(visit);
    const localData = {
      ...visit,
      questionnaires: [{
        ...visit.questionnaires[0],
        answers: { bp_control: '偏高', medication: '氨氯地平10mg' }
      }]
    };
    const remoteData = {
      ...visit,
      questionnaires: [{
        templateId: 'htn_v2',
        version: 2,
        diseaseType: 'hypertension',
        answers: { bp_control: '达标', medication: '氨氯地平5mg', sleep_quality: '好' }
      }]
    };

    // 三方合并应检测模板版本差异
    const result = threeWayMerge(baseData, localData, remoteData);
    // questionnaires 字段双方都修改了 → 冲突
    assert(result.conflicts.length >= 1, '5.3 问卷数据双方修改应有冲突');
    const qConflict = result.conflicts.find(c => c.field === 'questionnaires');
    assert(qConflict !== undefined, '5.4 应有 questionnaires 字段冲突');

    // 验证旧答案迁移逻辑
    const oldAnswers = { bp_control: '达标', medication: '氨氯地平5mg' };
    const newTemplateQuestions = [
      { id: 'bp_control', text: '血压控制' },
      { id: 'medication', text: '用药' },
      { id: 'sleep_quality', text: '睡眠质量' },
      { id: 'mental_health', text: '情绪状态' }
    ];
    const migratedAnswers = {};
    const unmapped = [];
    newTemplateQuestions.forEach(nq => {
      if (oldAnswers[nq.id] !== undefined) {
        migratedAnswers[nq.id] = oldAnswers[nq.id];
      }
    });
    Object.keys(oldAnswers).forEach(qId => {
      if (!newTemplateQuestions.find(q => q.id === qId)) {
        unmapped.push(qId);
      }
    });
    assertEqual(Object.keys(migratedAnswers).length, 2, '5.5 迁移后应有 2 个匹配答案');
    assertEqual(unmapped.length, 0, '5.6 不应有未映射答案（旧题目均在新模板中）');
  });

  // ─────────────────────────────────────────────
  await asyncSuite('6. 附件压缩状态 + 上传重试', async () => {
    await DB.open();
    mockDB.store('attachment_queue').clear();

    // 创建附件（模拟压缩状态）
    const attachment = {
      id: 'att-1',
      visitId: 'visit-1',
      name: 'photo.jpg',
      data: 'data:image/jpeg;base64,/9j/4AAQ...',
      thumbnail: 'data:image/jpeg;base64,/9j/thumb...',
      compressionState: 'compressed',
      uploadStatus: 'pending',
      compressionParams: { maxWidth: 1280, quality: 0.7 },
      checksum: 'abc123',
      originalSize: 5000000,
      compressedSize: 350000
    };

    // 加入上传队列
    const queueItem = await DB.addToAttachmentQueue(attachment);
    assertEqual(queueItem.status, 'pending', '6.1 初始状态应为 pending');
    assertEqual(queueItem.compressionState, 'compressed', '6.2 压缩状态应保留');

    // 模拟上传失败
    await DB.updateAttachmentQueueItem(queueItem.id, {
      status: 'pending',
      retryCount: 1,
      lastError: '网络超时'
    });
    const item1 = (await DB.getAttachmentQueue())[0];
    assertEqual(item1.retryCount, 1, '6.3 重试次数应为 1');
    assertEqual(item1.lastError, '网络超时', '6.4 应记录错误信息');

    // 再次重试成功
    await DB.updateAttachmentQueueItem(queueItem.id, {
      status: 'uploaded',
      compressionState: 'uploaded'
    });
    const remaining = await DB.getAttachmentQueue();
    assertEqual(remaining.length, 0, '6.5 上传成功后应从队列移除');

    // 测试多次失败直到放弃
    const att2 = {
      id: 'att-2', visitId: 'visit-1', name: 'photo2.jpg',
      data: 'data:image/jpeg;base64,...', compressionState: 'compressed'
    };
    const qi2 = await DB.addToAttachmentQueue(att2);
    for (let i = 1; i <= 3; i++) {
      await DB.updateAttachmentQueueItem(qi2.id, {
        status: i >= 3 ? 'failed' : 'pending',
        retryCount: i,
        lastError: `失败 #${i}`
      });
    }
    const failedItems = await DB.getAttachmentQueue();
    const failedItem = failedItems.find(i => i.id === 'att-2');
    assert(failedItem !== undefined, '6.6 失败项应仍在队列中');
    assertEqual(failedItem.status, 'failed', '6.7 最终状态应为 failed');
    assertEqual(failedItem.retryCount, 3, '6.8 重试次数应为 3');

    // 压缩状态一致性验证
    assertEqual(failedItem.compressionState, 'compressed', '6.9 失败后压缩状态应保持不变');
  });

  // ─────────────────────────────────────────────
  await asyncSuite('7. 提醒日期幂等性（防止重复推进）', async () => {
    const patient = {
      id: 'p-1', name: '测试', age: 68,
      diseases: ['hypertension'], riskLevel: 'high'
    };

    const visitDate = '2026-06-01';

    // 第一次计算
    const date1 = getNextVisitDate(patient, 'high', visitDate);
    // 第二次计算（同一天）
    const date2 = getNextVisitDate(patient, 'high', visitDate);
    // 第三次计算（同一天）
    const date3 = getNextVisitDate(patient, 'high', visitDate);

    assertEqual(date1, date2, '7.1 相同输入应返回相同日期');
    assertEqual(date2, date3, '7.2 多次调用应返回相同日期（幂等）');

    // 高风险 7 天间隔
    assertEqual(date1, Utils.addDays(visitDate, 7), '7.3 高风险应为就诊日+7天');

    // 中风险 14 天
    const dateMid = getNextVisitDate(patient, 'medium', visitDate);
    // hypertension 默认 14 天，medium 默认 14 天 → 14
    assertEqual(dateMid, Utils.addDays(visitDate, 14), '7.4 中风险高血压应为就诊日+14天');

    // 低风险
    const dateLow = getNextVisitDate(patient, 'low', visitDate);
    assertEqual(dateLow, Utils.addDays(visitDate, 14), '7.5 低风险高血压应为就诊日+14天（疾病间隔更短）');

    // 无风险无疾病患者
    const patientNone = { id: 'p-2', diseases: [], riskLevel: 'none' };
    const dateNone = getNextVisitDate(patientNone, 'none', visitDate);
    assertEqual(dateNone, Utils.addDays(visitDate, 60), '7.6 无风险无疾病应为就诊日+60天');

    // 关键测试：不同调用时间不应改变结果
    // 模拟 "第二天" 再次调用，使用相同 visitDate
    const dateNextDay = getNextVisitDate(patient, 'high', visitDate);
    assertEqual(date1, dateNextDay, '7.7 不同调用时间但相同 visitDate 应返回相同结果');
  });

  // ─────────────────────────────────────────────
  await asyncSuite('8. 加密存储一致性', async () => {
    await DB.open();
    mockDB.store('patients').clear();
    mockDB.store('sync_queue').clear();

    // 创建带敏感数据的患者
    const patient = await DB.savePatient({
      name: '加密测试',
      age: 50,
      idCard: '310101197601011234',
      diseases: ['hypertension'],
      riskLevel: 'low'
    });

    // 验证存储中无明文
    const db = await DB.open();
    const stored = await DB.get(db, 'patients', patient.id);
    assert(stored.idCard === undefined, '8.1 存储中不应有明文身份证');
    assert(stored._encrypted_idCard !== undefined, '8.2 应有加密身份证');
    assert(stored._encrypted_idCard.startsWith('ENC:'), '8.3 加密格式正确');
    assert(stored._hmac !== undefined, '8.4 应有 HMAC');

    // 加载时应解密
    const loaded = await DB.loadPatient(patient.id);
    assertEqual(loaded.idCard, '310101197601011234', '8.5 加载后应解密身份证');

    // HMAC 验证
    const hmacValid = await CryptoManager.verifyHMAC(
      { id: stored.id, name: stored.name, age: stored.age, diseases: stored.diseases },
      stored._hmac
    );
    assert(hmacValid, '8.6 HMAC 校验应通过');

    // 同步队列中的 payload 也应加密
    const queue = await DB.getSyncQueue();
    assert(queue.length > 0, '8.7 同步队列应有数据');
    assert(queue[0].payload._encrypted !== undefined, '8.8 队列 payload 应已加密');
  });

  // ─────────────────────────────────────────────
  await asyncSuite('9. 完整三方合并场景（离线编辑旧模板 + 远程新模板）', async () => {
    await DB.open();
    mockDB.store('visits').clear();
    mockDB.store('sync_queue').clear();
    mockDB.store('sync_conflicts').clear();

    // 基础快照（上次同步时的状态）
    const baseVisit = {
      id: 'visit-conflict-1',
      patientId: 'p-1',
      date: '2026-05-15',
      bpSystolic: 140,
      bpDiastolic: 90,
      bloodSugar: 6.5,
      riskLevel: 'medium',
      notes: '血压偏高',
      medications: ['氨氯地平5mg'],
      questionnaires: [{
        templateId: 'htn_v1', version: 1, diseaseType: 'hypertension',
        answers: { bp_control: '偏高', medication: '氨氯地平5mg' }
      }]
    };

    // 本地离线编辑（旧模板，修改了血压和添加附件）
    const localVisit = {
      ...JSON.parse(JSON.stringify(baseVisit)),
      bpSystolic: 135,
      bpDiastolic: 85,
      notes: '血压有所改善',
      attachments: [{ id: 'att-local', name: 'photo.jpg', compressionState: 'compressed' }],
      _rev: 2
    };

    // 远程已提交新模板答案
    const remoteVisit = {
      ...JSON.parse(JSON.stringify(baseVisit)),
      bpSystolic: 130,
      bpDiastolic: 82,
      notes: '血压偏高', // 未修改
      questionnaires: [{
        templateId: 'htn_v2', version: 2, diseaseType: 'hypertension',
        answers: {
          bp_control: '达标', medication: '氨氯地平5mg',
          sleep_quality: '好', mental_health: '良好'
        }
      }],
      syncVersion: 2
    };

    const result = threeWayMerge(baseVisit, localVisit, remoteVisit);

    // bpDiastolic: local 90→85, remote 90→82 → 冲突
    const bpDiaConflict = result.conflicts.find(c => c.field === 'bpDiastolic');
    assert(bpDiaConflict !== undefined, '9.0 bpDiastolic 双方修改应有冲突');
    // bpSystolic: local 140→135, remote 140→130 → 冲突
    const bpSysConflict = result.conflicts.find(c => c.field === 'bpSystolic');
    assert(bpSysConflict !== undefined, '9.1 bpSystolic 双方修改应有冲突');
    assertEqual(bpSysConflict.localValue, 135, '9.2 冲突本地值 135');
    assertEqual(bpSysConflict.remoteValue, 130, '9.3 冲突远程值 130');

    // notes: local 修改了, remote 未修改 → 自动取本地
    const notesAuto = result.autoMerged.find(m => m.field === 'notes');
    assert(notesAuto !== undefined, '9.4 notes 仅本地修改应自动合并');
    assertEqual(notesAuto.choice, 'local', '9.5 notes 应选择本地');
    assertEqual(result.merged.notes, '血压有所改善', '9.6 notes 合并值正确');

    // attachments: local 新增, remote 未修改 → 自动取本地
    assert(result.merged.attachments !== undefined, '9.7 本地新增附件应保留');
    assertEqual(result.merged.attachments.length, 1, '9.8 附件数量正确');
    assertEqual(result.merged.attachments[0].compressionState, 'compressed', '9.9 附件压缩状态应保留');

    // questionnaires: local 未修改, remote 修改了 → 自动取远程
    const qAuto = result.autoMerged.find(m => m.field === 'questionnaires');
    assert(qAuto !== undefined, '9.10 questionnaires 仅远程修改应自动合并');
    assertEqual(qAuto.choice, 'remote', '9.11 questionnaires 应选择远程');
    assertEqual(result.merged.questionnaires[0].version, 2, '9.12 远程新模板版本应保留');

    // medications: 双方均未修改 → 保持 base
    assertDeepEqual(result.merged.medications, ['氨氯地平5mg'], '9.13 medications 双方未修改应保持 base');
  });

  // ─────────────────────────────────────────────
  await asyncSuite('10. 冲突解决 + 基础快照更新', async () => {
    await DB.open();
    mockDB.store('patients').clear();
    mockDB.store('sync_queue').clear();
    mockDB.store('sync_conflicts').clear();

    // 创建患者并模拟已同步
    const patient = await DB.savePatient({
      name: '冲突解决测试',
      age: 70,
      diseases: ['hypertension', 'diabetes'],
      riskLevel: 'medium',
      phone: '13800000001'
    });
    await DB.updateBaseSnapshot('patients', patient.id, 1);
    mockDB.store('sync_queue').clear();

    // 本地编辑
    const loaded = await DB.loadPatient(patient.id);
    loaded.riskLevel = 'high';
    loaded.phone = '13900000001';
    await DB.savePatient(loaded);

    // 验证 baseSnapshot 未被编辑覆盖
    const db = await DB.open();
    const stored = await DB.get(db, 'patients', patient.id);
    assertEqual(stored._baseSnapshot.riskLevel, 'medium', '10.1 baseSnapshot 应保持同步前的值');
    assertEqual(stored._baseSnapshot.phone, '13800000001', '10.2 baseSnapshot phone 应保持同步前的值');

    // 创建冲突记录
    const conflict = await DB.saveConflict({
      entityType: 'patients',
      entityId: patient.id,
      localData: stored,
      remoteData: { ...stored._baseSnapshot, riskLevel: 'low', phone: '13700000001' },
      baseData: stored._baseSnapshot,
      localVersion: stored._rev,
      remoteVersion: 2,
      resolved: false
    });

    assert(conflict.id !== undefined, '10.3 冲突记录应有 ID');
    const unresolved = await DB.getUnresolvedConflicts();
    assertEqual(unresolved.length, 1, '10.4 应有 1 个未解决冲突');

    // 解决冲突（选择本地 riskLevel，远程 phone）
    const resolvedData = {
      ...stored._baseSnapshot,
      riskLevel: 'high',  // 选本地
      phone: '13700000001', // 选远程
      name: stored.name,
      age: stored.age,
      diseases: stored.diseases
    };

    await DB.putResolved('patients', {
      ...resolvedData,
      _baseSnapshot: DB._cleanSnapshot(resolvedData),
      syncStatus: 'pending',
      syncVersion: 2,
      _rev: (stored._rev || 0) + 1
    });

    // 更新冲突为已解决
    const db2 = await DB.open();
    const c = await DB.get(db2, 'sync_conflicts', conflict.id);
    c.resolved = true;
    c.resolvedData = resolvedData;
    c.choice = 'merged';
    await DB.put(db2, 'sync_conflicts', c);

    const unresolved2 = await DB.getUnresolvedConflicts();
    assertEqual(unresolved2.length, 0, '10.5 解决后应无未解决冲突');

    // 验证解决后的数据
    const final = await DB.get(db2, 'patients', patient.id);
    assertEqual(final.riskLevel, 'high', '10.6 riskLevel 应为本地选择');
    assertEqual(final.phone, '13700000001', '10.7 phone 应为远程选择');
    assert(final._baseSnapshot !== null, '10.8 解决后应有新 baseSnapshot');
    assertEqual(final._baseSnapshot.riskLevel, 'high', '10.9 新 baseSnapshot riskLevel 正确');
  });

  // ─────────────────────────────────────────────
  await asyncSuite('11. 幂等性 key 防止重复同步', async () => {
    await DB.open();
    mockDB.store('patients').clear();
    mockDB.store('sync_queue').clear();

    const patient = await DB.savePatient({
      name: '幂等测试',
      age: 55,
      diseases: [],
      riskLevel: 'none'
    });

    const queue = await DB.getSyncQueue();
    assert(queue.length === 1, '11.1 应有 1 条队列项');
    const key1 = queue[0].idempotencyKey;
    assert(key1 !== undefined, '11.2 应有幂等性 key');
    assert(key1.startsWith('patients:'), '11.3 key 格式正确');

    // 编辑后 key 不应改变（因为去重更新了同一条）
    patient.riskLevel = 'low';
    await DB.savePatient(patient);
    const queue2 = await DB.getSyncQueue();
    assertEqual(queue2.length, 1, '11.4 编辑后仍应 1 条');
  });

  // ─────────────────────────────────────────────
  await asyncSuite('12. 草稿 + 模板升级交互', async () => {
    await DB.open();
    mockDB.store('settings').clear();

    // 保存 v1 草稿
    await DB.saveDraft('questionnaire', {
      patientId: 'p-draft-1',
      templateId: 'htn_v1',
      answers: { bp_control: '达标', medication: '氨氯地平' },
      answerCount: 2,
      savedAt: Utils.now()
    });

    const draft = await DB.loadDraft('questionnaire', 'p-draft-1');
    assert(draft !== null, '12.1 应能加载草稿');
    assertEqual(draft.templateId, 'htn_v1', '12.2 草稿模板 ID 正确');
    assertEqual(draft.answerCount, 2, '12.3 草稿答案数正确');

    // 模板升级后加载草稿 → 应检测到版本不匹配
    // 实际应用中会调用 migrateAnswers
    const oldAnswers = draft.answers;
    const newQuestions = [
      { id: 'bp_control' }, { id: 'medication' },
      { id: 'sleep_quality' }, { id: 'mental_health' }
    ];
    const migratedAnswers = {};
    const newQuestionIds = new Set(newQuestions.map(q => q.id));
    newQuestions.forEach(nq => {
      if (oldAnswers[nq.id] !== undefined) {
        migratedAnswers[nq.id] = oldAnswers[nq.id];
      }
    });
    assertEqual(Object.keys(migratedAnswers).length, 2, '12.4 迁移后应保留 2 个匹配答案');
    assert(migratedAnswers.bp_control === '达标', '12.5 bp_control 答案正确迁移');

    // 新增题目不应有旧答案
    assert(migratedAnswers.sleep_quality === undefined, '12.6 新增题目不应有旧答案');

    // 清理草稿
    await DB.clearDraft('questionnaire', 'p-draft-1');
    const cleared = await DB.loadDraft('questionnaire', 'p-draft-1');
    assertEqual(cleared, null, '12.7 清理后草稿应为 null');
  });

  // ─────────────────────────────────────────────
  // ==================== 三层级合并函数（从 sync.js 提取） ====================
  function threeLevelMerge(base, local, remote, entityType) {
    const result = threeWayMerge(base, local, remote);
    const levelDetails = { patient: [], questionnaire: [], attachment: [] };

    if (entityType !== 'visits') {
      levelDetails.patient = result.autoMerged.map(a => ({
        field: a.field, choice: a.choice, level: 'patient'
      }));
      return { ...result, levelDetails };
    }

    // 问卷层级合并
    if (local?.questionnaires || remote?.questionnaires) {
      const baseQ = (base?.questionnaires || []);
      const localQ = (local?.questionnaires || []);
      const remoteQ = (remote?.questionnaires || []);
      const allIds = new Set();
      localQ.forEach(q => allIds.add(q.templateId));
      remoteQ.forEach(q => allIds.add(q.templateId));

      const merged = [];
      for (const tid of allIds) {
        const baseItem = baseQ.find(q => q.templateId === tid);
        const localItem = localQ.find(q => q.templateId === tid);
        const remoteItem = remoteQ.find(q => q.templateId === tid);

        if (localItem && remoteItem) {
          const baseAnswers = baseItem ? baseItem.answers : {};
          const answerMerge = threeWayMerge(baseAnswers, localItem.answers || {}, remoteItem.answers || {});
          merged.push({
            templateId: tid,
            version: Math.max(localItem.version || 0, remoteItem.version || 0),
            answers: answerMerge.merged,
            _mergeConflicts: answerMerge.conflicts.length
          });
          if (answerMerge.conflicts.length > 0) {
            levelDetails.questionnaire.push({ templateId: tid, conflicts: answerMerge.conflicts.length, level: 'questionnaire' });
          }
        } else if (localItem) {
          merged.push(localItem);
        } else if (remoteItem) {
          merged.push(remoteItem);
        }
      }
      result.merged.questionnaires = merged;
    }

    // 附件层级合并
    if (local?.attachments || remote?.attachments) {
      const baseA = (base?.attachments || []);
      const localA = (local?.attachments || []);
      const remoteA = (remote?.attachments || []);
      const allIds = new Set();
      localA.forEach(a => { if (a.id) allIds.add(a.id); });
      remoteA.forEach(a => { if (a.id) allIds.add(a.id); });

      const merged = [];
      for (const aid of allIds) {
        const localItem = localA.find(a => a.id === aid);
        const remoteItem = remoteA.find(a => a.id === aid);

        if (localItem && remoteItem) {
          if (remoteItem.uploadStatus === 'uploaded') merged.push(remoteItem);
          else if (localItem.uploadStatus === 'uploaded') merged.push(localItem);
          else {
            const ls = localItem.compressedSize || Infinity;
            const rs = remoteItem.compressedSize || Infinity;
            merged.push(ls <= rs ? localItem : remoteItem);
          }
        } else if (localItem) { merged.push(localItem); }
        else if (remoteItem) { merged.push(remoteItem); }
      }
      result.merged.attachments = merged;
    }

    return { ...result, levelDetails };
  }

  // ==================== 随访计划逻辑（从 followup-plan.js 提取） ====================
  const ABNORMAL_THRESHOLDS = {
    bpSystolicHigh: { threshold: 180, unit: 'mmHg', label: '收缩压严重偏高' },
    bpDiastolicHigh: { threshold: 110, unit: 'mmHg', label: '舒张压严重偏高' },
    bloodSugarHigh: { threshold: 16.7, unit: 'mmol/L', label: '血糖严重偏高' },
    bloodSugarLow: { threshold: 3.9, unit: 'mmol/L', label: '血糖偏低' }
  };

  function detectAbnormalIndicators(visit) {
    if (!visit) return [];
    const indicators = [];
    if (visit.bpSystolic && visit.bpSystolic >= ABNORMAL_THRESHOLDS.bpSystolicHigh.threshold) {
      indicators.push({ field: 'bpSystolic', value: visit.bpSystolic, severity: 'high', label: ABNORMAL_THRESHOLDS.bpSystolicHigh.label });
    }
    if (visit.bpDiastolic && visit.bpDiastolic >= ABNORMAL_THRESHOLDS.bpDiastolicHigh.threshold) {
      indicators.push({ field: 'bpDiastolic', value: visit.bpDiastolic, severity: 'high', label: ABNORMAL_THRESHOLDS.bpDiastolicHigh.label });
    }
    if (visit.bloodSugar) {
      if (visit.bloodSugar >= ABNORMAL_THRESHOLDS.bloodSugarHigh.threshold) {
        indicators.push({ field: 'bloodSugar', value: visit.bloodSugar, severity: 'high', label: ABNORMAL_THRESHOLDS.bloodSugarHigh.label });
      }
      if (visit.bloodSugar <= ABNORMAL_THRESHOLDS.bloodSugarLow.threshold) {
        indicators.push({ field: 'bloodSugar', value: visit.bloodSugar, severity: 'warning', label: ABNORMAL_THRESHOLDS.bloodSugarLow.label });
      }
    }
    return indicators;
  }

  function evaluateRevisitTrigger(missedCount) {
    if (missedCount < 1) return { action: 'none' };
    if (missedCount === 1) return { action: 'questionnaire' };
    if (missedCount === 2) return { action: 'reminder' };
    return { action: 'report' };
  }

  // ─────────────────────────────────────────────
  await asyncSuite('13. 三层级冲突合并', async () => {
    // 患者层级
    const pBase = { name: '张三', age: 60, riskLevel: 'medium' };
    const pLocal = { ...pBase, age: 61 };
    const pRemote = { ...pBase, riskLevel: 'high' };
    const pResult = threeLevelMerge(pBase, pLocal, pRemote, 'patients');
    assertEqual(pResult.merged.age, 61, '13.1 患者层级：本地 age 保留');
    assertEqual(pResult.merged.riskLevel, 'high', '13.2 患者层级：远程 riskLevel 保留');
    assertEqual(pResult.conflicts.length, 0, '13.3 患者层级：无冲突');

    // 问卷层级
    const vBase = {
      questionnaires: [{ templateId: 'ht_v1', version: 1, answers: { q1: 'A', q2: 'B' } }]
    };
    const vLocal = {
      questionnaires: [{ templateId: 'ht_v1', version: 1, answers: { q1: 'A', q2: 'C' } }]
    };
    const vRemote = {
      questionnaires: [{ templateId: 'ht_v1', version: 2, answers: { q1: 'D', q2: 'B' } }]
    };
    const vResult = threeLevelMerge(vBase, vLocal, vRemote, 'visits');
    assertEqual(vResult.merged.questionnaires.length, 1, '13.4 问卷层级：合并为1');
    assertEqual(vResult.merged.questionnaires[0].version, 2, '13.5 问卷层级：取高版本');
    assertEqual(vResult.merged.questionnaires[0].answers.q2, 'C', '13.6 问卷层级：本地 q2 保留');
    assertEqual(vResult.merged.questionnaires[0].answers.q1, 'D', '13.7 问卷层级：远程 q1 保留');

    // 附件层级
    const aBase = { attachments: [{ id: 'a1', uploadStatus: 'pending', compressedSize: 100 }] };
    const aLocal = {
      attachments: [
        { id: 'a1', uploadStatus: 'pending', compressedSize: 80 },
        { id: 'a2', uploadStatus: 'pending', compressedSize: 90 }
      ]
    };
    const aRemote = {
      attachments: [{ id: 'a1', uploadStatus: 'uploaded', compressedSize: 100 }]
    };
    const aResult = threeLevelMerge(aBase, aLocal, aRemote, 'visits');
    assertEqual(aResult.merged.attachments.length, 2, '13.8 附件层级：合并后2个');
    const mergedA1 = aResult.merged.attachments.find(a => a.id === 'a1');
    assertEqual(mergedA1.uploadStatus, 'uploaded', '13.9 附件层级：远程已上传优先');
  });

  // ─────────────────────────────────────────────
  await asyncSuite('14. 随访计划生成与规则匹配', async () => {
    const DEFAULT_RULES = [
      { id: 'r1', priority: 1, conditions: [{ field: 'riskLevel', operator: 'eq', value: 'high' }], intervalDays: 7 },
      { id: 'r2', priority: 2, conditions: [{ field: 'riskLevel', operator: 'eq', value: 'medium' }], intervalDays: 14 },
      { id: 'r3', priority: 3, conditions: [{ field: 'riskLevel', operator: 'eq', value: 'low' }], intervalDays: 30 }
    ];

    function matchRule(patient, rules) {
      const sorted = [...rules].sort((a, b) => a.priority - b.priority);
      for (const rule of sorted) {
        const match = rule.conditions.every(c => {
          const val = patient[c.field];
          if (c.operator === 'eq') return val === c.value;
          if (c.operator === 'gte') return val >= c.value;
          return true;
        });
        if (match) return rule;
      }
      return null;
    }

    const highP = { riskLevel: 'high', diseases: ['hypertension'] };
    const r1 = matchRule(highP, DEFAULT_RULES);
    assert(r1 !== null, '14.1 高风险匹配到规则');
    assertEqual(r1.intervalDays, 7, '14.2 高风险间隔7天');

    const medP = { riskLevel: 'medium', diseases: [] };
    const r2 = matchRule(medP, DEFAULT_RULES);
    assertEqual(r2.intervalDays, 14, '14.3 中风险间隔14天');

    // 计划日期计算
    const visitDate = '2026-06-01';
    const planDate = Utils.addDays(visitDate, 7);
    assertEqual(planDate, '2026-06-08', '14.4 计划日期=就诊日+间隔');

    // 宽限期
    const dueDate = Utils.addDays(planDate, 3);
    assertEqual(dueDate, '2026-06-11', '14.5 截止日期=计划日+3天宽限');

    // DB CRUD
    const plan = {
      id: 'plan-test-1', patientId: 'p1', planDate: '2026-06-08',
      dueDate: '2026-06-11', status: 'pending', priority: 1
    };
    await DB.savePlan(plan);
    const allPlans = await DB.getAllPlans();
    assert(allPlans.length >= 1, '14.6 计划保存成功');
    const byPatient = await DB.getPlansByPatient('p1');
    assert(byPatient.length >= 1, '14.7 按患者查询计划');
  });

  // ─────────────────────────────────────────────
  await asyncSuite('15. 异常指标检测与补访触发', async () => {
    // 异常检测
    const abnormal = detectAbnormalIndicators({ bpSystolic: 190, bpDiastolic: 115, bloodSugar: 18.0 });
    assert(abnormal.length >= 2, '15.1 检测到至少2个异常');
    const bpHigh = abnormal.find(i => i.field === 'bpSystolic');
    assert(bpHigh !== undefined, '15.2 检测到收缩压异常');
    assertEqual(bpHigh.severity, 'high', '15.3 收缩压异常严重度');

    const normal = detectAbnormalIndicators({ bpSystolic: 120, bpDiastolic: 80, bloodSugar: 5.6 });
    assertEqual(normal.length, 0, '15.4 正常值无异常');

    // 低血糖
    const lowBS = detectAbnormalIndicators({ bloodSugar: 3.5 });
    const lowIndicator = lowBS.find(i => i.field === 'bloodSugar');
    assert(lowIndicator !== undefined, '15.5 检测到低血糖');

    // 补访触发
    const t0 = evaluateRevisitTrigger(0);
    assertEqual(t0.action, 'none', '15.6 0次漏访无补访');
    const t1 = evaluateRevisitTrigger(1);
    assertEqual(t1.action, 'questionnaire', '15.7 1次漏访→问卷');
    const t2 = evaluateRevisitTrigger(2);
    assertEqual(t2.action, 'reminder', '15.8 2次漏访→提醒');
    const t3 = evaluateRevisitTrigger(3);
    assertEqual(t3.action, 'report', '15.9 3次漏访→上报');
    const t5 = evaluateRevisitTrigger(5);
    assertEqual(t5.action, 'report', '15.10 5次漏访→上报');
  });

  // ─────────────────────────────────────────────
  await asyncSuite('16. PIN 切换验证', async () => {
    // PIN 格式校验
    const validPins = ['1234', '0000', '123456'];
    const invalidPins = ['12', '1234567', 'abcd', ''];
    validPins.forEach(pin => {
      const valid = pin.length >= 4 && pin.length <= 6 && /^\d+$/.test(pin);
      assert(valid, `16.x PIN "${pin}" 有效`);
    });
    invalidPins.forEach(pin => {
      const valid = pin.length >= 4 && pin.length <= 6 && /^\d+$/.test(pin);
      assert(!valid, `16.x PIN "${pin}" 无效`);
    });

    // PIN 设置与切换标记
    await DB.setSetting('pin_verify', 'test_pin_hash');
    const pinHash = await DB.getSetting('pin_verify');
    assert(pinHash !== null, '16.4 PIN 验证标记已设置');

    await DB.setSetting('pin_switched', true);
    const switched = await DB.getSetting('pin_switched');
    assertEqual(switched, true, '16.5 PIN 切换标记正确');

    // 自动锁定设置
    await DB.setSetting('autoLockMinutes', '10');
    const lockMinutes = await DB.getSetting('autoLockMinutes');
    assertEqual(lockMinutes, '10', '16.6 自动锁定时间设置正确');
  });

  // ─────────────────────────────────────────────
  await asyncSuite('17. 离线多次编辑 _rev 追踪', async () => {
    await DB.open();
    mockDB.store('patients').clear();
    mockDB.store('sync_queue').clear();

    // 创建患者
    const patient = { id: 'rev-test-1', name: '编辑测试', age: 50, diseases: [], riskLevel: 'low', syncStatus: 'pending' };
    await DB.savePatient(patient);
    let loaded = await DB.loadPatient('rev-test-1');
    assertEqual(loaded._rev, 1, '17.1 创建后 _rev=1');

    // 第一次编辑
    loaded.age = 51;
    await DB.savePatient(loaded);
    loaded = await DB.loadPatient('rev-test-1');
    assertEqual(loaded._rev, 2, '17.2 第一次编辑后 _rev=2');

    // 第二次编辑
    loaded.riskLevel = 'medium';
    await DB.savePatient(loaded);
    loaded = await DB.loadPatient('rev-test-1');
    assertEqual(loaded._rev, 3, '17.3 第二次编辑后 _rev=3');

    // 第三次编辑
    loaded.name = '编辑测试修改';
    await DB.savePatient(loaded);
    loaded = await DB.loadPatient('rev-test-1');
    assertEqual(loaded._rev, 4, '17.4 第三次编辑后 _rev=4');

    // 同步队列应去重为1条
    const queue = await DB.getSyncQueue();
    const forEntity = queue.filter(q => q.entityId === 'rev-test-1');
    assertEqual(forEntity.length, 1, '17.5 多次编辑同步队列仍为1条');
    assertEqual(forEntity[0].action, 'create', '17.6 保留原始 create 动作');
  });

  // ─────────────────────────────────────────────
  await asyncSuite('18. 附件上传失败重试追踪', async () => {
    await DB.open();
    mockDB.store('attachment_queue').clear();

    // 添加附件到队列
    const att = {
      id: 'att-retry-1', visitId: 'v1', attachmentId: 'att-retry-1',
      data: 'data:image/jpeg;base64,test', thumbnail: 'thumb',
      name: 'retry.jpg', compressionState: 'compressed', status: 'pending', retryCount: 0
    };
    await DB.addToAttachmentQueue(att);

    // 模拟第一次上传失败
    await DB.updateAttachmentQueueItem('att-retry-1', {
      status: 'pending', retryCount: 1, lastError: '网络超时'
    });
    let item = (await DB.getAttachmentQueue()).find(i => i.id === 'att-retry-1');
    assertEqual(item.retryCount, 1, '18.1 第一次失败后 retryCount=1');
    assertEqual(item.lastError, '网络超时', '18.2 记录错误信息');

    // 模拟第二次失败
    await DB.updateAttachmentQueueItem('att-retry-1', {
      status: 'pending', retryCount: 2, lastError: '连接被拒'
    });
    item = (await DB.getAttachmentQueue()).find(i => i.id === 'att-retry-1');
    assertEqual(item.retryCount, 2, '18.3 第二次失败后 retryCount=2');

    // 模拟第三次失败 → 标记为 failed
    await DB.updateAttachmentQueueItem('att-retry-1', {
      status: 'failed', retryCount: 3, lastError: '超过最大重试次数'
    });
    item = (await DB.getAttachmentQueue()).find(i => i.id === 'att-retry-1');
    assertEqual(item.status, 'failed', '18.4 超过最大重试后状态为 failed');
    assertEqual(item.retryCount, 3, '18.5 retryCount=3');

    // 手动重试：重置状态
    await DB.updateAttachmentQueueItem('att-retry-1', {
      status: 'pending', retryCount: 0, lastError: null
    });
    item = (await DB.getAttachmentQueue()).find(i => i.id === 'att-retry-1');
    assertEqual(item.status, 'pending', '18.6 手动重置后状态为 pending');
    assertEqual(item.retryCount, 0, '18.7 手动重置后 retryCount=0');
  });

  // ─────────────────────────────────────────────
  await asyncSuite('19. 提醒重排验证', async () => {
    // 风险等级变化后间隔重新计算
    const visitDate = '2026-06-01';

    const lowDate = getNextVisitDate({ diseases: [], riskLevel: 'low' }, 'low', visitDate);
    assertEqual(lowDate, '2026-07-01', '19.1 低风险=30天后');

    const highDate = getNextVisitDate({ diseases: [], riskLevel: 'high' }, 'high', visitDate);
    assertEqual(highDate, '2026-06-08', '19.2 高风险=7天后');

    // 疾病特殊间隔
    const tbDate = getNextVisitDate({ diseases: ['tuberculosis'], riskLevel: 'low' }, 'low', visitDate);
    assertEqual(tbDate, '2026-06-08', '19.3 肺结核强制7天');

    // 多疾病取最短
    const multiDate = getNextVisitDate({ diseases: ['hypertension', 'copd'], riskLevel: 'low' }, 'low', visitDate);
    assertEqual(multiDate, '2026-06-15', '19.4 高血压14天 < 慢阻肺30天');

    // 幂等性
    const d1 = getNextVisitDate({ diseases: ['diabetes'], riskLevel: 'medium' }, 'medium', visitDate);
    const d2 = getNextVisitDate({ diseases: ['diabetes'], riskLevel: 'medium' }, 'medium', visitDate);
    assertEqual(d1, d2, '19.5 幂等性：多次调用结果一致');

    // 风险升级后重新计算
    const beforeUpgrade = getNextVisitDate({ diseases: [], riskLevel: 'low' }, 'low', visitDate);
    const afterUpgrade = getNextVisitDate({ diseases: [], riskLevel: 'high' }, 'high', visitDate);
    assert(beforeUpgrade !== afterUpgrade, '19.6 风险升级后日期变化');
  });

  // ─────────────────────────────────────────────
  summary();
}

// Run
runTests().catch(err => {
  console.error('测试运行器错误:', err);
  process.exit(1);
});
