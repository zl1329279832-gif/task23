import { db } from '../core/db.js';
import { STORES } from '../core/config.js';
import { cryptoManager } from '../core/crypto.js';
import { eventBus } from '../core/event-bus.js';

const DATA_STORES = [
  STORES.PATIENTS,
  STORES.FOLLOWUPS,
  STORES.VITAL_SIGNS,
  STORES.ATTACHMENTS
];

const ENCRYPTED_FIELDS_MAP = {
  [STORES.PATIENTS]: ['gender', 'birthDate', 'phone', 'address', 'idCardNumber', 'medicalHistory', 'allergies', 'emergencyContact'],
  [STORES.FOLLOWUPS]: [],
  [STORES.VITAL_SIGNS]: [],
  [STORES.ATTACHMENTS]: []
};

class ExportManager {
  async getExportStats() {
    const stats = {
      totalRecords: 0,
      unsyncedRecords: 0,
      drafts: 0,
      stores: {}
    };

    for (const storeName of DATA_STORES) {
      const records = await db.getAllRaw(storeName);
      const total = records.length;
      const unsynced = records.filter(r => r._syncStatus === 'pending').length;
      stats.stores[storeName] = { total, unsynced };
      stats.totalRecords += total;
      stats.unsyncedRecords += unsynced;
    }

    stats.drafts = await db.count(STORES.DRAFTS);
    return stats;
  }

  async exportUnsynced() {
    const exportData = {
      metadata: {
        exportDate: new Date().toISOString(),
        exportType: 'unsynced',
        deviceInfo: this._getDeviceInfo()
      },
      data: {}
    };

    for (const storeName of DATA_STORES) {
      const encFields = ENCRYPTED_FIELDS_MAP[storeName] || [];
      const records = await db.getAll(storeName, encFields.length > 0 ? encFields : null);
      const unsynced = records.filter(r => r._syncStatus === 'pending');
      if (unsynced.length > 0) {
        exportData.data[storeName] = unsynced;
      }
    }

    const filename = `unsynced_export_${this._dateStamp()}.json`;
    this._triggerDownload(JSON.stringify(exportData, null, 2), filename);
    eventBus.emit('export:complete', { type: 'unsynced', filename });
    return exportData;
  }

  async exportAll() {
    const exportData = {
      metadata: {
        exportDate: new Date().toISOString(),
        exportType: 'full',
        deviceInfo: this._getDeviceInfo()
      },
      data: {}
    };

    for (const storeName of DATA_STORES) {
      const encFields = ENCRYPTED_FIELDS_MAP[storeName] || [];
      const records = await db.getAll(storeName, encFields.length > 0 ? encFields : null);
      if (records.length > 0) {
        exportData.data[storeName] = records;
      }
    }

    const filename = `full_export_${this._dateStamp()}.json`;
    this._triggerDownload(JSON.stringify(exportData, null, 2), filename);
    eventBus.emit('export:complete', { type: 'full', filename });
    return exportData;
  }

  async exportAsCSV(storeName) {
    const encFields = ENCRYPTED_FIELDS_MAP[storeName] || [];
    const records = await db.getAll(storeName, encFields.length > 0 ? encFields : null);

    if (records.length === 0) {
      return '';
    }

    const allKeys = new Set();
    for (const record of records) {
      for (const key of Object.keys(record)) {
        if (!key.startsWith('_encrypted')) {
          allKeys.add(key);
        }
      }
    }

    const headers = Array.from(allKeys).sort();

    const escapeCSV = (val) => {
      if (val === null || val === undefined) return '';
      const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    };

    const lines = [headers.map(escapeCSV).join(',')];
    for (const record of records) {
      const row = headers.map(h => escapeCSV(record[h]));
      lines.push(row.join(','));
    }

    const csv = lines.join('\n');
    const filename = `${storeName}_${this._dateStamp()}.csv`;
    this._triggerDownload(csv, filename, 'text/csv;charset=utf-8');
    eventBus.emit('export:complete', { type: 'csv', storeName, filename });
    return csv;
  }

  _triggerDownload(data, filename, mimeType = 'application/json') {
    const blob = new Blob([data], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  _dateStamp() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${y}${m}${day}_${h}${min}`;
  }

  _getDeviceInfo() {
    return {
      userAgent: navigator.userAgent,
      language: navigator.language,
      platform: navigator.platform,
      timestamp: Date.now()
    };
  }
}

export const exportManager = new ExportManager();
