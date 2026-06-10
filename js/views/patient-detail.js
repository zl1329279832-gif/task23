import { patientModel } from '../models/patient.js';
import { db } from '../core/db.js';
import { STORES, RISK_LEVELS, DISEASE_TYPES } from '../core/config.js';
import { calculateAge, formatDate } from '../utils/date.js';
import { router } from '../router.js';
import { eventBus } from '../core/event-bus.js';

const RISK_LABELS = { 1: '低危', 2: '中危', 3: '高危', 4: '极高危' };
const STATUS_LABELS = {
  draft: '草稿',
  completed: '已完成',
  pending: '待随访',
  overdue: '已逾期'
};

function getDiseaseLabel(value) {
  const dt = DISEASE_TYPES.find(d => d.value === value);
  return dt ? dt.label : value || '';
}

function getRiskMeta(level) {
  const rl = RISK_LEVELS.find(r => r.level === level);
  return {
    label: RISK_LABELS[level] || '',
    color: rl ? rl.color : 'var(--risk-1)'
  };
}

function getGenderLabel(gender) {
  if (gender === 'male' || gender === '男') return '男';
  if (gender === 'female' || gender === '女') return '女';
  return gender || '';
}

export default {
  _container: null,
  _unsubs: [],
  _patientId: null,

  async render(container, params) {
    this._container = container;
    this._patientId = params.id;

    container.innerHTML = '<div class="patient-detail-view"><div class="loading">加载中...</div></div>';
    const root = container.firstElementChild;

    try {
      const patient = await patientModel.getById(this._patientId);
      if (!patient) {
        root.innerHTML = '<div class="empty-state">未找到该患者</div>';
        return;
      }

      const followups = await db.getAllByIndex(
        STORES.FOLLOWUPS, 'patientId', this._patientId, null
      );
      followups.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

      this._renderContent(root, patient, followups);
    } catch (e) {
      console.error('Failed to load patient detail:', e);
      root.innerHTML = '<div class="empty-state">加载失败，请重试</div>';
    }

    const unsub = eventBus.on('patient:saved', () => {
      this.render(this._container, { id: this._patientId });
    });
    this._unsubs.push(unsub);
  },

  _renderContent(root, patient, followups) {
    const age = calculateAge(patient.birthDate);
    const risk = getRiskMeta(patient.riskLevel);
    const diseaseLabel = getDiseaseLabel(patient.diseaseType);
    const gender = getGenderLabel(patient.gender);

    root.innerHTML = `
      <section class="patient-info-card">
        <h2 class="patient-detail-name">${patient.name || ''}</h2>
        <div class="info-grid">
          ${age ? `<div class="info-item"><span class="info-label">年龄</span><span class="info-value">${age}岁</span></div>` : ''}
          ${gender ? `<div class="info-item"><span class="info-label">性别</span><span class="info-value">${gender}</span></div>` : ''}
          ${diseaseLabel ? `<div class="info-item"><span class="info-label">疾病类型</span><span class="info-value">${diseaseLabel}</span></div>` : ''}
          ${risk.label ? `<div class="info-item"><span class="info-label">危险分层</span><span class="info-value"><span class="badge badge-risk" style="background-color: ${risk.color}">${risk.label}</span></span></div>` : ''}
          ${patient.phone ? `<div class="info-item"><span class="info-label">电话</span><span class="info-value">${patient.phone}</span></div>` : ''}
          ${patient.address ? `<div class="info-item"><span class="info-label">地址</span><span class="info-value">${patient.address}</span></div>` : ''}
        </div>
      </section>

      ${this._renderMedicalHistory(patient)}

      <section class="followup-section">
        <div class="section-header">
          <h3>随访记录</h3>
          <button class="btn btn-primary btn-new-followup">新建随访</button>
        </div>
        <div class="followup-list">
          ${this._renderFollowupList(followups, patient.id)}
        </div>
      </section>
    `;

    root.querySelector('.btn-new-followup').addEventListener('click', () => {
      router.navigate(`/followup/${patient.id}`);
    });

    root.querySelectorAll('.followup-item').forEach(item => {
      item.addEventListener('click', () => {
        const fid = item.dataset.followupId;
        router.navigate(`/followup/${patient.id}/${fid}`);
      });
    });
  },

  _renderMedicalHistory(patient) {
    const history = patient.medicalHistory;
    const allergies = patient.allergies;
    if (!history && !allergies) return '';

    return `
      <section class="medical-history-section">
        <h3>病史信息</h3>
        ${history ? `<div class="history-item"><span class="info-label">既往病史</span><p>${history}</p></div>` : ''}
        ${allergies ? `<div class="history-item"><span class="info-label">过敏史</span><p>${allergies}</p></div>` : ''}
      </section>
    `;
  },

  _renderFollowupList(followups, patientId) {
    if (!followups || followups.length === 0) {
      return '<div class="empty-state">暂无随访记录</div>';
    }

    return followups.map(f => {
      const date = formatDate(f.createdAt);
      const statusLabel = STATUS_LABELS[f.status] || f.status || '';
      const statusClass = f.status ? `status-${f.status}` : '';

      return `
        <div class="followup-item ${statusClass}" data-followup-id="${f.id}">
          <div class="followup-date">${date}</div>
          <div class="followup-status">${statusLabel}</div>
        </div>
      `;
    }).join('');
  },

  destroy() {
    this._unsubs.forEach(fn => fn());
    this._unsubs = [];
    this._container = null;
    this._patientId = null;
  }
};
