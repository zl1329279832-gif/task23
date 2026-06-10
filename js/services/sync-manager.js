import { db } from '../core/db.js';
import { STORES, SYNC } from '../core/config.js';
import { generateId } from '../utils/uid.js';
import { eventBus } from '../core/event-bus.js';
import { debounce } from '../utils/debounce.js';

const DATA_STORES = [
  STORES.PATIENTS,
  STORES.FOLLOWUPS,
  STORES.VITAL_SIGNS,
  STORES.ATTACHMENTS
];

class SyncManager {
  constructor() {
    this._processing = false;
    this._debouncedProcess = debounce(() => this.processQueue(), SYNC.ONLINE_DEBOUNCE);

    eventBus.on('network:online', () => {
      this._debouncedProcess();
    });

    this.resetInterrupted();
  }

  async enqueue(operationType, storeName, recordId, payload) {
    const item = {
      id: generateId(),
      operationType,
      storeName,
      recordId,
      payload,
      status: 'pending',
      retryCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    await db.putRaw(STORES.SYNC_QUEUE, item);
    eventBus.emit('sync:enqueued', item);
    return item;
  }

  async processQueue() {
    if (this._processing) return;
    if (!navigator.onLine) return;

    this._processing = true;
    eventBus.emit('sync:start');

    try {
      const items = await this.getQueueItems();
      const actionable = items.filter(i => i.status === 'pending' || i.status === 'failed');

      for (const item of actionable) {
        if (!navigator.onLine) break;

        if (item.retryCount > SYNC.MAX_RETRIES) {
          item.status = 'dead_letter';
          item.updatedAt = Date.now();
          await db.putRaw(STORES.SYNC_QUEUE, item);
          eventBus.emit('sync:dead_letter', item);
          continue;
        }

        if (item.status === 'failed') {
          const delay = Math.min(
            Math.pow(2, item.retryCount) * SYNC.BASE_DELAY,
            SYNC.MAX_DELAY
          );
          const elapsed = Date.now() - item.updatedAt;
          if (elapsed < delay) continue;
        }

        item.status = 'in_progress';
        item.updatedAt = Date.now();
        await db.putRaw(STORES.SYNC_QUEUE, item);
        eventBus.emit('sync:item_progress', item);

        try {
          const response = await this._simulateSync(item);

          if (response.status === 200) {
            item.status = 'completed';
            item.updatedAt = Date.now();
            await db.putRaw(STORES.SYNC_QUEUE, item);

            await this._updateLocalSyncStatus(item, 'synced', response.newVersion);
            eventBus.emit('sync:item_completed', item);
          } else if (response.status === 409) {
            item.status = 'conflict';
            item.serverRecord = response.serverRecord;
            item.updatedAt = Date.now();
            await db.putRaw(STORES.SYNC_QUEUE, item);
            eventBus.emit('sync:conflict', item);
          }
        } catch (err) {
          item.status = 'failed';
          item.retryCount += 1;
          item.lastError = err.message;
          item.updatedAt = Date.now();
          await db.putRaw(STORES.SYNC_QUEUE, item);
          eventBus.emit('sync:item_failed', item);
        }
      }
    } finally {
      this._processing = false;
      eventBus.emit('sync:complete');
    }
  }

  async _simulateSync(item) {
    await new Promise(r => setTimeout(r, 200 + Math.random() * 300));

    const isConflict = Math.random() < 0.1;

    if (isConflict) {
      const localRecord = await db.getRaw(item.storeName, item.recordId);
      const serverRecord = localRecord ? { ...localRecord } : { ...item.payload };

      const editableKeys = Object.keys(serverRecord).filter(
        k => !k.startsWith('_') && k !== 'id' && k !== 'createdAt'
      );

      if (editableKeys.length > 0) {
        const randomKey = editableKeys[Math.floor(Math.random() * editableKeys.length)];
        const val = serverRecord[randomKey];
        if (typeof val === 'string') {
          serverRecord[randomKey] = val + ' (服务器修改)';
        } else if (typeof val === 'number') {
          serverRecord[randomKey] = val + 1;
        } else {
          serverRecord[randomKey] = '服务器修改值';
        }
      }

      serverRecord._version = (serverRecord._version || 0) + 1;
      serverRecord._lastModified = Date.now();

      return { status: 409, serverRecord };
    }

    return {
      status: 200,
      newVersion: (item.payload?._version || 0) + 1
    };
  }

  async _updateLocalSyncStatus(item, syncStatus, newVersion) {
    if (!DATA_STORES.includes(item.storeName)) return;

    const record = await db.getRaw(item.storeName, item.recordId);
    if (record) {
      record._syncStatus = syncStatus;
      record._version = newVersion;
      record._lastModified = Date.now();
      await db.putRaw(item.storeName, record);
    }
  }

  async getQueueItems() {
    const items = await db.getAllRaw(STORES.SYNC_QUEUE);
    return items.sort((a, b) => a.createdAt - b.createdAt);
  }

  async getConflicts() {
    return db.getAllByIndex(STORES.SYNC_QUEUE, 'status', 'conflict');
  }

  async getPendingCount() {
    return db.countByIndex(STORES.SYNC_QUEUE, 'status', 'pending');
  }

  async resolveConflict(queueItemId, mergedRecord) {
    const item = await db.getRaw(STORES.SYNC_QUEUE, queueItemId);
    if (!item) throw new Error('Queue item not found');

    mergedRecord._version = (mergedRecord._version || 0) + 1;
    mergedRecord._syncStatus = 'pending';
    mergedRecord._lastModified = Date.now();

    await db.putRaw(item.storeName, mergedRecord);

    await db.delete(STORES.SYNC_QUEUE, queueItemId);

    await this.enqueue(item.operationType, item.storeName, item.recordId, mergedRecord);

    eventBus.emit('sync:conflict_resolved', { queueItemId, mergedRecord });
  }

  async clearCompleted() {
    const items = await db.getAllRaw(STORES.SYNC_QUEUE);
    const completed = items.filter(i => i.status === 'completed');
    for (const item of completed) {
      await db.delete(STORES.SYNC_QUEUE, item.id);
    }
    eventBus.emit('sync:cleared', { count: completed.length });
    return completed.length;
  }

  async resetInterrupted() {
    try {
      const items = await db.getAllRaw(STORES.SYNC_QUEUE);
      const interrupted = items.filter(i => i.status === 'in_progress');
      for (const item of interrupted) {
        item.status = 'pending';
        item.updatedAt = Date.now();
        await db.putRaw(STORES.SYNC_QUEUE, item);
      }
      if (interrupted.length > 0) {
        eventBus.emit('sync:reset_interrupted', { count: interrupted.length });
      }
    } catch (e) {
      console.error('Failed to reset interrupted sync items:', e);
    }
  }
}

export const syncManager = new SyncManager();
