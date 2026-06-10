// 动态问卷引擎 - 条件分支 + 版本管理 + 旧答案回显 + 模板版本校验
const QuestionnaireEngine = (() => {
  let _templates = {};
  let _currentTemplate = null;
  let _currentAnswers = {};
  let _patient = null;
  let _templateMeta = null; // 记录当前问卷的模板元信息

  // 条件运算符
  const operators = {
    eq: (a, b) => a === b,
    ne: (a, b) => a !== b,
    gt: (a, b) => Number(a) > Number(b),
    lt: (a, b) => Number(a) < Number(b),
    gte: (a, b) => Number(a) >= Number(b),
    lte: (a, b) => Number(a) <= Number(b),
    in: (a, b) => (Array.isArray(b) ? b.includes(a) : String(a).includes(String(b))),
    not_empty: (a) => a !== null && a !== undefined && a !== '',
  };

  async function loadTemplates() {
    const templates = await DB.getAllTemplates();
    _templates = {};
    templates.forEach(t => {
      if (!_templates[t.diseaseType]) _templates[t.diseaseType] = [];
      _templates[t.diseaseType].push(t);
    });
    for (const type of Object.keys(_templates)) {
      _templates[type].sort((a, b) => b.version - a.version);
    }
  }

  function getLatestTemplate(diseaseType) {
    if (!_templates[diseaseType] || _templates[diseaseType].length === 0) return null;
    return _templates[diseaseType][0];
  }

  function getTemplate(templateId, version) {
    for (const type of Object.values(_templates)) {
      const found = type.find(t => t.id === templateId && (!version || t.version === version));
      if (found) return found;
    }
    return null;
  }

  // 初始化问卷，记录模板元信息
  function startQuestionnaire(template, patient, previousAnswers) {
    _currentTemplate = template;
    _patient = patient;
    _currentAnswers = previousAnswers ? { ...previousAnswers } : {};
    _templateMeta = {
      templateId: template.id,
      templateVersion: template.version,
      diseaseType: template.diseaseType
    };
    return getVisibleQuestions();
  }

  // 获取当前问卷的模板元信息（用于保存到 visit 记录）
  function getTemplateMeta() {
    return _templateMeta ? { ..._templateMeta } : null;
  }

  function getVisibleQuestions() {
    if (!_currentTemplate || !_patient) return [];
    const questions = _currentTemplate.questions || [];
    const visible = [];

    for (const q of questions) {
      if (shouldShowQuestion(q)) {
        visible.push({
          ...q,
          value: _currentAnswers[q.id] !== undefined ? _currentAnswers[q.id] : null,
          error: null
        });
      }
    }
    return visible;
  }

  function shouldShowQuestion(question) {
    if (question.conditions) {
      const conds = Array.isArray(question.conditions) ? question.conditions : [question.conditions];
      for (const cond of conds) {
        if (!evaluateCondition(cond)) return false;
      }
    }
    if (question.dependsOn) {
      const deps = Array.isArray(question.dependsOn) ? question.dependsOn : [question.dependsOn];
      for (const dep of deps) {
        const depAnswer = _currentAnswers[dep.questionId];
        if (dep.answerValue !== undefined) {
          if (Array.isArray(dep.answerValue)) {
            if (!dep.answerValue.includes(depAnswer)) return false;
          } else if (depAnswer !== dep.answerValue) {
            return false;
          }
        } else if (depAnswer === null || depAnswer === undefined || depAnswer === '') {
          return false;
        }
      }
    }
    return true;
  }

  function evaluateCondition(condition) {
    let fieldValue;
    switch (condition.field) {
      case 'age': fieldValue = _patient.age; break;
      case 'gender': fieldValue = _patient.gender; break;
      case 'diseaseType':
      case 'diseases':
        fieldValue = _patient.diseases || [];
        if (condition.operator === 'in') {
          return operators.in(condition.value, fieldValue);
        }
        return fieldValue.includes(condition.value);
      default:
        fieldValue = _currentAnswers[condition.field];
    }
    const op = operators[condition.operator];
    if (!op) return true;
    return op(fieldValue, condition.value);
  }

  function setAnswer(questionId, value) {
    _currentAnswers[questionId] = value;
    clearHiddenAnswers();
    return getVisibleQuestions();
  }

  function clearHiddenAnswers() {
    if (!_currentTemplate) return;
    for (const q of _currentTemplate.questions) {
      if (!shouldShowQuestion(q)) {
        delete _currentAnswers[q.id];
      }
    }
  }

  function validate() {
    const questions = getVisibleQuestions();
    let valid = true;
    const errors = {};

    for (const q of questions) {
      const error = validateQuestion(q);
      if (error) {
        valid = false;
        errors[q.id] = error;
      }
    }
    return { valid, errors };
  }

  function validateQuestion(question) {
    const value = _currentAnswers[question.id];

    if (question.required) {
      if (value === null || value === undefined || value === '' ||
          (Array.isArray(value) && value.length === 0)) {
        return '此项为必填';
      }
    }

    if (value !== null && value !== undefined && value !== '' && question.validations) {
      const v = question.validations;
      if (v.min !== undefined && Number(value) < v.min) return `最小值为 ${v.min}`;
      if (v.max !== undefined && Number(value) > v.max) return `最大值为 ${v.max}`;
      if (v.pattern) {
        const regex = new RegExp(v.pattern);
        if (!regex.test(String(value))) return v.message || '格式不正确';
      }
    }
    return null;
  }

  function getAnswers() {
    return { ..._currentAnswers };
  }

  // 验证答案是否与模板 schema 兼容
  function validateAnswersAgainstTemplate(answers, template) {
    if (!template || !template.questions) return { valid: true, incompatible: [] };

    const questionMap = {};
    template.questions.forEach(q => { questionMap[q.id] = q; });

    const incompatible = [];
    const validAnswers = {};

    for (const [qId, answer] of Object.entries(answers)) {
      const question = questionMap[qId];
      if (!question) {
        // 答案对应的问题在新模板中不存在
        incompatible.push({
          questionId: qId,
          reason: 'question_removed',
          answer
        });
        continue;
      }

      // 检查答案类型与问题类型是否匹配
      const typeCheck = _checkAnswerType(answer, question);
      if (!typeCheck.valid) {
        incompatible.push({
          questionId: qId,
          questionText: question.text,
          reason: 'type_mismatch',
          expectedType: question.type,
          answer,
          detail: typeCheck.detail
        });
        continue;
      }

      // 检查选项类题目的值是否仍在可选范围内
      const optionCheck = _checkAnswerOptions(answer, question);
      if (!optionCheck.valid) {
        incompatible.push({
          questionId: qId,
          questionText: question.text,
          reason: 'option_invalid',
          answer,
          detail: optionCheck.detail
        });
        continue;
      }

      validAnswers[qId] = answer;
    }

    return {
      valid: incompatible.length === 0,
      validAnswers,
      incompatible
    };
  }

  // 检查答案类型
  function _checkAnswerType(answer, question) {
    if (answer === null || answer === undefined || answer === '') {
      return { valid: true };
    }
    switch (question.type) {
      case 'number':
      case 'range':
        if (isNaN(Number(answer))) return { valid: false, detail: `期望数值，实际为 "${answer}"` };
        break;
      case 'select':
      case 'radio':
        if (typeof answer !== 'string' && typeof answer !== 'number') {
          return { valid: false, detail: `期望单选值，实际为 ${typeof answer}` };
        }
        break;
      case 'multiselect':
      case 'checkbox':
        if (!Array.isArray(answer)) {
          return { valid: false, detail: `期望数组，实际为 ${typeof answer}` };
        }
        break;
      case 'boolean':
        if (typeof answer !== 'boolean' && answer !== 'true' && answer !== 'false') {
          return { valid: false, detail: `期望布尔值` };
        }
        break;
    }
    return { valid: true };
  }

  // 检查选项值是否仍有效
  function _checkAnswerOptions(answer, question) {
    if (!question.options || question.options.length === 0) return { valid: true };
    const validValues = question.options.map(o => typeof o === 'object' ? o.value : o);

    if (question.type === 'multiselect' || question.type === 'checkbox') {
      if (Array.isArray(answer)) {
        const invalid = answer.filter(v => !validValues.includes(v));
        if (invalid.length > 0) {
          return { valid: false, detail: `选项 ${invalid.join(', ')} 已不存在` };
        }
      }
    } else if (question.type === 'select' || question.type === 'radio') {
      if (answer !== '' && answer !== null && !validValues.includes(answer)) {
        return { valid: false, detail: `选项 "${answer}" 已不存在` };
      }
    }
    return { valid: true };
  }

  // 检查两个模板版本是否可以自动合并
  function areTemplateVersionsCompatible(templateA, templateB) {
    if (!templateA || !templateB) return { compatible: false, reason: '模板不存在' };
    if (templateA.id !== templateB.id && templateA.diseaseType !== templateB.diseaseType) {
      return { compatible: false, reason: '不同疾病类型的模板' };
    }
    if (templateA.version === templateB.version) {
      return { compatible: true, reason: '相同版本' };
    }

    // 不同版本：检查问题结构差异
    const aQuestions = new Map((templateA.questions || []).map(q => [q.id, q]));
    const bQuestions = new Map((templateB.questions || []).map(q => [q.id, q]));

    const removed = [];
    const typeChanged = [];
    const added = [];

    for (const [id, q] of aQuestions) {
      if (!bQuestions.has(id)) {
        removed.push(id);
      } else {
        const bq = bQuestions.get(id);
        if (q.type !== bq.type) {
          typeChanged.push({ id, oldType: q.type, newType: bq.type });
        }
      }
    }
    for (const id of bQuestions.keys()) {
      if (!aQuestions.has(id)) added.push(id);
    }

    if (typeChanged.length > 0) {
      return {
        compatible: false,
        reason: '问题类型已变更',
        details: { removed, typeChanged, added }
      };
    }

    // 有问题被删除或新增，但类型未变的可以部分自动合并
    return {
      compatible: removed.length === 0,
      reason: removed.length > 0 ? '部分问题已移除' : '可兼容合并',
      details: { removed, typeChanged, added }
    };
  }

  // 标记不兼容字段（用于冲突视图强制人工处理）
  function flagIncompatibleFields(oldTemplate, newTemplate, answers) {
    const result = { autoMergeable: {}, manualRequired: {} };
    if (!oldTemplate || !newTemplate) {
      result.manualRequired = answers;
      return result;
    }

    const newQuestionMap = {};
    (newTemplate.questions || []).forEach(q => { newQuestionMap[q.id] = q; });

    for (const [qId, answer] of Object.entries(answers)) {
      const newQ = newQuestionMap[qId];
      if (!newQ) {
        // 问题在新模板中已不存在 → 必须人工处理
        result.manualRequired[qId] = { answer, reason: '该问题已从新模板中移除' };
      } else {
        const typeCheck = _checkAnswerType(answer, newQ);
        const optionCheck = _checkAnswerOptions(answer, newQ);
        if (typeCheck.valid && optionCheck.valid) {
          result.autoMergeable[qId] = answer;
        } else {
          result.manualRequired[qId] = {
            answer,
            reason: typeCheck.valid ? optionCheck.detail : typeCheck.detail
          };
        }
      }
    }
    return result;
  }

  // 版本迁移 - 将旧版本答案映射到新版本模板（增强版）
  function migrateAnswers(oldTemplateId, oldVersion, oldAnswers, newDiseaseType) {
    const newTemplate = getLatestTemplate(newDiseaseType);
    if (!newTemplate) return { answers: oldAnswers, migrated: [], unmapped: [], incompatible: [] };

    const oldTemplate = getTemplate(oldTemplateId, oldVersion);
    const migrated = [];
    const unmapped = [];
    const newAnswers = {};

    if (oldTemplate) {
      const oldQuestionMap = {};
      oldTemplate.questions.forEach(q => { oldQuestionMap[q.id] = q; });

      // 按 ID 匹配并验证 schema 兼容性
      newTemplate.questions.forEach(nq => {
        if (oldAnswers[nq.id] !== undefined) {
          newAnswers[nq.id] = oldAnswers[nq.id];
          migrated.push(nq.id);
        }
      });

      Object.keys(oldAnswers).forEach(qId => {
        if (!migrated.includes(qId)) {
          unmapped.push({
            questionId: qId,
            questionText: oldQuestionMap[qId] ? oldQuestionMap[qId].text : qId,
            answer: oldAnswers[qId]
          });
        }
      });
    } else {
      newTemplate.questions.forEach(nq => {
        if (oldAnswers[nq.id] !== undefined) {
          newAnswers[nq.id] = oldAnswers[nq.id];
          migrated.push(nq.id);
        }
      });
    }

    // 验证迁移后的答案与新模板的兼容性
    const validation = validateAnswersAgainstTemplate(newAnswers, newTemplate);

    return {
      answers: validation.valid ? newAnswers : validation.validAnswers,
      migrated,
      unmapped,
      incompatible: validation.incompatible || [],
      templateMeta: {
        templateId: newTemplate.id,
        templateVersion: newTemplate.version,
        fromTemplateId: oldTemplateId,
        fromVersion: oldVersion
      }
    };
  }

  function getProgress() {
    const questions = getVisibleQuestions();
    if (questions.length === 0) return 100;
    const answered = questions.filter(q => {
      const v = _currentAnswers[q.id];
      return v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0);
    }).length;
    return Math.round((answered / questions.length) * 100);
  }

  return {
    loadTemplates, getLatestTemplate, getTemplate,
    startQuestionnaire, getVisibleQuestions, setAnswer,
    validate, getAnswers, getProgress, getTemplateMeta,
    migrateAnswers, shouldShowQuestion,
    validateAnswersAgainstTemplate, areTemplateVersionsCompatible,
    flagIncompatibleFields
  };
})();
