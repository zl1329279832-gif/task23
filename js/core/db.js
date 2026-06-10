import { DB_NAME, DB_VERSION, STORES } from './config.js';
import { cryptoManager } from './crypto.js';

class Database {
  constructor() {
    this._db = null;
  }

  async open() {
    if (this._db) return this._db;
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        this._createStores(db);
      };

      request.onsuccess = (e) => {
        this._db = e.target.result;
        resolve(this._db);
      };

      request.onerror = (e) => reject(e.target.error);
    });
  }

  _createStores(db) {
    // patients
    if (!db.objectStoreNames.contains(STORES.PATIENTS)) {
      const s = db.createObjectStore(STORES.PATIENTS, { keyPath: 'id' });
      s.createIndex('name', 'name', { unique: false });
      s.createIndex('diseaseType', 'diseaseType', { unique: false });
      s.createIndex('riskLevel', 'riskLevel', { unique: false });
      s.createIndex('assignedDoctor', 'assignedDoctor', { unique: false });
    }

    // followups
    if (!db.objectStoreNames.contains(STORES.FOLLOWUPS)) {
      const s = db.createObjectStore(STORES.FOLLOWUPS, { keyPath: 'id' });
      s.createIndex('patientId', 'patientId', { unique: false });
      s.createIndex('createdAt', 'createdAt', { unique: false });
      s.createIndex('status', 'status', { unique: false });
      s.createIndex('patientId_createdAt', ['patientId', 'createdAt'], { unique: false });
    }

    // vital_signs
    if (!db.objectStoreNames.contains(STORES.VITAL_SIGNS)) {
      const s = db.createObjectStore(STORES.VITAL_SIGNS, { keyPath: 'id' });
      s.createIndex('followupId', 'followupId', { unique: false });
      s.createIndex('patientId', 'patientId', { unique: false });
      s.createIndex('measuredAt', 'measuredAt', { unique: false });
    }

    // attachments
    if (!db.objectStoreNames.contains(STORES.ATTACHMENTS)) {
      const s = db.createObjectStore(STORES.ATTACHMENTS, { keyPath: 'id' });
      s.createIndex('followupId', 'followupId', { unique: false });
      s.createIndex('patientId', 'patientId', { unique: false });
      s.createIndex('createdAt', 'createdAt', { unique: false });
    }

    // questionnaire_schemas
    if (!db.objectStoreNames.contains(STORES.QUESTIONNAIRE_SCHEMAS)) {
      const s = db.createObjectStore(STORES.QUESTIONNAIRE_SCHEMAS, { keyPath: 'id' });
      s.createIndex('diseaseType', 'diseaseType', { unique: false });
      s.createIndex('version', 'version', { unique: false });
    }

    // sync_queue
    if (!db.objectStoreNames.contains(STORES.SYNC_QUEUE)) {
      const s = db.createObjectStore(STORES.SYNC_QUEUE, { keyPath: 'id' });
      s.createIndex('status', 'status', { unique: false });
      s.createIndex('createdAt', 'createdAt', { unique: false });
      s.createIndex('storeName', 'storeName', { unique: false });
    }

    // drafts
    if (!db.objectStoreNames.contains(STORES.DRAFTS)) {
      const s = db.createObjectStore(STORES.DRAFTS, { keyPath: 'id' });
      s.createIndex('viewName', 'viewName', { unique: false });
      s.createIndex('updatedAt', 'updatedAt', { unique: false });
    }

    // reminders
    if (!db.objectStoreNames.contains(STORES.REMINDERS)) {
      const s = db.createObjectStore(STORES.REMINDERS, { keyPath: 'id' });
      s.createIndex('patientId', 'patientId', { unique: false });
      s.createIndex('dueDate', 'dueDate', { unique: false });
      s.createIndex('status', 'status', { unique: false });
    }

    // corruption_log
    if (!db.objectStoreNames.contains(STORES.CORRUPTION_LOG)) {
      const s = db.createObjectStore(STORES.CORRUPTION_LOG, { keyPath: 'id' });
      s.createIndex('detectedAt', 'detectedAt', { unique: false });
      s.createIndex('storeName', 'storeName', { unique: false });
    }
  }

  async put(storeName, record, encryptedFields = null) {
    const db = await this.open();
    const toStore = { ...record };
    toStore._lastModified = Date.now();

    if (encryptedFields && cryptoManager.isUnlocked) {
      const sensitive = {};
      for (const field of encryptedFields) {
        if (toStore[field] !== undefined) {
          sensitive[field] = toStore[field];
          delete toStore[field];
        }
      }
      if (Object.keys(sensitive).length > 0) {
        toStore._encrypted = await cryptoManager.encrypt(sensitive);
      }
      toStore._checksum = await cryptoManager.computeChecksum(toStore);
    }

    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.put(toStore);
      req.onsuccess = () => resolve(toStore);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async get(storeName, id, encryptedFields = null) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.get(id);
      req.onsuccess = async () => {
        const record = req.result;
        if (!record) { resolve(null); return; }
        resolve(await this._decryptRecord(record, encryptedFields));
      };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async getAll(storeName, encryptedFields = null) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = async () => {
        const records = req.result || [];
        const decrypted = [];
        for (const r of records) {
          decrypted.push(await this._decryptRecord(r, encryptedFields));
        }
        resolve(decrypted);
      };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async getAllByIndex(storeName, indexName, query, encryptedFields = null) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const index = store.index(indexName);
      const req = index.getAll(query);
      req.onsuccess = async () => {
        const records = req.result || [];
        const decrypted = [];
        for (const r of records) {
          decrypted.push(await this._decryptRecord(r, encryptedFields));
        }
        resolve(decrypted);
      };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async delete(storeName, id) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async clear(storeName) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async count(storeName) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async countByIndex(storeName, indexName, query) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const index = store.index(indexName);
      const req = index.count(query);
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async getRaw(storeName, id) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async getAllRaw(storeName) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async putRaw(storeName, record) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.put(record);
      req.onsuccess = () => resolve(record);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async _decryptRecord(record, encryptedFields) {
    if (!record._encrypted || !cryptoManager.isUnlocked || !encryptedFields) {
      return record;
    }
    try {
      const decrypted = await cryptoManager.decrypt(record._encrypted);
      const result = { ...record };
      delete result._encrypted;
      for (const field of encryptedFields) {
        if (decrypted[field] !== undefined) {
          result[field] = decrypted[field];
        }
      }
      return result;
    } catch (e) {
      console.error('Decryption failed for record:', record.id, e);
      return { ...record, _decryptionFailed: true };
    }
  }
}

export const db = new Database();
