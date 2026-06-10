import { db } from '../core/db.js';
import { STORES, DUPLICATE_WINDOW_DAYS } from '../core/config.js';
import { formatDateTime } from '../utils/date.js';

const STORE = STORES.FOLLOWUPS;

const STATUS_LABELS = {
  draft: '草稿',
  complete: '已完成'
};

export const duplicateDetector = {
  async check(patientId, windowDays = DUPLICATE_WINDOW_DAYS) {
    const now = Date.now();
    const cutoff = now - windowDays * 24 * 60 * 60 * 1000;
    const range = IDBKeyRange.bound(
      [patientId, cutoff],
      [patientId, now]
    );

    const records = await db.getAllByIndex(
      STORE, 'patientId_createdAt', range
    );

    if (records.length === 0) {
      return {
        isDuplicate: false,
        existing: [],
        message: ''
      };
    }

    const existing = records.map(r => ({
      id: r.id,
      createdAt: r.createdAt,
      status: r.status
    }));

    const latest = existing.reduce((a, b) =>
      (a.createdAt || 0) > (b.createdAt || 0) ? a : b
    );
    const dateStr = formatDateTime(latest.createdAt);
    const statusLabel = STATUS_LABELS[latest.status] || latest.status;

    return {
      isDuplicate: true,
      existing,
      message: `该患者在 ${windowDays} 天内已有 ${existing.length} 条随访记录，最近一次：${dateStr}（${statusLabel}）`
    };
  }
};
