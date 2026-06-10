import { db } from '../core/db.js';
import { STORES, INTEGRITY_CHECK_INTERVAL } from '../core/config.js';
import { cryptoManager } from '../core/crypto.js';
import { generateId } from '../utils/uid.js';
import { eventBus } from '../core/event-bus.js';

const DATA_STORES = [
  STORES.PATIENTS,
  STORES.FOLLOWUPS,
  STORES.VITAL_SIGNS,
  STORES.ATTACHMENTS
];

class IntegrityChecker {
  constructor() {
    this._intervalId = null;
  }

  async checkAll() {
    const results = {
      totalChecked: 0,
      totalCorrupted: 0,
      stores: {}
    };

    for (const storeName of DATA_STORES) {
      const storeResult = await this.checkStore(storeName);
      results.stores[storeName] = storeResult;
      results.totalChecked += storeResult.checked;
      results.totalCorrupted += storeResult.corrupted;
    }

    eventBus.emit('integrity:check_complete', results);
    return results;
  }

  async checkStore(storeName) {
    const result = {
      checked: 0,
      corrupted: 0,
      errors: []
    };

    if (!cryptoManager.isUnlocked) {
      return result;
    }

    try {
      const records = await db.getAllRaw(storeName);

      for (const record of records) {
        result.checked++;

        if (!record._checksum) continue;

        try {
          const isValid = await cryptoManager.verifyChecksum(record);

          if (!isValid) {
            result.corrupted++;
            const logEntry = {
              id: generateId(),
              storeName,
              recordId: record.id,
              detectedAt: Date.now(),
              expectedChecksum: record._checksum,
              details: 'Checksum mismatch detected'
            };
            await db.putRaw(STORES.CORRUPTION_LOG, logEntry);
            result.errors.push(logEntry);
          }
        } catch (err) {
          result.corrupted++;
          const logEntry = {
            id: generateId(),
            storeName,
            recordId: record.id,
            detectedAt: Date.now(),
            details: `Verification error: ${err.message}`
          };
          await db.putRaw(STORES.CORRUPTION_LOG, logEntry);
          result.errors.push(logEntry);
        }
      }
    } catch (err) {
      console.error(`Integrity check failed for store ${storeName}:`, err);
    }

    return result;
  }

  async getCorruptionLog() {
    return db.getAllRaw(STORES.CORRUPTION_LOG);
  }

  async clearLog() {
    await db.clear(STORES.CORRUPTION_LOG);
    eventBus.emit('integrity:log_cleared');
  }

  startPeriodicCheck(intervalMs = INTEGRITY_CHECK_INTERVAL) {
    this.stopPeriodicCheck();
    this._intervalId = setInterval(() => this.checkAll(), intervalMs);
  }

  stopPeriodicCheck() {
    if (this._intervalId !== null) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
  }
}

export const integrityChecker = new IntegrityChecker();
