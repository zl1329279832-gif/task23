import { db } from '../core/db.js';
import { STORES } from '../core/config.js';
import { generateId } from '../utils/uid.js';
import { eventBus } from '../core/event-bus.js';

const STORE = STORES.FOLLOWUPS;
const SYNC_STORE = STORES.SYNC_QUEUE;

const ENCRYPTED_FIELDS = [
  'answers',
  'notes',
  'doctorId',
  'riskAssessment',
  'completedAt'
];

export const followupModel = {
  async create(patientId, data = {}) {
    const record = {
      ...data,
      id: generateId(),
      patientId,
      createdAt: Date.now(),
      status: 'draft',
      answers: data.answers || null,
      notes: data.notes || '',
      doctorId: data.doctorId || null,
      riskAssessment: data.riskAssessment || null,
      completedAt: null,
      _version: 1,
      _syncStatus: 'pending'
    };

    const saved = await db.put(STORE, record, ENCRYPTED_FIELDS);
    eventBus.emit('followup:created', saved);
    return saved;
  },

  async update(id, data) {
    const existing = await this.getById(id);
    if (!existing) throw new Error(`Followup not found: ${id}`);

    const record = { ...existing, ...data };
    record.id = id;
    record._version = (existing._version || 0) + 1;
    record._syncStatus = 'pending';
    record.updatedAt = Date.now();

    const saved = await db.put(STORE, record, ENCRYPTED_FIELDS);
    eventBus.emit('followup:updated', saved);
    return saved;
  },

  async complete(id) {
    const existing = await this.getById(id);
    if (!existing) throw new Error(`Followup not found: ${id}`);

    const record = { ...existing };
    record.status = 'complete';
    record.completedAt = Date.now();
    record._version = (existing._version || 0) + 1;
    record._syncStatus = 'pending';
    record.updatedAt = Date.now();

    const saved = await db.put(STORE, record, ENCRYPTED_FIELDS);
    eventBus.emit('followup:completed', saved);
    return saved;
  },

  async getById(id) {
    return db.get(STORE, id, ENCRYPTED_FIELDS);
  },

  async getByPatient(patientId) {
    const records = await db.getAllByIndex(
      STORE, 'patientId', patientId, ENCRYPTED_FIELDS
    );
    records.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return records;
  },

  async getRecent(patientId, days) {
    const now = Date.now();
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    const range = IDBKeyRange.bound(
      [patientId, cutoff],
      [patientId, now]
    );
    const records = await db.getAllByIndex(
      STORE, 'patientId_createdAt', range, ENCRYPTED_FIELDS
    );
    records.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return records;
  },

  async enqueueSync(followupId, opType) {
    const entry = {
      id: generateId(),
      storeName: STORE,
      recordId: followupId,
      opType,
      status: 'pending',
      retries: 0,
      createdAt: Date.now()
    };
    await db.put(SYNC_STORE, entry);
    eventBus.emit('sync:enqueued', entry);
    return entry;
  }
};
