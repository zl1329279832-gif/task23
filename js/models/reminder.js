import { db } from '../core/db.js';
import { STORES } from '../core/config.js';
import { generateId } from '../utils/uid.js';

const reminderModel = {
  async create(patientId, dueDate, reason, followupId = null) {
    const record = {
      id: generateId(),
      patientId,
      dueDate,
      reason,
      status: 'pending',
      followupId,
      createdAt: Date.now()
    };
    return await db.putRaw(STORES.REMINDERS, record);
  },

  async getById(id) {
    return await db.getRaw(STORES.REMINDERS, id);
  },

  async getPending() {
    return await db.getAllByIndex(STORES.REMINDERS, 'status', 'pending');
  },

  async getByPatient(patientId) {
    return await db.getAllByIndex(STORES.REMINDERS, 'patientId', patientId);
  },

  async getAll() {
    return await db.getAllRaw(STORES.REMINDERS);
  },

  async markCompleted(id) {
    const record = await db.getRaw(STORES.REMINDERS, id);
    if (!record) return null;
    record.status = 'completed';
    record.completedAt = Date.now();
    return await db.putRaw(STORES.REMINDERS, record);
  },

  async dismiss(id) {
    const record = await db.getRaw(STORES.REMINDERS, id);
    if (!record) return null;
    record.status = 'dismissed';
    return await db.putRaw(STORES.REMINDERS, record);
  },

  async deleteReminder(id) {
    return await db.delete(STORES.REMINDERS, id);
  },

  async getPendingCount() {
    return await db.countByIndex(STORES.REMINDERS, 'status', 'pending');
  }
};

export { reminderModel };
