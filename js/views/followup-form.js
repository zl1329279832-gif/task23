import { patientModel } from '../models/patient.js';
import { followupModel } from '../models/followup.js';
import { duplicateDetector } from '../services/duplicate-detector.js';
import { RISK_LEVELS } from '../core/config.js';
import { formatDate } from '../utils/date.js';
import { router } from '../router.js';
import { eventBus } from '../core/event-bus.js';

export default {
  _container: null,
  _unsubs: [],
  _patient: null,
  _followupId: null,

  async render(container, params) {
    this._container = container;
    const patientId = params.patientId;
    this._followupId = params.followupId || null;

    container.innerHTML = '<div class="followup-form-view"><div class="loading">加载中...</div></div>';
    const root = container.firstElementChild;

    try {
      this._patient = await patientModel.getById(patientId);
      if (!this._patient) {
        root.innerHTML = '<div class="empty-state">未找到该患者</div>';
        return;
      }

      let followup = null;
      if (this._followupId) {
        followup = await followupModel.getById(this._followupId);
      }

      const dupResult = await duplicateDetector.check(patientId);

      this._renderForm(root, followup, dupResult);
      this._checkDraft(patientId);
    } catch (e) {
      console.error('Failed to load followup form:', e);
      root.innerHTML = '<div class="empty-state">加载失败，请重试</div>';
    }
  },

  _checkDraft(patientId) {
    eventBus.emit('draft:check', { patientId, viewName: 'followup-form' });

    const unsub = eventBus.on('draft:found', (draft) => {
      if (!draft || draft.patientId !== patientId) return;
      const banner = this._container.querySelector('.draft-banner');
      if (banner) {
        banner.classList.remove('hidden');
        banner.querySelector('.draft-restore-btn').addEventListener('click', () => {
          this._restoreDraft(draft);
          banner.classList.add('hidden');
        });
        banner.querySelector('.draft-dismiss-btn').addEventListener('click', () => {
          banner.classList.add('hidden');
        });
      }
    });
    this._unsubs.push(unsub);
  },

  _restoreDraft(draft) {
    if (!draft || !draft.data) return;
    const form = this._container.querySelector('.followup-form');
    if (!form) return;

    if (draft.data.doctorName) {
      const el = form.querySelector('[name="doctorName"]');
      if (el) el.value = draft.data.doctorName;
    }
    if (draft.data.riskLevel) {
      const btn = form.querySelector(`.risk-btn[data-level="${draft.data.riskLevel}"]`);
      if (btn) btn.click();
    }
    if (draft.data.notes) {
      const el = form.querySelector('[name="notes"]');
      if (el) el.value = draft.data.notes;
    }
  },

  _renderForm(root, followup, dupResult) {
    const patient = this._patient;
    const today = formatDate(Date.now());
    const isEdit = !!followup;

    root.innerHTML = `
      ${dupResult.isDuplicate ? `
        <div class="duplicate-warning">
          <span class="warning-icon">&#9888;</span>
          <span>${dupResult.message}</span>
        </div>
      ` : ''}

      <div class="draft-banner hidden">
        <span>检测到未保存的草稿，是否恢复？</span>
        <button class="btn btn-sm draft-restore-btn">恢复</button>
        <button class="btn btn-sm draft-dismiss-btn">忽略</button>
      </div>

      <form class="followup-form">
        <section class="form-section">
          <h3 class="section-title">基本信息</h3>
          <div class="form-group">
            <label class="form-label">患者姓名</label>
            <input type="text" class="form-input" value="${patient.name || ''}" readonly />
          </div>
          <div class="form-group">
            <label class="form-label">随访日期</label>
            <input type="date" class="form-input" name="followupDate"
              value="${isEdit && followup.followupDate ? followup.followupDate : today}" />
          </div>
          <div class="form-group">
            <label class="form-label">医生姓名</label>
            <input type="text" class="form-input" name="doctorName"
              placeholder="请输入医生姓名"
              value="${isEdit && followup.doctorId ? followup.doctorId : ''}" />
          </div>
        </section>

        <section class="form-section">
          <h3 class="section-title">风险等级</h3>
          <div class="risk-selector">
            ${RISK_LEVELS.map(r => `
              <button type="button" class="risk-btn ${isEdit && followup.riskAssessment === r.level ? 'active' : ''}"
                data-level="${r.level}" style="--risk-color: ${r.color}">
                ${r.label}
              </button>
            `).join('')}
          </div>
          <input type="hidden" name="riskLevel"
            value="${isEdit && followup.riskAssessment ? followup.riskAssessment : ''}" />
        </section>

        <section class="form-section">
          <h3 class="section-title">详细记录</h3>
          <div class="action-buttons">
            <button type="button" class="btn btn-outline action-btn" data-action="questionnaire">
              <span class="action-icon">&#128203;</span>
              <span>填写问卷</span>
            </button>
            <button type="button" class="btn btn-outline action-btn" data-action="vitals">
              <span class="action-icon">&#128147;</span>
              <span>记录体征</span>
            </button>
            <button type="button" class="btn btn-outline action-btn" data-action="photos">
              <span class="action-icon">&#128247;</span>
              <span>拍照附件</span>
            </button>
          </div>
        </section>

        <section class="form-section">
          <h3 class="section-title">备注</h3>
          <div class="form-group">
            <textarea class="form-input form-textarea" name="notes" rows="4"
              placeholder="请输入备注信息...">${isEdit && followup.notes ? followup.notes : ''}</textarea>
          </div>
        </section>

        <div class="form-actions">
          <button type="button" class="btn btn-secondary btn-save-draft">保存草稿</button>
          <button type="button" class="btn btn-primary btn-complete">完成随访</button>
        </div>
      </form>
    `;

    this._bindEvents(root, followup);
  },

  async _bindEvents(root, followup) {
    const form = root.querySelector('.followup-form');
    const riskInput = form.querySelector('[name="riskLevel"]');

    // Risk level buttons
    root.querySelectorAll('.risk-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        root.querySelectorAll('.risk-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        riskInput.value = btn.dataset.level;
      });
    });

    // Action buttons
    root.querySelectorAll('.action-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.action;
        let fid = this._followupId;
        if (!fid) {
          const saved = await this._saveFollowup(form, 'draft');
          if (!saved) return;
          fid = saved.id;
          this._followupId = fid;
        }

        if (action === 'questionnaire') {
          router.navigate(`/questionnaire/${fid}`);
        } else if (action === 'vitals') {
          router.navigate(`/vitals/${fid}`);
        } else if (action === 'photos') {
          router.navigate(`/photos/${fid}`);
        }
      });
    });

    // Save draft
    root.querySelector('.btn-save-draft').addEventListener('click', async () => {
      await this._saveFollowup(form, 'draft');
      eventBus.emit('draft:save', {
        patientId: this._patient.id,
        viewName: 'followup-form',
        data: this._getFormData(form)
      });
    });

    // Complete followup
    root.querySelector('.btn-complete').addEventListener('click', async () => {
      const data = this._getFormData(form);
      if (!data.doctorId) {
        alert('请填写医生姓名');
        return;
      }

      const saved = await this._saveFollowup(form, 'complete');
      if (saved) {
        await followupModel.complete(saved.id);
        router.navigate(`/patient/${this._patient.id}`);
      }
    });
  },

  _getFormData(form) {
    return {
      followupDate: form.querySelector('[name="followupDate"]').value,
      doctorId: form.querySelector('[name="doctorName"]').value,
      riskAssessment: Number(form.querySelector('[name="riskLevel"]').value) || null,
      notes: form.querySelector('[name="notes"]').value
    };
  },

  async _saveFollowup(form, status) {
    const data = this._getFormData(form);
    try {
      let saved;
      if (this._followupId) {
        saved = await followupModel.update(this._followupId, { ...data, status });
      } else {
        saved = await followupModel.create(this._patient.id, { ...data, status });
        this._followupId = saved.id;
      }
      return saved;
    } catch (e) {
      console.error('Failed to save followup:', e);
      alert('保存失败，请重试');
      return null;
    }
  },

  destroy() {
    this._unsubs.forEach(fn => fn());
    this._unsubs = [];
    this._container = null;
    this._patient = null;
    this._followupId = null;
  }
};
