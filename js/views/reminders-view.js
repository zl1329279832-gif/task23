import { reminderModel } from '../models/reminder.js';
import { reminderScheduler } from '../services/reminder-scheduler.js';
import { db } from '../core/db.js';
import { STORES, DISEASE_TYPES } from '../core/config.js';
import { formatDate, daysFromNow } from '../utils/date.js';
import { router } from '../router.js';
import { toast } from '../components/toast.js';
import { modal } from '../components/modal.js';

const RemindersView = {
  _container: null,

  async render(container) {
    this._container = container;
    container.innerHTML = '<div class="empty-state"><div style="width:36px;height:36px;border:3px solid var(--border);border-top-color:var(--primary);border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 16px;"></div></div>';

    try {
      const [overdue, today, upcoming] = await Promise.all([
        reminderScheduler.getOverdue(),
        reminderScheduler.getTodayReminders(),
        reminderScheduler.getUpcoming(30)
      ]);

      const upcomingFiltered = upcoming.filter(r =>
        !overdue.find(o => o.id === r.id) && !today.find(t => t.id === r.id)
      );

      const patients = {};
      const allReminders = [...overdue, ...today, ...upcomingFiltered];
      for (const r of allReminders) {
        if (!patients[r.patientId]) {
          const p = await db.get(STORES.PATIENTS, r.patientId, ['gender','birthDate','phone','address','idCardNumber','medicalHistory','allergies','emergencyContact']);
          patients[r.patientId] = p;
        }
      }

      this._renderList(overdue, today, upcomingFiltered, patients);
    } catch (e) {
      container.innerHTML = `<div class="empty-state"><div class="empty-state__text">加载失败: ${e.message}</div></div>`;
    }
  },

  _renderList(overdue, today, upcoming, patients) {
    let html = '';

    const totalPending = overdue.length + today.length + upcoming.length;

    html += `
      <div class="patient-stats" style="margin-bottom:16px;">
        <div class="patient-stat-card">
          <div class="patient-stat-card__number" style="color:var(--danger);">${overdue.length}</div>
          <div class="patient-stat-card__label">已逾期</div>
        </div>
        <div class="patient-stat-card">
          <div class="patient-stat-card__number" style="color:var(--warning);">${today.length}</div>
          <div class="patient-stat-card__label">今日</div>
        </div>
        <div class="patient-stat-card">
          <div class="patient-stat-card__number" style="color:var(--success);">${upcoming.length}</div>
          <div class="patient-stat-card__label">即将到期</div>
        </div>
      </div>
    `;

    if (totalPending === 0) {
      html += '<div class="empty-state"><div class="empty-state__icon">&#128203;</div><div class="empty-state__text">暂无待处理的复诊提醒</div></div>';
      this._container.innerHTML = html;
      return;
    }

    if (overdue.length > 0) {
      html += '<div class="section-title">已逾期</div>';
      html += this._renderGroup(overdue, patients, 'overdue');
    }

    if (today.length > 0) {
      html += '<div class="section-title">今日</div>';
      html += this._renderGroup(today, patients, 'today');
    }

    if (upcoming.length > 0) {
      html += '<div class="section-title">即将到期</div>';
      html += this._renderGroup(upcoming, patients, 'upcoming');
    }

    this._container.innerHTML = html;
    this._bindEvents();
  },

  _renderGroup(reminders, patients, type) {
    return reminders.map(r => {
      const patient = patients[r.patientId];
      const name = patient ? patient.name : '未知患者';
      const d = new Date(r.dueDate);
      const dayNum = d.getDate();
      const monthNames = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
      const month = monthNames[d.getMonth()];
      const days = daysFromNow(r.dueDate);
      const daysText = days < 0 ? `逾期${Math.abs(days)}天` : days === 0 ? '今天' : `${days}天后`;

      return `
        <div class="reminder-card ${type}" data-id="${r.id}" data-patient="${r.patientId}">
          <div class="reminder-card__date">
            <div class="reminder-card__date__day">${dayNum}</div>
            <div class="reminder-card__date__month">${month}</div>
          </div>
          <div style="flex:1;min-width:0;">
            <div style="font-weight:500;">${name}</div>
            <div style="font-size:12px;color:var(--text-secondary);">${r.reason}</div>
            <div style="font-size:12px;color:${type === 'overdue' ? 'var(--danger)' : 'var(--text-secondary)'};">${daysText}</div>
          </div>
          <div style="display:flex;gap:8px;">
            <button class="btn btn--sm btn--primary reminder-action" data-action="followup" data-patient="${r.patientId}" data-reminder="${r.id}">随访</button>
            <button class="btn btn--sm btn--outline reminder-action" data-action="dismiss" data-reminder="${r.id}">忽略</button>
          </div>
        </div>
      `;
    }).join('');
  },

  _bindEvents() {
    this._container.addEventListener('click', async (e) => {
      const btn = e.target.closest('.reminder-action');
      if (!btn) return;

      const action = btn.dataset.action;
      const reminderId = btn.dataset.reminder;

      if (action === 'followup') {
        const patientId = btn.dataset.patient;
        await reminderModel.markCompleted(reminderId);
        router.navigate(`/followup/${patientId}`);
      } else if (action === 'dismiss') {
        const confirmed = await modal.confirm('忽略提醒', '确定忽略该复诊提醒吗？');
        if (confirmed) {
          await reminderModel.dismiss(reminderId);
          toast.info('已忽略该提醒');
          this.render(this._container);
        }
      }
    });
  },

  destroy() {
    this._container = null;
  }
};

export default RemindersView;
