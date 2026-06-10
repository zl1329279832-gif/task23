import { syncManager } from '../services/sync-manager.js';
import { formatRelative } from '../utils/date.js';
import { router } from '../router.js';
import { toast } from '../components/toast.js';
import { eventBus } from '../core/event-bus.js';

const OP_ICONS = {
  create: '&#43;',
  update: '&#9998;',
  delete: '&#128465;'
};

const STATUS_LABELS = {
  pending: '待处理',
  in_progress: '同步中',
  failed: '失败',
  conflict: '冲突',
  completed: '已完成',
  dead_letter: '已放弃'
};

const STATUS_COLORS = {
  pending: 'var(--text-secondary)',
  in_progress: 'var(--primary)',
  failed: 'var(--danger)',
  conflict: 'var(--warning)',
  completed: 'var(--success)',
  dead_letter: 'var(--text-disabled, #999)'
};

const SyncStatusView = {
  _container: null,
  _unsubs: [],

  async render(container) {
    this._container = container;
    this._bindSyncEvents();
    await this._refresh();
  },

  _bindSyncEvents() {
    const events = [
      'sync:start', 'sync:complete', 'sync:enqueued',
      'sync:item_completed', 'sync:item_failed',
      'sync:conflict', 'sync:cleared', 'sync:conflict_resolved'
    ];
    for (const evt of events) {
      const unsub = eventBus.on(evt, () => this._refresh());
      this._unsubs.push(unsub);
    }

    const onlineHandler = () => this._refresh();
    window.addEventListener('online', onlineHandler);
    window.addEventListener('offline', onlineHandler);
    this._unsubs.push(() => {
      window.removeEventListener('online', onlineHandler);
      window.removeEventListener('offline', onlineHandler);
    });
  },

  async _refresh() {
    if (!this._container) return;

    try {
      const items = await syncManager.getQueueItems();
      const counts = { pending: 0, in_progress: 0, failed: 0, conflict: 0, completed: 0, dead_letter: 0 };
      for (const item of items) {
        if (counts[item.status] !== undefined) counts[item.status]++;
      }

      this._renderContent(items, counts);
      this._bindActions();
    } catch (e) {
      this._container.innerHTML = `<div class="empty-state"><div class="empty-state__text">加载失败: ${e.message}</div></div>`;
    }
  },

  _renderContent(items, counts) {
    const isOnline = navigator.onLine;

    let html = `
      <div style="display:flex;align-items:center;gap:8px;padding:12px 16px;margin-bottom:16px;background:${isOnline ? 'var(--success)' : 'var(--danger)'};color:#fff;border-radius:var(--radius-md);">
        <span style="width:10px;height:10px;border-radius:50%;background:#fff;display:inline-block;opacity:${isOnline ? '1' : '0.7'};"></span>
        <span style="font-size:14px;font-weight:500;">${isOnline ? '在线' : '离线'}</span>
      </div>

      <div class="patient-stats" style="margin-bottom:16px;">
        <div class="patient-stat-card">
          <div class="patient-stat-card__number" style="color:var(--text-secondary);">${counts.pending}</div>
          <div class="patient-stat-card__label">待处理</div>
        </div>
        <div class="patient-stat-card">
          <div class="patient-stat-card__number" style="color:var(--primary);">${counts.in_progress}</div>
          <div class="patient-stat-card__label">同步中</div>
        </div>
        <div class="patient-stat-card">
          <div class="patient-stat-card__number" style="color:var(--danger);">${counts.failed}</div>
          <div class="patient-stat-card__label">失败</div>
        </div>
        <div class="patient-stat-card">
          <div class="patient-stat-card__number" style="color:var(--warning);">${counts.conflict}</div>
          <div class="patient-stat-card__label">冲突</div>
        </div>
        <div class="patient-stat-card">
          <div class="patient-stat-card__number" style="color:var(--success);">${counts.completed}</div>
          <div class="patient-stat-card__label">已完成</div>
        </div>
      </div>

      <div style="display:flex;gap:8px;margin-bottom:16px;">
        <button class="btn btn--primary" id="sync-now-btn" ${!isOnline ? 'disabled' : ''} style="flex:1;">立即同步</button>
        <button class="btn btn--outline" id="clear-completed-btn" ${counts.completed === 0 ? 'disabled' : ''} style="flex:1;">清理已完成</button>
      </div>
    `;

    if (items.length === 0) {
      html += '<div class="empty-state"><div class="empty-state__icon">&#128230;</div><div class="empty-state__text">同步队列为空</div></div>';
    } else {
      html += '<div class="section-title">队列详情</div>';
      for (const item of items) {
        const icon = OP_ICONS[item.operationType] || '&#8226;';
        const statusLabel = STATUS_LABELS[item.status] || item.status;
        const statusColor = STATUS_COLORS[item.status] || 'var(--text-secondary)';
        const isConflict = item.status === 'conflict';

        html += `
          <div style="background:var(--bg-card);border-radius:var(--radius-md);padding:12px 16px;margin-bottom:8px;box-shadow:var(--shadow-sm);${isConflict ? 'border-left:3px solid var(--warning);' : ''}">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
              <span style="font-size:16px;">${icon}</span>
              <span style="font-weight:500;font-size:14px;flex:1;">${item.storeName}</span>
              <span style="font-size:12px;padding:2px 8px;border-radius:10px;background:${statusColor};color:#fff;">${statusLabel}</span>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-secondary);">
              <span>${item.operationType} - ${item.recordId ? item.recordId.slice(0, 8) : 'N/A'}</span>
              <span>${formatRelative(item.createdAt)}</span>
            </div>
            ${item.retryCount > 0 ? `<div style="font-size:12px;color:var(--danger);margin-top:4px;">重试次数: ${item.retryCount}</div>` : ''}
            ${item.lastError ? `<div style="font-size:12px;color:var(--danger);margin-top:2px;">错误: ${item.lastError}</div>` : ''}
            ${isConflict ? `<button class="btn btn--sm btn--outline resolve-conflict-btn" data-id="${item.recordId}" data-queue-id="${item.id}" style="margin-top:8px;color:var(--warning);border-color:var(--warning);">解决冲突</button>` : ''}
          </div>
        `;
      }
    }

    this._container.innerHTML = html;
  },

  _bindActions() {
    const syncBtn = this._container.querySelector('#sync-now-btn');
    if (syncBtn) {
      syncBtn.addEventListener('click', async () => {
        syncBtn.disabled = true;
        syncBtn.textContent = '同步中...';
        try {
          await syncManager.processQueue();
          toast.success('同步完成');
        } catch (e) {
          toast.error('同步失败: ' + e.message);
        }
      });
    }

    const clearBtn = this._container.querySelector('#clear-completed-btn');
    if (clearBtn) {
      clearBtn.addEventListener('click', async () => {
        const count = await syncManager.clearCompleted();
        toast.success(`已清理 ${count} 条完成记录`);
      });
    }

    const conflictBtns = this._container.querySelectorAll('.resolve-conflict-btn');
    for (const btn of conflictBtns) {
      btn.addEventListener('click', () => {
        const queueId = btn.dataset.queueId;
        router.navigate(`/conflict/${queueId}`);
      });
    }
  },

  destroy() {
    for (const unsub of this._unsubs) {
      if (typeof unsub === 'function') unsub();
    }
    this._unsubs = [];
    this._container = null;
  }
};

export default SyncStatusView;
