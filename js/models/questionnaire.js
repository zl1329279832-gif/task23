import { db } from '../core/db.js';
import { STORES } from '../core/config.js';

const SCHEMA_STORE = STORES.QUESTIONNAIRE_SCHEMAS;
const FOLLOWUP_STORE = STORES.FOLLOWUPS;

export const questionnaireModel = {
  async getSchema(diseaseType, version) {
    const schemas = await db.getAllByIndex(SCHEMA_STORE, 'diseaseType', diseaseType);
    return schemas.find(s => s.version === version) || null;
  },

  async getLatestSchema(diseaseType) {
    const schemas = await db.getAllByIndex(SCHEMA_STORE, 'diseaseType', diseaseType);
    if (!schemas.length) return null;
    schemas.sort((a, b) => b.version - a.version);
    return schemas[0];
  },

  async saveSchema(schema) {
    const record = { ...schema };
    if (!record.id) {
      record.id = `${record.diseaseType}-v${record.version}`;
    }
    return db.put(SCHEMA_STORE, record);
  },

  async saveAnswers(followupId, answers) {
    const followup = await db.get(FOLLOWUP_STORE, followupId);
    if (!followup) throw new Error(`Followup not found: ${followupId}`);
    followup.questionnaireAnswers = answers;
    followup.questionnaireCompletedAt = Date.now();
    return db.put(FOLLOWUP_STORE, followup);
  },

  migrateAnswers(oldAnswers, migration) {
    if (!migration || !migration.fieldMappings) return { ...oldAnswers };

    const newAnswers = {};
    const mappedOldFields = new Set();

    for (const mapping of migration.fieldMappings) {
      const { oldField, newField, transform } = mapping;
      mappedOldFields.add(oldField);

      if (oldField && oldAnswers[oldField] !== undefined) {
        if (transform === 'rename') {
          newAnswers[newField] = oldAnswers[oldField];
        } else if (typeof transform === 'function') {
          newAnswers[newField] = transform(oldAnswers[oldField]);
        } else if (typeof transform === 'object' && transform !== null) {
          const mapped = transform[oldAnswers[oldField]];
          newAnswers[newField] = mapped !== undefined ? mapped : oldAnswers[oldField];
        } else {
          newAnswers[newField] = oldAnswers[oldField];
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
