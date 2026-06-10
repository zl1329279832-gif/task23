import { patientModel } from '../models/patient.js';
import { RISK_LEVELS, DISEASE_TYPES } from '../core/config.js';
import { calculateAge } from '../utils/date.js';
import { router } from '../router.js';
import { eventBus } from '../core/event-bus.js';

const RISK_LABELS = { 1: '低危', 2: '中危', 3: '高危', 4: '极高危' };

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

function getInitial(name) {
  return name ? name.charAt(0) : '?';
}

export default {
  _container: null,
  _unsubs: [],
  _searchTimer: null,

  async render(container) {
    this._container = container;
    container.innerHTML = '<div class="patient-list-view"></div>';
    const root = container.firstElementChild;

    root.innerHTML = `
      <section class="stats-cards"></section>
      <div class="search-bar">
        <input type="search" class="search-input" placeholder="搜索患者姓名..." />
      </div>
      <div class="patient-cards"></div>
    `;

    this._renderStats(root.querySelector('.stats-cards'));
    this._renderPatients(root.querySelector('.patient-cards'));

    const input = root.querySelector('.search-input');
    input.addEventListener('input', () => {
      clearTimeout(this._searchTimer);
      this._searchTimer = setTimeout(() => {
        this._renderPatients(root.querySelector('.patient-cards'), input.value);
      }, 300);
    });

    const unsub = eventBus.on('patient:saved', () => {
      this._renderStats(root.querySelector('.stats-cards'));
      const input = root.querySelector('.search-input');
      this._renderPatients(root.querySelector('.patient-cards'), input ? input.value : '');
    });
    this._unsubs.push(unsub);
  },

  async _renderStats(el) {
    try {
      const stats = await patientModel.getStats();
      el.innerHTML = `
        <div class="stat-card">
          <span class="stat-value">${stats.total}</span>
          <span class="stat-label">总患者数</span>
        </div>
        ${RISK_LEVELS.map(r => `
          <div class="stat-card" style="border-left: 3px solid ${r.color}">
            <span class="stat-value">${stats.riskCounts[r.level] || 0}</span>
            <span class="stat-label">${r.label}</span>
          </div>
        `).join('')}
      `;
    } catch (e) {
      console.error('Failed to load stats:', e);
      el.innerHTML = '<div class="stat-card"><span class="stat-label">统计加载失败</span></div>';
    }
  },

  async _renderPatients(el, searchTerm) {
    try {
      const patients = searchTerm
        ? await patientModel.search(searchTerm)
        : await patientModel.getAll();

      if (patients.length === 0) {
        el.innerHTML = '<div class="empty-state">暂无患者数据</div>';
        return;
      }

      el.innerHTML = patients.map(p => {
        const age = calculateAge(p.birthDate);
        const risk = getRiskMeta(p.riskLevel);
        const diseaseLabel = getDiseaseLabel(p.diseaseType);
        const initial = getInitial(p.name);

        return `
          <div class="patient-card" data-id="${p.id}">
            <div class="patient-avatar" style="background-color: ${risk.color}">${initial}</div>
            <div class="patient-info">
              <div class="patient-name">${p.name || ''}</div>
              <div class="patient-meta">
                ${age ? `<span>${age}岁</span>` : ''}
                ${diseaseLabel ? `<span class="badge badge-disease">${diseaseLabel}</span>` : ''}
                ${risk.label ? `<span class="badge badge-risk" style="background-color: ${risk.color}">${risk.label}</span>` : ''}
              </div>
            </div>
          </div>
        `;
      }).join('');

      el.querySelectorAll('.patient-card').forEach(card => {
        card.addEventListener('click', () => {
          const id = card.dataset.id;
          router.navigate(`/patient/${id}`);
        });
      });
    } catch (e) {
      console.error('Failed to load patients:', e);
      el.innerHTML = '<div class="empty-state">加载失败，请重试</div>';
    }
  },

  destroy() {
    clearTimeout(this._searchTimer);
    this._unsubs.forEach(fn => fn());
    this._unsubs = [];
    this._container = null;
  }
};
