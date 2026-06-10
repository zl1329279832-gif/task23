import { db } from './core/db.js';
import { cryptoManager } from './core/crypto.js';
import { STORES } from './core/config.js';
import { generateId } from './utils/uid.js';

const SAMPLE_PATIENTS = [
  {
    id: 'p001', name: '张建国', diseaseType: 'hypertension', riskLevel: 2,
    assignedDoctor: 'doc001', _version: 1, _syncStatus: 'synced',
    gender: '男', birthDate: '1955-03-15', idCardNumber: '320102195503150011',
    phone: '13800001111', address: '幸福路12号',
    medicalHistory: '高血压病史8年，2018年曾住院治疗', allergies: '青霉素过敏',
    emergencyContact: '张小明 13900001111'
  },
  {
    id: 'p002', name: '李秀英', diseaseType: 'diabetes', riskLevel: 3,
    assignedDoctor: 'doc001', _version: 1, _syncStatus: 'synced',
    gender: '女', birthDate: '1960-08-22', idCardNumber: '320102196008220028',
    phone: '13800002222', address: '建设街45号',
    medicalHistory: '2型糖尿病12年，伴高血压5年', allergies: '无',
    emergencyContact: '李强 13900002222'
  },
  {
    id: 'p003', name: '王德明', diseaseType: 'hypertension', riskLevel: 1,
    assignedDoctor: 'doc001', _version: 1, _syncStatus: 'synced',
    gender: '男', birthDate: '1968-11-05', idCardNumber: '320102196811050033',
    phone: '13800003333', address: '和平巷8号',
    medicalHistory: '高血压3年，控制良好', allergies: '磺胺类过敏',
    emergencyContact: '王芳 13900003333'
  },
  {
    id: 'p004', name: '赵玉兰', diseaseType: 'diabetes', riskLevel: 2,
    assignedDoctor: 'doc001', _version: 1, _syncStatus: 'synced',
    gender: '女', birthDate: '1952-05-18', idCardNumber: '320102195205180044',
    phone: '13800004444', address: '民主路23号',
    medicalHistory: '糖尿病15年，近期血糖波动', allergies: '无',
    emergencyContact: '赵明 13900004444'
  },
  {
    id: 'p005', name: '刘志强', diseaseType: 'chd', riskLevel: 4,
    assignedDoctor: 'doc001', _version: 1, _syncStatus: 'synced',
    gender: '男', birthDate: '1948-12-30', idCardNumber: '320102194812300055',
    phone: '13800005555', address: '解放大道56号',
    medicalHistory: '冠心病10年，2020年放置支架2枚，高血压20年', allergies: '碘造影剂过敏',
    emergencyContact: '刘洋 13900005555'
  },
  {
    id: 'p006', name: '陈桂花', diseaseType: 'hypertension', riskLevel: 3,
    assignedDoctor: 'doc001', _version: 1, _syncStatus: 'synced',
    gender: '女', birthDate: '1958-07-08', idCardNumber: '320102195807080066',
    phone: '13800006666', address: '文化路78号',
    medicalHistory: '高血压10年，伴糖尿病前期', allergies: '无',
    emergencyContact: '陈刚 13900006666'
  },
  {
    id: 'p007', name: '孙永福', diseaseType: 'stroke', riskLevel: 3,
    assignedDoctor: 'doc001', _version: 1, _syncStatus: 'synced',
    gender: '男', birthDate: '1950-01-20', idCardNumber: '320102195001200077',
    phone: '13800007777', address: '复兴街34号',
    medicalHistory: '脑卒中后遗症2年，左侧肢体活动受限', allergies: '无',
    emergencyContact: '孙丽 13900007777'
  },
  {
    id: 'p008', name: '周美华', diseaseType: 'copd', riskLevel: 2,
    assignedDoctor: 'doc001', _version: 1, _syncStatus: 'synced',
    gender: '女', birthDate: '1945-09-12', idCardNumber: '320102194509120088',
    phone: '13800008888', address: '新华路67号',
    medicalHistory: '慢阻肺8年，长期家庭氧疗', allergies: '无',
    emergencyContact: '周伟 13900008888'
  }
];

const ENCRYPTED_FIELDS = ['gender', 'birthDate', 'idCardNumber', 'phone', 'address', 'medicalHistory', 'allergies', 'emergencyContact'];

export async function seedData() {
  const existingCount = await db.count(STORES.PATIENTS);
  if (existingCount > 0) return false;

  for (const patient of SAMPLE_PATIENTS) {
    await db.put(STORES.PATIENTS, patient, ENCRYPTED_FIELDS);
  }

  // Load questionnaire schemas from JSON files
  try {
    const [htResponse, dmResponse] = await Promise.all([
      fetch('./data/questionnaire-schemas/hypertension-v1.json'),
      fetch('./data/questionnaire-schemas/diabetes-v1.json')
    ]);

    if (htResponse.ok) {
      const htSchema = await htResponse.json();
      await db.putRaw(STORES.QUESTIONNAIRE_SCHEMAS, htSchema);
    }
    if (dmResponse.ok) {
      const dmSchema = await dmResponse.json();
      await db.putRaw(STORES.QUESTIONNAIRE_SCHEMAS, dmSchema);
    }
  } catch (e) {
    console.warn('Failed to load questionnaire schemas:', e);
  }

  // Create sample reminders
  const now = Date.now();
  const DAY = 86400000;
  const reminders = [
    { id: generateId(), patientId: 'p001', dueDate: now - 3 * DAY, reason: '高血压随访复查', status: 'pending', createdAt: now - 33 * DAY },
    { id: generateId(), patientId: 'p002', dueDate: now, reason: '糖尿病随访复查', status: 'pending', createdAt: now - 30 * DAY },
    { id: generateId(), patientId: 'p005', dueDate: now + 2 * DAY, reason: '冠心病随访复查', status: 'pending', createdAt: now - 12 * DAY },
    { id: generateId(), patientId: 'p006', dueDate: now + 7 * DAY, reason: '高血压随访复查', status: 'pending', createdAt: now - 23 * DAY },
    { id: generateId(), patientId: 'p007', dueDate: now + 14 * DAY, reason: '脑卒中随访复查', status: 'pending', createdAt: now - 16 * DAY }
  ];
  for (const r of reminders) {
    await db.putRaw(STORES.REMINDERS, r);
  }

  return true;
}
