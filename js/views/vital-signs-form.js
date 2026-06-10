import { db } from '../core/db.js';
import { STORES } from '../core/config.js';
import { vitalSignsModel } from '../models/vital-signs.js';
import { followupModel } from '../models/followup.js';
import { bloodPressure, bloodGlucose, numberRange } from '../utils/validators.js';
import { router } from '../router.js';
import { eventBus } from '../core/event-bus.js';

const VITAL_FIELDS = [
  { key: 'systolicBP', label: '收缩压', unit: 'mmHg', icon: '&#9829;', min: 60, max: 300 },
  { key: 'diastolicBP', label: '舒张压', unit: 'mmHg', icon: '&#9829;', min: 30, max: 200 },
  { key: 'heartRate', label: '心率', unit: '次/分', icon: '&#128147;', min: 30, max: 220 },
  { key: 'bloodGlucose', label: '血糖', unit: 'mmol/L', icon: '&#128137;', min: 1, max: 40, hasType: true },
  { key: 'temperature', label: '体温', unit: '\u00B0C', icon: '&#127777;', min: 34, max: 42 },
  { key: 'weight', label: '体重', unit: 'kg', icon: '&#9878;', min: 10, max: 300 },
  { key: 'height', label: '身高', unit: 'cm', icon: '&#128207;', min: 50, max: 250 },
  { key: 'oxygenSaturation', label: '血氧', unit: '%', icon: '&#128168;', min: 50, max: 100 }
];

export default {
  _container: null,
  _unsubs: [],
  _followupId: null,

  async render(container, params) {
    this._container = container;
    this._followupId = params.followupId;

    container.innerHTML = '<div class="vital-signs-form-view"><div class="loading">加载中...</div></div>';
    const root = container.firstElementChild;

    try {
      const followup = await followupModel.getById(this._followupId);
      if (!followup) {
        root.innerHTML = '<div class="empty-state">未找到随访记录</div>';
        return;
      }

      // Load existing readings
      const existing = await vitalSignsModel.getByFollowup(this._followupId);
      const latest = existing.length > 0 ? existing[existing.length - 1] : {};

      this._renderForm(root, latest);
    } catch (e) {
      console.error('Failed to load vital signs form:', e);
      root.innerHTML = '<div class="empty-state">加载失败，请重试</div>';
    }
  },

  _renderForm(root, existing) {
    root.innerHTML = `
      <form class="vitals-form">
        <div class="vitals-grid">
          ${VITAL_FIELDS.map(f => this._renderCard(f, existing)).join('')}
        </div>

        <div class="form-group vitals-notes">
          <label class="form-label">备注</label>
          <textarea class="form-input form-textarea" name="notes" rows="3"
            placeholder="体征相关备注...">${existing.notes || ''}</textarea>
        </div>

        <div class="form-actions">
          <button type="button" class="btn btn-secondary btn-cancel">取消</button>
          <button type="button" class="btn btn-primary btn-save-vitals">保存体征</button>
        </div>
      </form>
    `;

    this._bindEvents(root);
  },

  _renderCard(field, existing) {
    const value = existing[field.key] !== undefined ? existing[field.key] : '';
    const glucoseType = existing.glucoseType || 'fasting';

    return `
      <div class="vital-card" data-key="${field.key}">
        <div class="vital-icon">${field.icon}</div>
        <label class="vital-label">${field.label}</label>
        ${field.hasType ? `
          <div class="glucose-type-selector">
            <label class="radio-label">
              <input type="radio" name="glucoseType" value="fasting"
                ${glucoseType === 'fasting' ? 'checked' : ''} />
              <span>空腹血糖</span>
            </label>
            <label class="radio-label">
              <input type="radio" name="glucoseType" value="postprandial"
                ${glucoseType === 'postprandial' ? 'checked' : ''} />
              <span>餐后血糖</span>
            </label>
          </div>
        ` : ''}
        <div class="vital-input-wrap">
          <input type="number" class="form-input vital-input" name="${field.key}"
            step="any" placeholder="--" value="${value}"
            min="${field.min}" max="${field.max}" />
          <span class="vital-unit">${field.unit}</span>
        </div>
        <div class="vital-error hidden" data-error="${field.key}"></div>
      </div>
    `;
  },

  _bindEvents(root) {
    // Cancel
    root.querySelector('.btn-cancel').addEventListener('click', () => {
      router.back();
    });

    // Save
    root.querySelector('.btn-save-vitals').addEventListener('click', async () => {
      const errors = this._validate(root);
      if (errors.length > 0) {
        errors.forEach(err => {
          const el = root.querySelector(`[data-error="${err.key}"]`);
          if (el) {
            el.textContent = err.message;
            el.classList.remove('hidden');
          }
        });
        return;
      }

      const readings = this._getReadings(root);

      try {
        const followup = await followupModel.getById(this._followupId);
        await vitalSignsModel.save(this._followupId, followup.patientId, readings);
        eventBus.emit('vitals:saved', { followupId: this._followupId });
        router.back();
      } catch (e) {
        console.error('Failed to save vital signs:', e);
        alert('保存失败，请重试');
      }
    });

    // Clear errors on input
    root.querySelectorAll('.vital-input').forEach(input => {
      input.addEventListener('input', () => {
        const errorEl = root.querySelector(`[data-error="${input.name}"]`);
        if (errorEl) errorEl.classList.add('hidden');
      });
    });
  },

  _getReadings(root) {
    const readings = {};
    VITAL_FIELDS.forEach(f => {
      const input = root.querySelector(`[name="${f.key}"]`);
      if (input && input.value !== '') {
        readings[f.key] = Number(input.value);
      }
    });

    const glucoseTypeEl = root.querySelector('[name="glucoseType"]:checked');
    if (glucoseTypeEl) {
      readings.glucoseType = glucoseTypeEl.value;
    }

    const notesEl = root.querySelector('[name="notes"]');
    if (notesEl && notesEl.value.trim()) {
      readings.notes = notesEl.value.trim();
    }

    return readings;
  },

  _validate(root) {
    const errors = [];

    // Clear previous errors
    root.querySelectorAll('.vital-error').forEach(el => el.classList.add('hidden'));

    const systolic = root.querySelector('[name="systolicBP"]').value;
    const diastolic = root.querySelector('[name="diastolicBP"]').value;

    if (systolic || diastolic) {
      const bpErrors = bloodPressure(systolic, diastolic);
      if (bpErrors) {
        if (systolic) errors.push({ key: 'systolicBP', message: bpErrors[0] });
        if (diastolic) errors.push({ key: 'diastolicBP', message: bpErrors[bpErrors.length - 1] });
      }
    }

    const glucose = root.querySelector('[name="bloodGlucose"]').value;
    if (glucose) {
      const gErr = bloodGlucose(glucose);
      if (gErr) errors.push({ key: 'bloodGlucose', message: gErr });
    }

    VITAL_FIELDS.forEach(f => {
      if (f.key === 'systolicBP' || f.key === 'diastolicBP' || f.key === 'bloodGlucose') return;
      const input = root.querySelector(`[name="${f.key}"]`);
      if (input && input.value !== '') {
        const err = numberRange(input.value, f.min, f.max, f.label);
        if (err) errors.push({ key: f.key, message: err });
      }
    });

    return errors;
  },

  destroy() {
    this._unsubs.forEach(fn => fn());
    this._unsubs = [];
    this._container = null;
    this._followupId = null;
  }
};
