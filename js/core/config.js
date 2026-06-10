export const APP_NAME = '基层随访系统';
export const DB_NAME = 'medical_followup_db';
export const DB_VERSION = 1;

export const STORES = {
  PATIENTS: 'patients',
  FOLLOWUPS: 'followups',
  VITAL_SIGNS: 'vital_signs',
  ATTACHMENTS: 'attachments',
  QUESTIONNAIRE_SCHEMAS: 'questionnaire_schemas',
  SYNC_QUEUE: 'sync_queue',
  DRAFTS: 'drafts',
  REMINDERS: 'reminders',
  CORRUPTION_LOG: 'corruption_log'
};

export const API_BASE = '/api/v1';

export const SYNC = {
  MAX_RETRIES: 10,
  BASE_DELAY: 1000,
  MAX_DELAY: 60000,
  ONLINE_DEBOUNCE: 2000
};

export const CRYPTO = {
  PBKDF2_ITERATIONS: 310000,
  SALT_LENGTH: 16,
  IV_LENGTH: 12,
  KEY_LENGTH: 256,
  ALGO: 'AES-GCM'
};

export const DRAFT = {
  SAVE_DEBOUNCE: 2000
};

export const IMAGE = {
  MAX_DIMENSION: 1200,
  QUALITY: 0.7,
  MAX_SIZE_KB: 200
};

export const DUPLICATE_WINDOW_DAYS = 7;

export const INTEGRITY_CHECK_INTERVAL = 30 * 60 * 1000;

export const RISK_LEVELS = [
  { level: 1, label: '低危', color: 'var(--risk-1)' },
  { level: 2, label: '中危', color: 'var(--risk-2)' },
  { level: 3, label: '高危', color: 'var(--risk-3)' },
  { level: 4, label: '极高危', color: 'var(--risk-4)' }
];

export const DISEASE_TYPES = [
  { value: 'hypertension', label: '高血压' },
  { value: 'diabetes', label: '糖尿病' },
  { value: 'chd', label: '冠心病' },
  { value: 'stroke', label: '脑卒中' },
  { value: 'copd', label: '慢阻肺' },
  { value: 'mental', label: '精神障碍' }
];

export const REMINDER_INTERVALS = {
  hypertension: { 1: 90, 2: 60, 3: 30, 4: 14 },
  diabetes: { 1: 90, 2: 60, 3: 30, 4: 14 },
  chd: { 1: 90, 2: 60, 3: 30, 4: 14 },
  stroke: { 1: 90, 2: 60, 3: 30, 4: 14 },
  copd: { 1: 90, 2: 60, 3: 30, 4: 14 },
  mental: { 1: 90, 2: 60, 3: 30, 4: 14 }
};
