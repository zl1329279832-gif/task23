import { db } from '../core/db.js';
import { STORES, RISK_LEVELS, DISEASE_TYPES } from '../core/config.js';
import { generateId } from '../utils/uid.js';
import { eventBus } from '../core/event-bus.js';

const STORE = STORES.PATIENTS;

const SENSITIVE_FIELDS = [
  'gender',
  'birthDate',
  'idCardNumber',
  'phone',
  'address',
  'medicalHistory',
  'allergies',
  'emergencyContact'
];

export const patientModel = {
  async getAll() {
    return db.getAll(STORE, SENSITIVE_FIELDS);
  },

  async getById(id) {
    return db.get(STORE, id, SENSITIVE_FIELDS);
  },

  async search(term) {
    if (!term || !term.trim()) {
      return this.getAll();
    }
    const keyword = term.trim().toLowerCase();
    const patients = await db.getAllByIndex(STORE, 'name', undefined, SENSITIVE_FIELDS);
    return patients.filter(p => p.name && p.name.toLowerCase().includes(keyword));
  },

  async save(patient) {
    const record = { ...patient };
    if (!record.id) {
      record.id = generateId();
      record.createdAt = Date.now();
    }
    record.updatedAt = Date.now();
    const saved = await db.put(STORE, record, SENSITIVE_FIELDS);
    eventBus.emit('patient:saved', saved);
    return saved;
  },

  async updateRiskLevel(id, level) {
    const patient = await this.getById(id);
    if (!patient) throw new Error(`Patient not found: ${id}`);
    patient.riskLevel = level;
    const saved = await this.save(patient);
    eventBus.emit('patient:riskUpdated', { id, level });
    return saved;
  },

  async getByDiseaseType(type) {
    return db.getAllByIndex(STORE, 'diseaseType', type, SENSITIVE_FIELDS);
  },

  async getStats() {
    const total = await db.count(STORE);

    const riskCounts = {};
    for (const r of RISK_LEVELS) {
      riskCounts[r.level] = await db.countByIndex(STORE, 'riskLevel', r.level);
    }

    const diseaseCounts = {};
    for (const d of DISEASE_TYPES) {
      diseaseCounts[d.value] = await db.countByIndex(STORE, 'diseaseType', d.value);
    }

    return { total, riskCounts, diseaseCounts };
  }
};
