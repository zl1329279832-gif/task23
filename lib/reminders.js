// 复诊提醒系统
const Reminders = (() => {
  const RISK_INTERVALS = {
    high: 7,
    medium: 14,
    low: 30,
    none: 60
  };

  const DISEASE_DEFAULT_INTERVALS = {
    hypertension: 14,
    diabetes: 14,
    copd: 30,
    heart_disease: 14,
    stroke: 14,
    mental_illness: 30,
    tuberculosis: 7
  };

  function getNextVisitDate(patient, riskLevel) {
    const risk = riskLevel || patient.riskLevel || 'none';
    let interval = RISK_INTERVALS[risk] || RISK_INTERVALS.none;

    // 如果疾病类型有更短的间隔，取较短值
    if (patient.diseases && patient.diseases.length > 0) {
      for (const disease of patient.diseases) {
        const diseaseInterval = DISEASE_DEFAULT_INTERVALS[disease];
        if (diseaseInterval && diseaseInterval < interval) {
          interval = diseaseInterval;
        }
      }
    }

    // 高风险强制最短
    if (risk === 'high' && interval > 7) interval = 7;

    return Utils.addDays(Utils.today(), interval);
  }

  function generateReminder(visit, patient) {
    const nextDate = getNextVisitDate(patient, visit.riskLevel);
    return {
      patientId: patient.id,
      patientName: patient.name,
      nextVisitDate: nextDate,
      riskLevel: visit.riskLevel || patient.riskLevel,
      diseases: patient.diseases,
      reason: _generateReason(visit, patient),
      createdAt: Utils.now()
    };
  }

  function _generateReason(visit, patient) {
    const parts = [];
    if (visit.riskLevel === 'high') parts.push('高风险患者');
    if (visit.bpSystolic >= 180 || visit.bpDiastolic >= 110) parts.push('血压严重偏高');
    if (visit.bloodSugar >= 16.7) parts.push('血糖严重偏高');
    if (visit.riskLevel === 'medium') parts.push('中风险患者');
    const diseases = (patient.diseases || []).map(d => Utils.diseaseLabel(d));
    if (diseases.length > 0) parts.push(`${diseases.join('、')}随访`);
    return parts.length > 0 ? parts.join('，') : '常规随访';
  }

  async function checkTodayReminders() {
    const db = await DB.open();
    const patients = await DB.loadAllPatients();
    const today = Utils.today();
    const overdue = [];
    const dueToday = [];
    const upcoming = [];

    for (const patient of patients) {
      const visits = await DB.loadVisitsByPatient(patient.id);
      if (visits.length === 0) continue;

      // Get the most recent non-draft visit
      const recentVisit = visits
        .filter(v => !v.isDraft)
        .sort((a, b) => new Date(b.date) - new Date(a.date))[0];

      if (!recentVisit) continue;

      const nextDate = getNextVisitDate(patient, recentVisit.riskLevel);
      const diff = Utils.daysBetween(today, nextDate);

      if (diff < 0) {
        overdue.push({
          patient,
          nextDate,
          daysOverdue: Math.abs(diff),
          reason: _generateReason(recentVisit, patient)
        });
      } else if (diff === 0) {
        dueToday.push({
          patient,
          reason: _generateReason(recentVisit, patient)
        });
      } else if (diff <= 3) {
        upcoming.push({
          patient,
          nextDate,
          daysUntil: diff,
          reason: _generateReason(recentVisit, patient)
        });
      }
    }

    return { overdue, dueToday, upcoming };
  }

  async function showReminderBanner() {
    const { overdue, dueToday, upcoming } = await checkTodayReminders();
    const banner = document.getElementById('reminder-banner');
    const text = document.getElementById('reminder-text');

    if (overdue.length === 0 && dueToday.length === 0 && upcoming.length === 0) {
      banner.style.display = 'none';
      return;
    }

    const parts = [];
    if (overdue.length > 0) parts.push(`${overdue.length} 人逾期未访`);
    if (dueToday.length > 0) parts.push(`${dueToday.length} 人今日待访`);
    if (upcoming.length > 0) parts.push(`${upcoming.length} 人即将到期`);

    text.textContent = `随访提醒：${parts.join('，')}`;
    banner.style.display = 'flex';
    banner.dataset.reminders = JSON.stringify({ overdue, dueToday, upcoming });

    // 浏览器通知
    if ('Notification' in window && Notification.permission === 'granted') {
      if (overdue.length > 0) {
        new Notification('随访提醒', {
          body: `有 ${overdue.length} 位患者逾期未访，请及时处理`,
          icon: 'icons/icon-192.png'
        });
      }
    }
  }

  function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  return {
    getNextVisitDate, generateReminder, checkTodayReminders,
    showReminderBanner, requestNotificationPermission
  };
})();
