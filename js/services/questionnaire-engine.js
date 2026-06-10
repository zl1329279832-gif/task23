export const questionnaireEngine = {
  computeVisibleQuestions(schema, answers, patientContext) {
    if (!schema || !schema.sections) return [];

    return schema.sections.map(section => {
      const visibleQuestions = section.questions
        .filter(q => this._isVisible(q.showWhen, answers, patientContext))
        .map(q => ({
          ...q,
          currentValue: answers[q.field] !== undefined ? answers[q.field] : null
        }));

      return {
        id: section.id,
        title: section.title,
        questions: visibleQuestions
      };
    }).filter(section => section.questions.length > 0);
  },

  _isVisible(showWhen, answers, patientContext) {
    if (!showWhen) return true;

    const { operator, conditions } = showWhen;
    if (!conditions || conditions.length === 0) return true;

    if (operator === 'OR') {
      return conditions.some(c => this.evaluateCondition(c, answers, patientContext));
    }
    return conditions.every(c => this.evaluateCondition(c, answers, patientContext));
  },

  evaluateCondition(condition, answers, patientContext) {
    const { field, op, value } = condition;

    let actual;
    if (field.startsWith('$patient.')) {
      const key = field.slice('$patient.'.length);
      actual = patientContext ? patientContext[key] : undefined;
    } else {
      actual = answers[field];
    }

    if (actual === undefined || actual === null) {
      if (op === 'neq') return value !== null && value !== undefined;
      return false;
    }

    switch (op) {
      case 'eq':
        return actual === value;
      case 'neq':
        return actual !== value;
      case 'gt':
        return Number(actual) > Number(value);
      case 'gte':
        return Number(actual) >= Number(value);
      case 'lt':
        return Number(actual) < Number(value);
      case 'lte':
        return Number(actual) <= Number(value);
      case 'in':
        if (Array.isArray(value)) return value.includes(actual);
        if (Array.isArray(actual)) return actual.some(v => value.includes(v));
        return false;
      case 'contains':
        if (Array.isArray(actual)) return actual.includes(value);
        if (typeof actual === 'string') return actual.includes(value);
        return false;
      default:
        console.warn(`Unknown condition operator: ${op}`);
        return false;
    }
  },

  computeRiskScore(schema, answers) {
    if (!schema || !schema.computedFields) return {};

    const results = {};
    for (const computed of schema.computedFields) {
      const { id, formula } = computed;
      try {
        results[id] = this._evaluateFormula(formula, answers);
      } catch (e) {
        console.error(`Error computing ${id}:`, e);
        results[id] = null;
      }
    }
    return results;
  },

  _evaluateFormula(formula, answers) {
    if (!formula || !formula.rules) return 0;

    let score = formula.base || 0;

    for (const rule of formula.rules) {
      const value = answers[rule.field];
      if (value === undefined || value === null) continue;

      if (rule.type === 'map') {
        const mapped = rule.scores[value];
        if (mapped !== undefined) score += mapped;
      } else if (rule.type === 'range') {
        const num = Number(value);
        for (const range of rule.ranges) {
          const aboveMin = range.min === undefined || num >= range.min;
          const belowMax = range.max === undefined || num <= range.max;
          if (aboveMin && belowMax) {
            score += range.score;
            break;
          }
        }
      } else if (rule.type === 'boolean') {
        if (value === true || value === 'yes') {
          score += rule.score || 0;
        }
      } else if (rule.type === 'count') {
        if (Array.isArray(value)) {
          score += value.length * (rule.scorePerItem || 0);
        }
      }
    }

    if (formula.min !== undefined) score = Math.max(formula.min, score);
    if (formula.max !== undefined) score = Math.min(formula.max, score);

    return score;
  },

  migrateAnswers(oldAnswers, migration) {
    if (!migration || !migration.fieldMappings) return { ...oldAnswers };

    const newAnswers = {};
    const mappedOldFields = new Set();

    for (const mapping of migration.fieldMappings) {
      const { oldField, newField, transform } = mapping;
      mappedOldFields.add(oldField);

      if (oldField && oldAnswers[oldField] !== undefined) {
        if (!transform || transform === 'rename') {
          newAnswers[newField] = oldAnswers[oldField];
        } else if (typeof transform === 'object' && transform !== null) {
          const mapped = transform[oldAnswers[oldField]];
          newAnswers[newField] = mapped !== undefined ? mapped : oldAnswers[oldField];
        }
      } else if (!oldField && newField) {
        newAnswers[newField] = null;
      }
    }

    for (const key of Object.keys(oldAnswers)) {
      if (!mappedOldFields.has(key) && newAnswers[key] === undefined) {
        newAnswers[key] = oldAnswers[key];
      }
    }

    if (migration.addedFields) {
      for (const field of migration.addedFields) {
        if (newAnswers[field] === undefined) {
          newAnswers[field] = null;
        }
      }
    }

    return newAnswers;
  }
};
