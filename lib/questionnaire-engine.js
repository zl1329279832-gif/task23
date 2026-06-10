// 动态问卷引擎 - 条件分支 + 版本管理 + 旧答案迁移 + 模板版本追踪
const QuestionnaireEngine = (() => {
  let _templates = {};
  let _currentTemplate = null;
  let _currentAnswers = {};
  let _patient = null;
  let _migrationLog = []; // 迁移日志

  // 条件运算符
  const operators = {
    eq: (a, b) => a === b,
    ne: (a, b) => a !== b,
    gt: (a, b) => Number(a) > Number(b),
    lt: (a, b) => Number(a) < Number(b),
    gte: (a, b) => Number(a) >= Number(b),
    lte: (a, b) => Number(a) <= Number(b),
    in: (a, b) => (Array.isArray(b) ? b.includes(a) : String(a).includes(String(b))),
    not_empty: (a) => a !== null && a !== undefined && a !== '' && a !== null,
  };

  async function loadTemplates() {
    const templates = await DB.getAllTemplates();
    _templates = {};
    templates.forEach(t => {
      if (!_templates[t.diseaseType]) _templates[t.diseaseType] = [];
      _templates[t.diseaseType].push(t);
    });
    // Sort by version descending
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

  // 初始化问卷
  function startQuestionnaire(template, patient, previousAnswers) {
    _currentTemplate = template;
    _patient = patient;
    _currentAnswers = previousAnswers ? { ...previousAnswers } : {};
    _migrationLog = [];
    return getVisibleQuestions();
  }

  // 获取当前可见的问题列表
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

  // 判断问题是否应该显示
  function shouldShowQuestion(question) {
    // 检查患者条件
    if (question.conditions) {
      const conds = Array.isArray(question.conditions) ? question.conditions : [question.conditions];
      for (const cond of conds) {
        if (!evaluateCondition(cond)) return false;
      }
    }
    // 检查依赖条件
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

  // 评估单个条件
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

  // 设置答案
  function setAnswer(questionId, value) {
    _currentAnswers[questionId] = value;
    clearHiddenAnswers();
    return getVisibleQuestions();
  }

  // 清除隐藏问题的答案
  function clearHiddenAnswers() {
    if (!_currentTemplate) return;
    for (const q of _currentTemplate.questions) {
      if (!shouldShowQuestion(q)) {
        delete _currentAnswers[q.id];
      }
    }
  }

  // 验证所有可见问题
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

  // 验证单个问题
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

  // 获取所有答案
  function getAnswers() {
    return { ..._currentAnswers };
  }

  /**
   * 版本迁移 - 将旧版本答案映射到新版本模板
   * 增强版：追踪迁移日志，标记新旧模板共有字段和新增字段
   *
   * @returns {{ answers: Object, migrated: Array, unmapped: Array,
   *             newQuestions: Array, removedQuestions: Array,
   *             oldTemplateId: string, oldVersion: number, newVersion: number }}
   */
  function migrateAnswers(oldTemplateId, oldVersion, oldAnswers, newDiseaseType) {
    const newTemplate = getLatestTemplate(newDiseaseType);
    if (!newTemplate) return {
      answers: oldAnswers, migrated: [], unmapped: [],
      newQuestions: [], removedQuestions: [],
      oldTemplateId, oldVersion, newVersion: 0
    };

    const oldTemplate = getTemplate(oldTemplateId, oldVersion);
    const migrated = [];
    const unmapped = [];
    const newQuestions = [];
    const removedQuestions = [];
    const newAnswers = {};

    // 建立旧问题集合
    const oldQuestionIds = new Set();
    if (oldTemplate) {
      oldTemplate.questions.forEach(q => oldQuestionIds.add(q.id));
    }

    // 新问题集合
    const newQuestionIds = new Set();
    newTemplate.questions.forEach(q => newQuestionIds.add(q.id));

    // 1. 按 ID 匹配迁移答案
    newTemplate.questions.forEach(nq => {
      if (oldAnswers[nq.id] !== undefined) {
        newAnswers[nq.id] = oldAnswers[nq.id];
        migrated.push({
          questionId: nq.id,
          text: nq.text,
          value: oldAnswers[nq.id],
          status: 'migrated'
        });
      } else if (!oldQuestionIds.has(nq.id)) {
        // 新模板中新增的问题
        newQuestions.push({
          questionId: nq.id,
          text: nq.text,
          required: nq.required
        });
      }
    });

    // 2. 找出旧模板中被移除的问题
    if (oldTemplate) {
      oldTemplate.questions.forEach(oq => {
        if (!newQuestionIds.has(oq.id)) {
          removedQuestions.push({
            questionId: oq.id,
            text: oq.text,
            answer: oldAnswers[oq.id]
          });
        }
      });
    }

    // 3. 未匹配到的旧答案
    Object.keys(oldAnswers).forEach(qId => {
      if (!migrated.find(m => m.questionId === qId)) {
        const oldQ = oldTemplate?.questions?.find(q => q.id === qId);
        unmapped.push({
          questionId: qId,
          questionText: oldQ ? oldQ.text : qId,
          answer: oldAnswers[qId]
        });
      }
    });

    _migrationLog = { migrated, unmapped, newQuestions, removedQuestions };

    return {
      answers: newAnswers,
      migrated, unmapped, newQuestions, removedQuestions,
      oldTemplateId, oldVersion,
      newVersion: newTemplate.version
    };
  }

  // 获取问卷完成进度
  function getProgress() {
    const questions = getVisibleQuestions();
    if (questions.length === 0) return 100;
    const answered = questions.filter(q => {
      const v = _currentAnswers[q.id];
      return v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0);
    }).length;
    return Math.round((answered / questions.length) * 100);
  }

  // 获取迁移日志
  function getMigrationLog() {
    return _migrationLog;
  }

  // 获取当前模板信息
  function getCurrentTemplate() {
    return _currentTemplate;
  }

  return {
    loadTemplates, getLatestTemplate, getTemplate,
    startQuestionnaire, getVisibleQuestions, setAnswer,
    validate, getAnswers, getProgress,
    migrateAnswers, shouldShowQuestion,
    getMigrationLog, getCurrentTemplate
  };
})();
