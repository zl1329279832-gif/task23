import { db } from '../core/db.js';
import { STORES } from '../core/config.js';
import { syncManager } from '../services/sync-manager.js';
import { router } from '../router.js';
import { toast } from '../components/toast.js';
import { eventBus } from '../core/event-bus.js';

const INTERNAL_FIELDS = ['_checksum', '_encrypted', '_lastModified', '_syncStatus', '_version', '_decryptionFailed'];

const ConflictResolverView = {
  _container: null,
  _queueItem: null,
  _localRecord: null,
  _serverRecord: null,
  _mergedRecord: null,
  _conflictFields: [],
  _autoResolvedFields: [],
  _selections: {},

  async render(container, params) {
    this._container = container;
    const queueId = params.recordId || params.queueId;

    container.innerHTML = '<div class="empty-state"><div style="width:36px;height:36px;border:3px solid var(--border);border-top-color:var(--primary);border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 16px;"></div></div>';

    try {
      this._queueItem = await db.getRaw(STORES.SYNC_QUEUE, queueId);
      if (!this._queueItem || this._queueItem.status !== 'conflict') {
        container.innerHTML = '<div class="empty-state"><div class="empty-state__text">未找到冲突记录或已解决</div></div>';
        return;
      }

      this._localRecord = await db.getRaw(this._queueItem.storeName, this._queueItem.recordId);
      this._serverRecord = this._queueItem.serverRecord;

      if (!this._localRecord || !this._serverRecord) {
        container.innerHTML = '<div class="empty-state"><div class="empty-state__text">无法加载冲突数据</div></div>';
        return;
      }

      this._analyzeConflicts();
      this._renderConflictView();
      this._bindEvents();
    } catch (e) {
      container.innerHTML = `<div class="empty-state"><div class="empty-state__text">加载失败: ${e.message}</div></div>`;
    }
  },

  _analyzeConflicts() {
    const allKeys = new Set([
      ...Object.keys(this._localRecord),
      ...Object.keys(this._serverRecord)
    ]);

    this._conflictFields = [];
    this._autoResolvedFields = [];
    this._mergedRecord = { ...this._localRecord };
    this._selections = {};

    for (const key of allKeys) {
      if (INTERNAL_FIELDS.includes(key) || key === 'id' || key === 'createdAt') continue;

      const localVal = this._localRecord[key];
      const serverVal = this._serverRecord[key];
      const localStr = JSON.stringify(localVal);
      const serverStr = JSON.stringify(serverVal);

      if (localStr === serverStr) {
        this._autoResolvedFields.push(key);
      } else {
        this._conflictFields.push(key);
        this._selections[key] = 'local';
      }
    }
  },

  _renderConflictView() {
    let html = `
      <div class="conflict-view">
        <div class="conflict-header">
          <div class="conflict-header__icon">&#9888;</div>
          <div class="conflict-header__text">
            <h2>数据冲突</h2>
            <p>${this._queueItem.storeName} - ${this._queueItem.recordId.slice(0, 8)}</p>
          </div>
        </div>
    `;

    if (this._autoResolvedFields.length > 0) {
      html += `
        <div class="auto-resolved">
          &#10003; ${this._autoResolvedFields.length} 个字段自动合并（值相同）：${this._autoResolvedFields.join('、')}
        </div>
      `;
    }

    if (this._conflictFields.length === 0) {
      html += '<div class="auto-resolved">所有字段一致，无需手动解决</div>';
    } else {
      for (const field of this._conflictFields) {
        const localVal = this._formatValue(this._localRecord[field]);
        const serverVal = this._formatValue(this._serverRecord[field]);
        const currentSelection = this._selections[field];

        html += `
          <div class="conflict-field" data-field="${field}">
            <div class="conflict-field__name">${field}</div>
            <div class="conflict-field__values">
              <div class="conflict-field__value ${currentSelection === 'local' ? 'selected' : ''}" data-source="local" data-field="${field}">
                <div class="conflict-field__value-label">本地</div>
                <div class="conflict-field__value-content">${localVal}</div>
              </div>
              <div class="conflict-field__value ${currentSelection === 'server' ? 'selected' : ''}" data-source="server" data-field="${field}">
                <div class="conflict-field__value-label">服务器</div>
                <div class="conflict-field__value-content">${serverVal}</div>
              </div>
            </div>
            <div class="conflict-field__merge">
              <div class="conflict-field__merge-label">自定义合并值</div>
              <input type="text" class="form-control merge-input" data-field="${field}" placeholder="留空则使用上方选择的值" style="font-size:14px;padding:8px 12px;width:100%;box-sizing:border-box;border:1px solid var(--border);border-radius:var(--radius-md);">
            </div>
          </div>
        `;
      }
    }

    const localCount = Object.values(this._selections).filter(v => v === 'local').length;
    const serverCount = Object.values(this._selections).filter(v => v === 'server').length;

    html += `
        <div class="conflict-summary">
          <div class="conflict-summary__item">
            <span>自动合并字段</span>
            <span>${this._autoResolvedFields.length}</span>
          </div>
          <div class="conflict-summary__item">
            <span>选择本地值</span>
            <span id="local-count">${localCount}</span>
          </div>
          <div class="conflict-summary__item">
            <span>选择服务器值</span>
            <span id="server-count">${serverCount}</span>
          </div>
          <div class="conflict-summary__item">
            <span>冲突字段总数</span>
            <span>${this._conflictFields.length}</span>
          </div>
        </div>

        <div class="conflict-actions">
          <button class="btn btn--outline" id="use-local-btn" style="flex:1;">使用本地版本</button>
          <button class="btn btn--outline" id="use-server-btn" style="flex:1;">使用服务器版本</button>
        </div>
        <div style="padding-bottom:8px;">
          <button class="btn btn--primary" id="apply-merge-btn" style="width:100%;">应用合并</button>
        </div>
      </div>
    `;

    this._container.innerHTML = html;
  },

  _formatValue(val) {
    if (val === null || val === undefined) return '<em>空</em>';
    if (typeof val === 'object') return JSON.stringify(val);
    return String(val);
  },

  _bindEvents() {
    this._container.addEventListener('click', (e) => {
      const valueEl = e.target.closest('.conflict-field__value');
      if (valueEl) {
        const field = valueEl.dataset.field;
        const source = valueEl.dataset.source;
        this._selections[field] = source;

        const fieldCard = valueEl.closest('.conflict-field');
        fieldCard.querySelectorAll('.conflict-field__value').forEach(el => el.classList.remove('selected'));
        valueEl.classList.add('selected');

        const mergeInput = fieldCard.querySelector('.merge-input');
        if (mergeInput) mergeInput.value = '';

        this._updateSummary();
      }
    });

    const useLocalBtn = this._container.querySelector('#use-local-btn');
    if (useLocalBtn) {
      useLocalBtn.addEventListener('click', async () => {
        await this._resolve(this._localRecord);
      });
    }

    const useServerBtn = this._container.querySelector('#use-server-btn');
    if (useServerBtn) {
      useServerBtn.addEventListener('click', async () => {
        await this._resolve(this._serverRecord);
      });
    }

    const applyBtn = this._container.querySelector('#apply-merge-btn');
    if (applyBtn) {
      applyBtn.addEventListener('click', async () => {
        const merged = this._buildMergedRecord();
        await this._resolve(merged);
      });
    }
  },

  _updateSummary() {
    const localCount = Object.values(this._selections).filter(v => v === 'local').length;
    const serverCount = Object.values(this._selections).filter(v => v === 'server').length;

    const localEl = this._container.querySelector('#local-count');
    const serverEl = this._container.querySelector('#server-count');
    if (localEl) localEl.textContent = localCount;
    if (serverEl) serverEl.textContent = serverCount;
  },

  _buildMergedRecord() {
    const merged = { ...this._localRecord };

    for (const field of this._conflictFields) {
      const mergeInput = this._container.querySelector(`.merge-input[data-field="${field}"]`);
      if (mergeInput && mergeInput.value.trim()) {
        merged[field] = mergeInput.value.trim();
      } else if (this._selections[field] === 'server') {
        merged[field] = this._serverRecord[field];
      }
    }

    return merged;
  },

  async _resolve(record) {
    try {
      const cleanRecord = { ...record };
      delete cleanRecord.serverRecord;

      await syncManager.resolveConflict(this._queueItem.id, cleanRecord);
      toast.success('冲突已解决');
      router.navigate('/sync');
    } catch (e) {
      toast.error('解决冲突失败: ' + e.message);
    }
  },

  destroy() {
    this._container = null;
    this._queueItem = null;
    this._localRecord = null;
    this._serverRecord = null;
    this._mergedRecord = null;
    this._conflictFields = [];
    this._autoResolvedFields = [];
    this._selections = {};
  }
};

export default ConflictResolverView;
