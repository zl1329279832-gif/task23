// 问卷填写视图
const QuestionnaireView = (() => {
  let _patient = null;
  let _currentQuestions = [];
  let _previousAnswers = null;
  let _draftTimer = null;
  let _unmappedAnswers = [];

  async function render(params) {
    const { patientId } = params;
    _patient = await DB.loadPatient(patientId);
    if (!_patient) {
      Utils.showToast('患者不存在', 'error');
      App.navigate('patient-list');
      return;
    }

    document.getElementById('page-title').textContent = '随访问卷';
    document.getElementById('btn-back').style.display = 'flex';
    document.getElementById('bottom-nav').style.display = 'none';

    await QuestionnaireEngine.loadTemplates();

    // Try to recover draft
    const draft = await DB.loadDraft('questionnaire', patientId);
    let templateId = null;
    let previousAnswers = null;

    if (draft) {
      const recoverDraft = await Utils.showModal(
        '恢复草稿',
        `<p>发现上次未完成的问卷草稿（保存于 ${Utils.formatDateTime(draft.savedAt)}）</p>
         <p style="margin-top:8px;font-size:13px;color:var(--text-secondary)">已完成 ${draft.answerCount || 0} 道题</p>`,
        [
          { label: '重新开始', value: 'new' },
          { label: '恢复草稿', value: 'recover', primary: true }
        ]
      );
      if (recoverDraft === 'recover') {
        templateId = draft.templateId;
        previousAnswers = draft.answers;
      }
    }

    // Select questionnaire template based on patient diseases
    const diseases = _patient.diseases || [];
    const templates = [];

    for (const disease of diseases) {
      const t = QuestionnaireEngine.getLatestTemplate(disease);
      if (t) templates.push(t);
    }
    // Also add general template
    const generalT = QuestionnaireEngine.getLatestTemplate('general');
    if (generalT) templates.push(generalT);

    if (templates.length === 0) {
      document.getElementById('view-container').innerHTML = `
        <div class="empty-state">
          <svg width="64" height="64" viewBox="0 0 24 24"><path fill="currentColor" d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>
          <div class="title">无可用问卷</div>
          <div class="desc">请先在设置中导入问卷模板</div>
        </div>
      `;
      document.getElementById('btn-back').onclick = () => App.navigate('detail', { patientId: _patient.id });
      return;
    }

    // If no specific template selected, use the first matching one
    const template = templateId
      ? QuestionnaireEngine.getTemplate(templateId)
      : templates[0];

    if (!template) {
      Utils.showToast('问卷模板不存在', 'error');
      App.navigate('detail', { patientId: _patient.id });
      return;
    }

    // Check for version upgrade - load previous questionnaire answers
    if (!previousAnswers) {
      const visits = await DB.loadVisitsByPatient(patientId);
      const lastWithQuestionnaire = visits
        .filter(v => !v.isDraft && v.questionnaires && v.questionnaires.length > 0)
        .sort((a, b) => new Date(b.date) - new Date(a.date))[0];

      if (lastWithQuestionnaire) {
        const lastQ = lastWithQuestionnaire.questionnaires.find(
          q => q.diseaseType === template.diseaseType
        );
        if (lastQ && (lastQ.version !== template.version || lastQ.templateId !== template.id)) {
          // Version upgrade detected
          const migration = QuestionnaireEngine.migrateAnswers(
            lastQ.templateId, lastQ.version, lastQ.answers, template.diseaseType
          );
          previousAnswers = migration.answers;
          _unmappedAnswers = migration.unmapped;
          if (migration.migrated.length > 0 || migration.unmapped.length > 0) {
            Utils.showToast(
              `问卷已升级到 v${template.version}，${migration.migrated.length} 题已迁移`,
              'info'
            );
          }
        } else if (lastQ) {
          previousAnswers = lastQ.answers;
        }
      }
    }

    _currentQuestions = QuestionnaireEngine.startQuestionnaire(template, _patient, previousAnswers || {});
    _previousAnswers = previousAnswers;

    _renderQuestionnaire(template);
    _bindEvents(template);
    _startDraftAutosave(template);
  }

  function _renderQuestionnaire(template) {
    const container = document.getElementById('view-container');
    const progress = QuestionnaireEngine.getProgress();

    container.innerHTML = `
      <div class="questionnaire-progress">
        <div class="progress-bar"><div class="progress-fill" style="width:${progress}%"></div></div>
        <span class="progress-text">${progress}%</span>
      </div>
      <div style="padding:4px 16px 8px;font-size:12px;color:var(--text-secondary)">
        ${template.name} v${template.version} · ${_patient.name}
      </div>

      ${_unmappedAnswers.length > 0 ? `
        <div class="card" style="margin:12px;background:#fff9c4">
          <div style="font-size:13px;font-weight:600;margin-bottom:8px">历史回答（旧版本题目）</div>
          ${_unmappedAnswers.map(u => `
            <div style="font-size:13px;margin-bottom:4px">
              <strong>${Utils.escapeHTML(u.questionText)}：</strong>${Utils.escapeHTML(String(u.answer))}
            </div>
          `).join('')}
        </div>
      ` : ''}

      <div id="questions-container">
        ${_renderQuestions(_currentQuestions)}
      </div>

      <div class="btn-group" style="padding:12px 16px 24px">
        <button class="btn btn-secondary" id="btn-save-draft">保存草稿</button>
        <button class="btn btn-primary" id="btn-submit-questionnaire">提交问卷</button>
      </div>
    `;
  }

  function _renderQuestions(questions) {
    if (questions.length === 0) {
      return '<div class="empty-state"><div class="title">暂无匹配问题</div></div>';
    }
    return questions.map((q, i) => {
      const error = q.error ? `<div class="form-error">${q.error}</div>` : '';
      return `
        <div class="question-card fade-in" data-qid="${q.id}">
          <div class="question-number">问题 ${i + 1}/${questions.length}</div>
          <div class="question-text">
            ${q.text}${q.required ? ' <span style="color:var(--danger)">*</span>' : ''}
          </div>
          ${_renderInput(q)}
          ${error}
        </div>
      `;
    }).join('');
  }

  function _renderInput(q) {
    const val = q.value;
    switch (q.type) {
      case 'text':
        return `<textarea class="form-textarea" data-qid="${q.id}" rows="3"
                  placeholder="请输入...">${Utils.escapeHTML(val || '')}</textarea>`;

      case 'number':
        return `<input type="number" class="form-input" data-qid="${q.id}"
                  value="${val !== null && val !== undefined ? val : ''}"
                  placeholder="请输入数字"
                  ${q.validations?.min !== undefined ? `min="${q.validations.min}"` : ''}
                  ${q.validations?.max !== undefined ? `max="${q.validations.max}"` : ''}>`;

      case 'select':
        return `<div class="radio-group">
          ${(q.options || []).map(opt =>
            `<label class="radio-item ${val === opt ? 'selected' : ''}" data-qid="${q.id}" data-value="${Utils.escapeHTML(opt)}">
              ${Utils.escapeHTML(opt)}
            </label>`
          ).join('')}
        </div>`;

      case 'multi':
        const selected = Array.isArray(val) ? val : [];
        return `<div class="checkbox-group">
          ${(q.options || []).map(opt =>
            `<label class="checkbox-item ${selected.includes(opt) ? 'selected' : ''}" data-qid="${q.id}" data-value="${Utils.escapeHTML(opt)}">
              <input type="checkbox" value="${Utils.escapeHTML(opt)}" ${selected.includes(opt) ? 'checked' : ''} style="display:none">
              ${Utils.escapeHTML(opt)}
            </label>`
          ).join('')}
        </div>`;

      case 'boolean':
        return `<div class="radio-group">
          <label class="radio-item ${val === true ? 'selected' : ''}" data-qid="${q.id}" data-value="true">是</label>
          <label class="radio-item ${val === false ? 'selected' : ''}" data-qid="${q.id}" data-value="false">否</label>
        </div>`;

      case 'date':
        return `<input type="date" class="form-input" data-qid="${q.id}" value="${val || ''}">`;

      default:
        return `<input type="text" class="form-input" data-qid="${q.id}" value="${Utils.escapeHTML(val || '')}">`;
    }
  }

  function _bindEvents(template) {
    const container = document.getElementById('questions-container');

    // Text/number input changes
    container.addEventListener('input', e => {
      const qid = e.target.dataset.qid;
      if (qid) {
        let value = e.target.value;
        if (e.target.type === 'number') value = value === '' ? null : Number(value);
        _currentQuestions = QuestionnaireEngine.setAnswer(qid, value);
        _updateProgress();
        _refreshQuestion(qid);
      }
    });

    // Radio/select clicks
    container.addEventListener('click', e => {
      const radioItem = e.target.closest('.radio-item');
      if (radioItem) {
        const qid = radioItem.dataset.qid;
        let value = radioItem.dataset.value;
        if (value === 'true') value = true;
        else if (value === 'false') value = false;

        // Deselect siblings
        radioItem.parentElement.querySelectorAll('.radio-item').forEach(r => r.classList.remove('selected'));
        radioItem.classList.add('selected');

        _currentQuestions = QuestionnaireEngine.setAnswer(qid, value);
        _updateProgress();
        _reRenderQuestions();
        return;
      }

      const checkItem = e.target.closest('.checkbox-item');
      if (checkItem && checkItem.dataset.qid) {
        const qid = checkItem.dataset.qid;
        const optValue = checkItem.dataset.value;
        const cb = checkItem.querySelector('input[type=checkbox]');
        if (e.target !== cb) cb.checked = !cb.checked;
        checkItem.classList.toggle('selected', cb.checked);

        // Collect all selected for this question
        const selected = [];
        container.querySelectorAll(`.checkbox-item[data-qid="${qid}"]`).forEach(item => {
          if (item.querySelector('input')?.checked) selected.push(item.dataset.value);
        });

        _currentQuestions = QuestionnaireEngine.setAnswer(qid, selected);
        _updateProgress();
        _reRenderQuestions();
      }
    });

    // Save draft
    document.getElementById('btn-save-draft').addEventListener('click', () => {
      _saveDraft(template);
      Utils.showToast('草稿已保存', 'success');
    });

    // Submit
    document.getElementById('btn-submit-questionnaire').addEventListener('click', async () => {
      const validation = QuestionnaireEngine.validate();
      if (!validation.valid) {
        _currentQuestions = QuestionnaireEngine.getVisibleQuestions();
        for (const q of _currentQuestions) {
          if (validation.errors[q.id]) q.error = validation.errors[q.id];
        }
        _reRenderQuestions();
        Utils.showToast('请完成所有必填项', 'warning');
        return;
      }

      const answers = QuestionnaireEngine.getAnswers();
      const questionnaireData = {
        templateId: template.id,
        templateName: template.name,
        version: template.version,
        diseaseType: template.diseaseType,
        answers: answers,
        completedAt: Utils.now()
      };

      // Save as visit record
      const visit = {
        id: Utils.uuid(),
        patientId: _patient.id,
        date: Utils.today(),
        questionnaires: [questionnaireData],
        riskLevel: 'none',
        isDraft: false,
        syncStatus: 'pending'
      };

      try {
        await DB.saveVisit(visit);
        await DB.clearDraft('questionnaire', _patient.id);
        _stopDraftAutosave();
        Utils.showToast('问卷已提交', 'success');
        App.navigate('detail', { patientId: _patient.id });
      } catch (err) {
        Utils.showToast('保存失败: ' + err.message, 'error');
      }
    });

    // Back button
    document.getElementById('btn-back').onclick = async () => {
      const answers = QuestionnaireEngine.getAnswers();
      if (Object.keys(answers).length > 0) {
        const choice = await Utils.showModal(
          '离开确认',
          '<p>当前问卷尚未提交，是否保存为草稿？</p>',
          [
            { label: '不保存', value: 'discard' },
            { label: '保存草稿', value: 'save', primary: true },
            { label: '取消', value: 'cancel' }
          ]
        );
        if (choice === 'cancel') return;
        if (choice === 'save') await _saveDraft(template);
      }
      _stopDraftAutosave();
      App.navigate('detail', { patientId: _patient.id });
    };
  }

  function _updateProgress() {
    const progress = QuestionnaireEngine.getProgress();
    const fill = document.querySelector('.progress-fill');
    const text = document.querySelector('.progress-text');
    if (fill) fill.style.width = progress + '%';
    if (text) text.textContent = progress + '%';
  }

  function _refreshQuestion(qid) {
    // Re-check if any dependent questions need to show/hide
    _reRenderQuestions();
  }

  function _reRenderQuestions() {
    _currentQuestions = QuestionnaireEngine.getVisibleQuestions();
    const container = document.getElementById('questions-container');
    if (container) container.innerHTML = _renderQuestions(_currentQuestions);
  }

  async function _saveDraft(template) {
    const answers = QuestionnaireEngine.getAnswers();
    await DB.saveDraft('questionnaire', {
      patientId: _patient.id,
      templateId: template.id,
      answers: answers,
      answerCount: Object.keys(answers).length,
      savedAt: Utils.now()
    });
  }

  function _startDraftAutosave(template) {
    _draftTimer = setInterval(() => {
      const answers = QuestionnaireEngine.getAnswers();
      if (Object.keys(answers).length > 0) {
        _saveDraft(template);
      }
    }, 30000);
  }

  function _stopDraftAutosave() {
    if (_draftTimer) {
      clearInterval(_draftTimer);
      _draftTimer = null;
    }
  }

  return { render };
})();
