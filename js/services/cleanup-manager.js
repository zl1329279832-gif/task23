import { db } from '../core/db.js';
import { STORES } from '../core/config.js';
import { eventBus } from '../core/event-bus.js';

const DATA_STORES = [
  STORES.PATIENTS,
  STORES.FOLLOWUPS,
  STORES.VITAL_SIGNS,
  STORES.ATTACHMENTS
];

class CleanupManager {
  async cleanSynced(olderThanDays = 90) {
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    let totalDeleted = 0;
    const summary = {};

    for (const storeName of DATA_STORES) {
      const records = await db.getAllRaw(storeName);
      let storeDeleted = 0;

      for (const record of records) {
        if (
          record._syncStatus === 'synced' &&
          record._lastModified &&
          record._lastModified < cutoff
        ) {
          await db.delete(storeName, record.id);
          storeDeleted++;
        }
      }

      summary[storeName] = storeDeleted;
      totalDeleted += storeDeleted;
    }

    eventBus.emit('cleanup:synced', { totalDeleted, summary, olderThanDays });
    return { totalDeleted, summary };
  }

  async clearSyncQueue() {
    const items = await db.getAllRaw(STORES.SYNC_QUEUE);
    let cleared = 0;

    for (const item of items) {
      if (item.status === 'completed' || item.status === 'dead_letter') {
        await db.delete(STORES.SYNC_QUEUE, item.id);
        cleared++;
      }
    }

    eventBus.emit('cleanup:sync_queue', { cleared });
    return cleared;
  }

  async clearAllData(confirmed = false) {
    if (!confirmed) {
      throw new Error('Must pass confirmed=true to clear all data');
    }

    const allStores = [
      STORES.PATIENTS,
      STORES.FOLLOWUPS,
      STORES.VITAL_SIGNS,
      STORES.ATTACHMENTS,
      STORES.SYNC_QUEUE,
      STORES.DRAFTS,
      STORES.REMINDERS,
      STORES.CORRUPTION_LOG,
      STORES.QUESTIONNAIRE_SCHEMAS
    ];

    for (const storeName of allStores) {
      await db.clear(storeName);
    }

    eventBus.emit('cleanup:all_data');
  }

  async clearDrafts() {
    await db.clear(STORES.DRAFTS);
    eventBus.emit('cleanup:drafts');
  }

  async getStorageSummary() {
    const summary = {};
    const storeNames = [
      STORES.PATIENTS,
      STORES.FOLLOWUPS,
      STORES.VITAL_SIGNS,
      STORES.ATTACHMENTS,
      STORES.SYNC_QUEUE,
      STORES.DRAFTS,
      STORES.REMINDERS,
      STORES.CORRUPTION_LOG,
      STORES.QUESTIONNAIRE_SCHEMAS
    ];

    let totalCount = 0;
    for (const storeName of storeNames) {
      const count = await db.count(storeName);
      summary[storeName] = count;
      totalCount += count;
    }

    summary._total = totalCount;
    return summary;
  }
}

export const cleanupManager = new CleanupManager();
