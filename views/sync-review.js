// 同步审查视图
const SyncReviewView = (() => {
  let _status = null;
  let _queue = [];

  async function render() {
    document.getElementById('page-title').textContent = '数据同步';
    document.getElementById('btn-back').style.display = 'none';
    document.getElementById('bottom-nav').style.display = 'flex';

    _status = await SyncManager.getStatus();
    _queue = await DB.getSyncQueue();
    const conflicts = await DB.getUnresolvedConflicts();

    const container = document.getElementById('view-container');
    container.innerHTML = `
      <div class="card" style="margin:12px">
        <div class="card-title" style="margin-bottom:12px">同步状态</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:14px">
          <div>
            <div style="color:var(--text-hint);font-size:12px">网络状态</div>
            <div style="font-weight:600;color:${_status.online ? 'var(--success)' : 'var(--danger)'}">
              ${_status.online ? '已连接' : '离线'}
            </div>
          </div>
          <div>
            <div style="color:var(--text-hint);font-size:12px">待同步</div>
            <div style="font-weight:600">${_status.pending} 条</div>
          </div>
          <div>
            <div style="color:var(--text-hint);font-size:12px">失败</div>
            <div style="font-weight:600;color:${_status.failed > 0 ? 'var(--danger)' : 'inherit'}">${_status.failed} 条</div>
          </div>
          <div>
            <div style="color:var(--text-hint);font-size:12px">冲突</div>
            <div style="font-weight:600;color:${conflicts.length > 0 ? 'var(--warning)' : 'inherit'}">
              ${conflicts.length} 条
              ${conflicts.length > 0 ? '<a href="#" id="link-conflicts" style="font-size:12px">查看</a>' : ''}
            </div>
          </div>
        </div>
        ${_status.lastSync ? `
          <div style="margin-top:12px;font-size:12px;color:var(--text-hint)">
            上次同步：${Utils.formatDateTime(_status.lastSync)}
          </div>
        ` : ''}
      </div>

      <div style="display:flex;gap:8px;padding:0 12px 12px">
        <button class="btn btn-primary btn-block" id="btn-sync-now" ${!_status.online || _status.syncing ? 'disabled' : ''}>
          ${_status.syncing ? '同步中...' : '立即同步'}
        </button>
        ${_status.syncing ? '<button class="btn btn-danger" id="btn-sync-abort">中止</button>' : ''}
      </div>

      <div id="sync-progress" style="display:none;padding:0 12px 12px">
        <div class="progress-bar" style="height:6px">
          <div class="progress-fill" id="sync-progress-bar" style="width:0%"></div>
        </div>
        <div style="font-size:12px;color:var(--text-secondary);margin-top:4px;text-align:center" id="sync-progress-text"></div>
      </div>

      <div style="padding:0 12px">
        <div class="card-title" style="margin-bottom:8px">同步队列</div>
      </div>

      ${_queue.length === 0 ? `
        <div class="empty-state" style="padding:32px">
          <svg width="48" height="48" viewBox="0 0 24 24"><path fill="currentColor" d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>
          <div class="title">队列为空</div>
          <div class="desc">所有数据已同步</div>
        </div>
      ` : `
        <div id="sync-queue-list">
          ${_queue.map(item => _renderQueueItem(item)).join('')}
        </div>
      `}

      ${_queue.length > 0 ? `
        <div style="padding:12px">
          <button class="btn btn-secondary btn-block btn-sm" id="btn-clear-synced"
            style="color:var(--danger)">清除已同步的本地数据</button>
        </div>
      ` : ''}
    `;

    _bindEvents(conflicts);
    _listenSync();
  }

  function _renderQueueItem(item) {
    const actionLabel = { create: '新建', update: '更新', delete: '删除' };
    const typeLabel = { patients: '患者', visits: '随访' };
    const statusClass = item.lastError ? 'failed' : 'pending';
    const retryInfo = item.retryCount > 0 ? ` · 重试 ${item.retryCount} 次` : '';

    return `
      <div class="sync-item">
        <div class="sync-icon ${statusClass}">
          ${statusClass === 'pending'
            ? '<svg width="18" height="18" viewBox="0 0 24 24"><path fill="currentColor" d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8z"/></svg>'
            : '<svg width="18" height="18" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>'}
        </div>
        <div class="sync-info">
          <div class="title">${typeLabel[item.entityType] || item.entityType} · ${actionLabel[item.action] || item.action}</div>
          <div class="meta">${Utils.formatDateTime(item.createdAt)}${retryInfo}</div>
          ${item.lastError ? `<div class="meta" style="color:var(--danger)">${item.lastError}</div>` : ''}
        </div>
        <div class="sync-status" style="background:${statusClass === 'pending' ? 'var(--primary-light)' : 'var(--danger-light)'};color:${statusClass === 'pending' ? 'var(--primary)' : 'var(--danger)'}">
          ${statusClass === 'pending' ? '待同步' : '失败'}
        </div>
      </div>
    `;
  }

  function _bindEvents(conflicts) {
    document.getElementById('btn-sync-now')?.addEventListener('click', async () => {
      if (!navigator.onLine) {
        Utils.showToast('当前离线，无法同步', 'warning');
        return;
      }
      document.getElementById('sync-progress').style.display = 'block';
      document.getElementById('btn-sync-now').disabled = true;
      document.getElementById('btn-sync-now').textContent = '同步中...';
      await SyncManager.syncAll();
    });

    document.getElementById('btn-sync-abort')?.addEventListener('click', () => {
      SyncManager.abort();
      Utils.showToast('同步已中止', 'info');
    });

    document.getElementById('link-conflicts')?.addEventListener('click', e => {
      e.preventDefault();
      App.navigate('conflict');
    });

    document.getElementById('btn-clear-synced')?.addEventListener('click', async () => {
      const choice = await Utils.showModal(
        '清理数据',
        '<p>此操作将清除本地已同步的患者和随访记录。<br>未同步的数据不会被删除。</p><p style="margin-top:8px;color:var(--danger);font-size:13px">此操作不可撤销！</p>',
        [
          { label: '取消', value: false },
          { label: '确认清理', value: true, primary: false, callback: () => {} }
        ]
      );
      if (!choice) return;

      const db = await DB.open();
      const patients = await DB.getAll(db, 'patients');
      const visits = await DB.getAll(db, 'visits');
      let cleared = 0;

      for (const p of patients) {
        if (p.syncStatus === 'synced') {
          await DB.deleteRecord(db, 'patients', p.id);
          cleared++;
        }
      }
      for (const v of visits) {
        if (v.syncStatus === 'synced') {
          await DB.deleteRecord(db, 'visits', v.id);
          cleared++;
        }
      }

      Utils.showToast(`已清理 ${cleared} 条已同步数据`, 'success');
      render();
    });
  }

  function _listenSync() {
    SyncManager.addListener((event, data) => {
      if (event === 'batch') {
        const text = document.getElementById('sync-progress-text');
        if (text) text.textContent = `批次 ${data.batch}/${data.total}`;
      }
      if (event === 'item-synced') {
        // Remove from list
        const item = document.querySelector(`.sync-item [data-id="${data.itemId}"]`);
        if (item) item.closest('.sync-item')?.remove();
      }
      if (event === 'complete' || event === 'interrupted' || event === 'aborted') {
        render();
      }
    });
  }

  return { render };
})();
