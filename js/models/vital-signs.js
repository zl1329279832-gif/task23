import { db } from '../core/db.js';
import { STORES } from '../core/config.js';
import { generateId } from '../utils/uid.js';
import { eventBus } from '../core/event-bus.js';

const STORE = STORES.VITAL_SIGNS;

const ENCRYPTED_FIELDS = [
  'systolicBP',
  'diastolicBP',
  'heartRate',
  'bloodGlucose',
  'glucoseType',
  'temperature',
  'weight',
  'height',
  'oxygenSaturation',
  'notes'
];

export const vitalSignsModel = {
  async save(followupId, patientId, readings) {
    const record = {
      ...readings,
      id: generateId(),
      followupId,
      patientId,
      measuredAt: Date.now()
    };

    const saved = await db.put(STORE, record, ENCRYPTED_FIELDS);
    eventBus.emit('vitals:saved', saved);
    return saved;
  },

  async getByFollowup(followupId) {
    return db.getAllByIndex(STORE, 'followupId', followupId, ENCRYPTED_FIELDS);
  },

  async getByPatient(patientId) {
    return db.getAllByIndex(STORE, 'patientId', patientId, ENCRYPTED_FIELDS);
  }
};
