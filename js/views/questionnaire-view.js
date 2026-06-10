import { db } from '../core/db.js';
import { STORES } from '../core/config.js';
import { questionnaireModel } from '../models/questionnaire.js';
import { questionnaireEngine } from '../services/questionnaire-engine.js';
import { calculateAge } from '../utils/date.js';
import { debounce } from '../utils/debounce.js';
import { eventBus } from '../core/event-bus.js';
import { router } from '../router.js';
import { DRAFT } from '../core/config.js';

const SENSITIVE_FIELDS = [
  'gender', 'birthDate', 'idCardNumber', 'phone',
  'address', 'medicalHistory', 'allergies', 'emergencyContact'
];

export default {
  _container: null,
  _unsubs: [],
  _followupId: null,
  _followup: null,
  _patient: null,
  _schema: null,
  _answers: {},
  _patientContext: {},
  _debouncedDraftSave: null,

  async render(container, params) {
    this._container = container;
    this._followupId = params.followupId;

    container.innerHTML = '<div class="questionnaire-view"><div class="loading">加载问卷中...</div></div>';
    const root = container.firstElementChild;

    try {
      this._followup = await db.get(STORES.FOLLOWUPS, this._followupId);
      if (!this._followup) {
        root.innerHTML = '<div class="empty-state">未找到随访记录</div>';
        return;
      }

      this._patient = await db.get(STORES.PATIENTS, this._followup.patientId, SENSITIVE_FIELDS);
      if (!this._patient) {
        root.innerHTML = '<div class="empty-state">未找到患者信息</div>';
        return;
      }

      const diseaseType = this._followup.diseaseType || this._patient.diseaseType;
      this._schema = await questionnaireModel.getLatestSchema(diseaseType);
      if (!this._schema) {
        root.innerHTML = '<div class="empty-state">未找到该疾病类型的问卷模板</div>';
        return;
      }

      const age = calculateAge(this._patient.birthDate);
      this._patientContext = {
        age,
        diseaseType,
        gender: this._patient.gender,
        riskLevel: this._patient.riskLevel
      };

      this._answers = {};
      const savedAnswers = this._followup.questionnaireAnswers || {};
      const savedVersion = this._followup.questionnaireSchemaVersion;

      if (savedVersion && savedVersion < this._schema.version && Object.keys(savedAnswers).length > 0) {
        const migration = this._schema.migration;
        if (migration) {
          this._answers = questionnaireEngine.migrateAnswers(savedAnswers, migration);
        } else {
          this._answers = { ...savedAnswers };
        }
        this._followup.questionnaireSchemaVersion = this._schema.version;
        this._renderMigrationNotice(root);
      } else {
        this._answers = { ...savedAnswers };
      }

      this._debouncedDraftSave = debounce(() => this._saveDraft(), DRAFT.SAVE_DEBOUNCE);
      this._renderQuestionnaire(root);
    } catch (e) {
      console.error('Failed to load questionnaire:', e);
      root.innerHTML = '<div class="empty-state">加载问卷失败，请重试</div>';
    }
  },

  _renderMigrationNotice(root) {
    const notice = document.createElement('div');
    notice.className = 'migration-notice';
    notice.innerHTML = `
      <div class="notice-content">
        <strong>问卷已更新</strong>
        <p>问卷模板已升级到新版本，您之前的回答已自动迁移。请检查并补充新增的问题。</p>
      </div>
    `;
    root.prepend(notice);
  },

  _renderQuestionnaire(root) {
    const sections = questionnaireEngine.computeVisibleQuestions(
      this._schema, this._answers, this._patientContext
    );

    root.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'questionnaire-header';
    header.innerHTML = `
      <h2>${this._schema.title}</h2>
      <p class="questionnaire-desc">${this._schema.description || ''}</p>
      <p class="patient-info">患者：${this._patient.name || ''}</p>
    `;
    root.appendChild(header);

    if (root.querySelector('.migration-notice')) {
      root.insertBefore(root.querySelector('.migration-notice'), header.nextSibling);
    }

    const form = document.createElement('div');
    form.className = 'questionnaire-form';
    form.setAttribute('role', 'form');

    for (const section of sections) {
      const sectionEl = this._renderSection(section);
      form.appendChild(sectionEl);
    }

    root.appendChild(form);

    const riskResults = questionnaireEngine.computeRiskScore(this._schema, this._answers);
    if (riskResults.risk_score !== undefined && riskResults.risk_score !== null) {
      const scoreEl = document.createElement('div');
      scoreEl.className = 'risk-score-display';
      scoreEl.innerHTML = `
        <div class="score-label">风险评分</div>
        <div class="score-value">${riskResults.risk_score}</div>
      `;
      root.appendChild(scoreEl);
    }

    const actions = document.createElement('div');
    actions.className = 'questionnaire-actions';
    actions.innerHTML = `
      <button class="btn btn-primary btn-save-questionnaire">保存问卷</button>
    `;
    root.appendChild(actions);

    actions.querySelector('.btn-save-questionnaire').addEventListener('click', () => {
      this._saveAnswers();
    });
  },

  _renderSection(section) {
    const el = document.createElement('section');
    el.className = 'questionnaire-section';
    el.dataset.sectionId = section.id;

    const title = document.createElement('h3');
    title.className = 'section-title';
    title.textContent = section.title;
    el.appendChild(title);

    for (const question of section.questions) {
      const questionEl = this._renderQuestion(question);
      el.appendChild(questionEl);
    }

    return el;
  },

  _renderQuestion(question) {
    const wrapper = document.createElement('div');
    wrapper.className = 'question-item';
    wrapper.dataset.field = question.field;

    const label = document.createElement('label');
    label.className = 'question-label';
    label.textContent = question.label;
    if (question.required) {
      const req = document.createElement('span');
      req.className = 'required-marker';
      req.textContent = ' *';
      label.appendChild(req);
    }
    wrapper.appendChild(label);

    const inputContainer = document.createElement('div');
    inputContainer.className = 'question-input';

    switch (question.type) {
      case 'single_choice':
        this._renderSingleChoice(inputContainer, question);
        break;
      case 'multi_choice':
        this._renderMultiChoice(inputContainer, question);
        break;
      case 'boolean':
        this._renderBoolean(inputContainer, question);
        break;
      case 'scale':
        this._renderScale(inputContainer, question);
        break;
      case 'number':
        this._renderNumber(inputContainer, question);
        break;
      case 'text':
        this._renderText(inputContainer, question);
        break;
    }

    wrapper.appendChild(inputContainer);
    return wrapper;
  },

  _renderSingleChoice(container, question) {
    const group = document.createElement('div');
    group.className = 'radio-group';
    group.setAttribute('role', 'radiogroup');

    for (const option of question.options) {
      const item = document.createElement('label');
      item.className = 'radio-item';
      if (question.currentValue === option.value) {
        item.classList.add('selected');
      }

      const input = document.createElement('input');
      input.type = 'radio';
      input.name = question.field;
      input.value = option.value;
      input.checked = question.currentValue === option.value;
      input.addEventListener('change', () => {
        this._onAnswerChange(question.field, option.value);
        group.querySelectorAll('.radio-item').forEach(el => el.classList.remove('selected'));
        item.classList.add('selected');
      });

      const text = document.createElement('span');
      text.className = 'radio-label';
      text.textContent = option.label;

      item.appendChild(input);
      item.appendChild(text);
      group.appendChild(item);
    }

    container.appendChild(group);
  },

  _renderMultiChoice(container, question) {
    const group = document.createElement('div');
    group.className = 'checkbox-group';

    const currentValues = Array.isArray(question.currentValue) ? question.currentValue : [];

    for (const option of question.options) {
      const item = document.createElement('label');
      item.className = 'checkbox-item';
      if (currentValues.includes(option.value)) {
        item.classList.add('selected');
      }

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.name = question.field;
      input.value = option.value;
      input.checked = currentValues.includes(option.value);
      input.addEventListener('change', () => {
        const current = Array.isArray(this._answers[question.field])
          ? [...this._answers[question.field]] : [];
        if (input.checked) {
          current.push(option.value);
          item.classList.add('selected');
        } else {
          const idx = current.indexOf(option.value);
          if (idx !== -1) current.splice(idx, 1);
          item.classList.remove('selected');
        }
        this._onAnswerChange(question.field, current);
      });

      const text = document.createElement('span');
      text.className = 'checkbox-label';
      text.textContent = option.label;

      item.appendChild(input);
      item.appendChild(text);
      group.appendChild(item);
    }

    container.appendChild(group);
  },

  _renderBoolean(container, question) {
    const group = document.createElement('div');
    group.className = 'toggle-group';

    const options = [
      { value: true, label: '是' },
      { value: false, label: '否' }
    ];

    for (const option of options) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toggle-btn';
      if (question.currentValue === option.value) {
        btn.classList.add('active');
      }
      btn.textContent = option.label;
      btn.addEventListener('click', () => {
        this._onAnswerChange(question.field, option.value);
        group.querySelectorAll('.toggle-btn').forEach(el => el.classList.remove('active'));
        btn.classList.add('active');
      });
      group.appendChild(btn);
    }

    container.appendChild(group);
  },

  _renderScale(container, question) {
    const scaleBar = document.createElement('div');
    scaleBar.className = 'scale-bar';

    const min = question.min || 1;
    const max = question.max || 10;

    if (question.minLabel) {
      const minLabel = document.createElement('span');
      minLabel.className = 'scale-min-label';
      minLabel.textContent = question.minLabel;
      scaleBar.appendChild(minLabel);
    }

    const steps = document.createElement('div');
    steps.className = 'scale-steps';

    for (let i = min; i <= max; i++) {
      const step = document.createElement('button');
      step.type = 'button';
      step.className = 'scale-step';
      step.textContent = i;
      if (question.currentValue === i) {
        step.classList.add('active');
      }
      step.addEventListener('click', () => {
        this._onAnswerChange(question.field, i);
        steps.querySelectorAll('.scale-step').forEach(el => el.classList.remove('active'));
        step.classList.add('active');
      });
      steps.appendChild(step);
    }

    scaleBar.appendChild(steps);

    if (question.maxLabel) {
      const maxLabel = document.createElement('span');
      maxLabel.className = 'scale-max-label';
      maxLabel.textContent = question.maxLabel;
      scaleBar.appendChild(maxLabel);
    }

    container.appendChild(scaleBar);
  },

  _renderNumber(container, question) {
    const wrap = document.createElement('div');
    wrap.className = 'number-input-wrap';

    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'number-input';
    if (question.min !== undefined) input.min = question.min;
    if (question.max !== undefined) input.max = question.max;
    if (question.currentValue !== null && question.currentValue !== undefined) {
      input.value = question.currentValue;
    }
    input.addEventListener('input', () => {
      const val = input.value === '' ? null : Number(input.value);
      this._onAnswerChange(question.field, val);
    });

    wrap.appendChild(input);

    if (question.unit) {
      const unit = document.createElement('span');
      unit.className = 'number-unit';
      unit.textContent = question.unit;
      wrap.appendChild(unit);
    }

    container.appendChild(wrap);
  },

  _renderText(container, question) {
    const textarea = document.createElement('textarea');
    textarea.className = 'text-input';
    textarea.rows = 3;
    if (question.placeholder) textarea.placeholder = question.placeholder;
    if (question.currentValue) textarea.value = question.currentValue;
    textarea.addEventListener('input', () => {
      this._onAnswerChange(question.field, textarea.value);
    });

    container.appendChild(textarea);
  },

  _onAnswerChange(field, value) {
    this._answers[field] = value;

    const root = this._container.firstElementChild;
    if (!root) return;

    this._renderQuestionnaire(root);

    if (this._debouncedDraftSave) {
      this._debouncedDraftSave();
    }
  },

  async _saveDraft() {
    try {
      eventBus.emit('draft:save', {
        followupId: this._followupId,
        answers: { ...this._answers },
        schemaVersion: this._schema.version,
        timestamp: Date.now()
      });
    } catch (e) {
      console.error('Failed to save draft:', e);
    }
  },

  async _saveAnswers() {
    try {
      const btn = this._container.querySelector('.btn-save-questionnaire');
      if (btn) {
        btn.disabled = true;
        btn.textContent = '保存中...';
      }

      this._followup.questionnaireAnswers = { ...this._answers };
      this._followup.questionnaireSchemaVersion = this._schema.version;
      this._followup.questionnaireCompletedAt = Date.now();

      const riskResults = questionnaireEngine.computeRiskScore(this._schema, this._answers);
      if (riskResults.risk_score !== undefined) {
        this._followup.riskScore = riskResults.risk_score;
      }

      await questionnaireModel.saveAnswers(this._followupId, this._followup.questionnaireAnswers);
      eventBus.emit('questionnaire:saved', {
        followupId: this._followupId,
        patientId: this._followup.patientId,
        riskScore: riskResults.risk_score
      });

      router.back();
    } catch (e) {
      console.error('Failed to save questionnaire:', e);
      const btn = this._container.querySelector('.btn-save-questionnaire');
      if (btn) {
        btn.disabled = false;
        btn.textContent = '保存问卷';
      }
      const root = this._container.firstElementChild;
      if (root) {
        const err = document.createElement('div');
        err.className = 'error-message';
        err.textContent = '保存失败，请重试';
        root.appendChild(err);
        setTimeout(() => err.remove(), 3000);
      }
    }
  },

  destroy() {
    this._unsubs.forEach(fn => fn());
    this._unsubs = [];
    if (this._debouncedDraftSave) {
      this._debouncedDraftSave.cancel();
      this._debouncedDraftSave = null;
    }
    this._container = null;
    this._followup = null;
    this._patient = null;
    this._schema = null;
    this._answers = {};
    this._patientContext = {};
    this._followupId = null;
  }
};
