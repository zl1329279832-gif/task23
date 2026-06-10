import { reminderModel } from '../models/reminder.js';
import { REMINDER_INTERVALS } from '../core/config.js';
import { addDays } from '../utils/date.js';

const reminderScheduler = {
  async scheduleAfterFollowup(patient, followupId) {
    const diseaseType = patient.diseaseType;
    const riskLevel = patient.riskLevel || 2;
    const intervals = REMINDER_INTERVALS[diseaseType] || REMINDER_INTERVALS.hypertension;
    const daysUntilNext = intervals[riskLevel] || 60;
    const dueDate = addDays(Date.now(), daysUntilNext);

    const diseaseLabels = {
      hypertension: '高血压', diabetes: '糖尿病', chd: '冠心病',
      stroke: '脑卒中', copd: '慢阻肺', mental: '精神障碍'
    };
    const reason = `${diseaseLabels[diseaseType] || diseaseType}随访复查`;

    return await reminderModel.create(patient.id, dueDate, reason, followupId);
  },

  async getUpcoming(days = 30) {
    const pending = await reminderModel.getPending();
    const now = Date.now();
    const cutoff = addDays(now, days);
    return pending
      .filter(r => r.dueDate <= cutoff)
      .sort((a, b) => a.dueDate - b.dueDate);
  },

  async getOverdue() {
    const pending = await reminderModel.getPending();
    const now = Date.now();
    return pending.filter(r => r.dueDate < now).sort((a, b) => a.dueDate - b.dueDate);
  },

  async getTodayReminders() {
    const pending = await reminderModel.getPending();
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const todayEnd = todayStart + 86400000;
    return pending.filter(r => r.dueDate >= todayStart && r.dueDate < todayEnd);
  }
};

export { reminderScheduler };
