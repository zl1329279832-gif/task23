import { exportManager } from '../services/export-manager.js';
import { cleanupManager } from '../services/cleanup-manager.js';
import { integrityChecker } from '../services/integrity-checker.js';
import { router } from '../router.js';
import { toast } from '../components/toast.js';
import { modal } from '../components/modal.js';

const STORE_LABELS = {
  patients: '患者',
  followups: '随访记录',
  vital_signs: '生命体征',
  attachments: '附件',
  sync_queue: '同步队列',
  drafts: '草稿',
  reminders: '提醒',
  corruption_log: '异常日志',
  questionnaire_schemas: '问卷模板'
};

const ExportView = {
  _container: null,

  async render(container) {
    this._container = container;
    container.innerHTML = '<div class="empty-state"><div style="width:36px;height:36px;border:3px solid var(--border);border-top-color:var(--primary);border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 16px;"></div></div>';

    try {
      const [stats, storageSummary, corruptionLog] = await Promise.all([
        exportManager.getExportStats(),
        cleanupManager.getStorageSummary(),
        integrityChecker.getCorruptionLog()
      ]);

      this._renderContent(stats, storageSummary, corruptionLog);
      this._bindEvents(stats);
    } catch (e) {
      container.innerHTML = `<div class="empty-state"><div class="empty-state__text">加载失败: ${e.message}</div></div>`;
    }
  },

  _renderContent(stats, storageSummary, corruptionLog) {
    let html = '';

    html += `
      <div class="patient-stats" style="margin-bottom:16px;">
        <div class="patient-stat-card">
          <div class="patient-stat-card__number">${stats.totalRecords}</div>
          <div class="patient-stat-card__label">总记录数</div>
        </div>
        <div class="patient-stat-card">
          <div class="patient-stat-card__number" style="color:var(--warning);">${stats.unsyncedRecords}</div>
          <div class="patient-stat-card__label">未同步</div>
        </div>
        <div class="patient-stat-card">
          <div class="patient-stat-card__number" style="color:var(--text-secondary);">${stats.drafts}</div>
          <div class="patient-stat-card__label">草稿</div>
        </div>
        <div class="patient-stat-card">
          <div class="patient-stat-card__number" style="color:${corruptionLog.length > 0 ? 'var(--danger)' : 'var(--success)'};">${corruptionLog.length}</div>
          <div class="patient-stat-card__label">异常记录</div>
        </div>
      </div>
    `;

    if (corruptionLog.length > 0) {
      html += `
        <div style="background:var(--danger);color:#fff;padding:12px 16px;border-radius:var(--radius-md);margin-bottom:16px;font-size:14px;">
          &#9888; 发现 ${corruptionLog.length} 条数据完整性异常，建议立即检查
        </div>
      `;
    }

    html += `
      <div class="section-title">数据导出</div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px;">
        <button class="btn btn--primary" id="export-unsynced-btn">
          导出未同步数据
        </button>
        <button class="btn btn--outline" id="export-all-btn">
          导出全部数据
        </button>
      </div>

      <div class="section-title">数据清理</div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px;">
        <div style="display:flex;gap:8px;align-items:center;">
          <button class="btn btn--outline" id="clean-synced-btn" style="flex:1;">
            清理已同步数据
          </button>
          <select id="clean-days-select" style="padding:8px 12px;border:1px solid var(--border);border-radius:var(--radius-md);font-size:14px;">
            <option value="30">30天</option>
            <option value="60">60天</option>
            <option value="90" selected>90天</option>
          </select>
        </div>
        <button class="btn btn--outline" id="clear-drafts-btn">
          清除草稿
        </button>
      </div>

      <div class="section-title">系统维护</div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px;">
        <button class="btn btn--outline" id="integrity-check-btn">
          完整性检查
        </button>
        <button class="btn btn--outline" id="clear-all-btn" style="color:var(--danger);border-color:var(--danger);">
          清除全部数据
        </button>
      </div>

      <div id="integrity-results"></div>

      <div class="section-title">存储概览</div>
      <div style="background:var(--bg-card);border-radius:var(--radius-md);overflow:hidden;box-shadow:var(--shadow-sm);">
    `;

    for (const [store, count] of Object.entries(storageSummary)) {
      if (store === '_total') continue;
      const label = STORE_LABELS[store] || store;
      html += `
        <div style="display:flex;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--border);font-size:14px;">
          <span>${label}</span>
          <span style="color:var(--text-secondary);">${count} 条</span>
        </div>
      `;
    }

    html += `
        <div style="display:flex;justify-content:space-between;padding:10px 16px;font-size:14px;font-weight:600;">
          <span>合计</span>
          <span>${storageSummary._total} 条</span>
        </div>
      </div>
    `;

    this._container.innerHTML = html;
  },

  _bindEvents(stats) {
    const exportUnsyncedBtn = this._container.querySelector('#export-unsynced-btn');
    if (exportUnsyncedBtn) {
      exportUnsyncedBtn.addEventListener('click', async () => {
        try {
          await exportManager.exportUnsynced();
          toast.success('未同步数据导出成功');
        } catch (e) {
          toast.error('导出失败: ' + e.message);
        }
      });
    }

    const exportAllBtn = this._container.querySelector('#export-all-btn');
    if (exportAllBtn) {
      exportAllBtn.addEventListener('click', async () => {
        try {
          await exportManager.exportAll();
          toast.success('全部数据导出成功');
        } catch (e) {
          toast.error('导出失败: ' + e.message);
        }
      });
    }

    const cleanSyncedBtn = this._container.querySelector('#clean-synced-btn');
    if (cleanSyncedBtn) {
      cleanSyncedBtn.addEventListener('click', async () => {
        const select = this._container.querySelector('#clean-days-select');
        const days = parseInt(select.value);
        const confirmed = await modal.confirm(
          '清理已同步数据',
          `确定要删除 ${days} 天前已同步的本地数据吗？此操作不可撤销。`
        );
        if (confirmed) {
          try {
            const result = await cleanupManager.cleanSynced(days);
            toast.success(`已清理 ${result.totalDeleted} 条记录`);
            this.render(this._container);
          } catch (e) {
            toast.error('清理失败: ' + e.message);
          }
        }
      });
    }

    const clearDraftsBtn = this._container.querySelector('#clear-drafts-btn');
    if (clearDraftsBtn) {
      clearDraftsBtn.addEventListener('click', async () => {
        const confirmed = await modal.confirm('清除草稿', '确定要清除所有草稿吗？此操作不可撤销。');
        if (confirmed) {
          try {
            await cleanupManager.clearDrafts();
            toast.success('草稿已清除');
            this.render(this._container);
          } catch (e) {
            toast.error('清除失败: ' + e.message);
          }
        }
      });
    }

    const integrityBtn = this._container.querySelector('#integrity-check-btn');
    if (integrityBtn) {
      integrityBtn.addEventListener('click', async () => {
        integrityBtn.disabled = true;
        integrityBtn.textContent = '检查中...';
        try {
          const results = await integrityChecker.checkAll();
          this._showIntegrityResults(results);
          if (results.totalCorrupted > 0) {
            toast.warning(`发现 ${results.totalCorrupted} 条异常记录`);
          } else {
            toast.success('数据完整性检查通过');
          }
        } catch (e) {
          toast.error('检查失败: ' + e.message);
        }
        integrityBtn.disabled = false;
        integrityBtn.textContent = '完整性检查';
      });
    }

    const clearAllBtn = this._container.querySelector('#clear-all-btn');
    if (clearAllBtn) {
      clearAllBtn.addEventListener('click', async () => {
        const first = await modal.confirm(
          '清除全部数据',
          '即将删除所有本地数据，包括未同步的记录。此操作不可撤销！'
        );
        if (!first) return;

        const second = await modal.confirm(
          '再次确认',
          '真的要删除全部数据吗？所有患者、随访、附件等数据都将永久丢失。'
        );
        if (!second) return;

        try {
          await cleanupManager.clearAllData(true);
          toast.success('全部数据已清除');
          this.render(this._container);
        } catch (e) {
          toast.error('清除失败: ' + e.message);
        }
      });
    }
  },

  _showIntegrityResults(results) {
    const el = this._container.querySelector('#integrity-results');
    if (!el) return;

    let html = `
      <div style="background:var(--bg-card);border-radius:var(--radius-md);padding:16px;margin-bottom:16px;box-shadow:var(--shadow-sm);">
        <div style="font-weight:600;margin-bottom:8px;">检查结果</div>
        <div style="font-size:14px;margin-bottom:4px;">总检查: ${results.totalChecked} 条</div>
        <div style="font-size:14px;color:${results.totalCorrupted > 0 ? 'var(--danger)' : 'var(--success)'};">
          异常: ${results.totalCorrupted} 条
        </div>
    `;

    for (const [store, result] of Object.entries(results.stores)) {
      const label = STORE_LABELS[store] || store;
      const color = result.corrupted > 0 ? 'var(--danger)' : 'var(--success)';
      html += `
        <div style="display:flex;justify-content:space-between;font-size:13px;padding:4px 0;border-top:1px solid var(--border);margin-top:4px;">
          <span>${label}</span>
          <span style="color:${color};">${result.checked} 检查 / ${result.corrupted} 异常</span>
        </div>
      `;
    }

    html += '</div>';
    el.innerHTML = html;
  },

  destroy() {
    this._container = null;
  }
};

export default ExportView;
