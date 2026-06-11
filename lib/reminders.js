// 复诊提醒系统 - 幂等日期计算（防止重复推进）
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

  /**
   * 计算下次复诊日期（基于就诊日期而非当前日期，防止重复推进）
   * @param {Object} patient - 患者对象
   * @param {string} riskLevel - 风险等级
   * @param {string} visitDate - 就诊日期（YYYY-MM-DD），默认为今天
   * @returns {string} 下次复诊日期
   */
  function getNextVisitDate(patient, riskLevel, visitDate) {
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

    // 基于就诊日期计算（而非当前日期），防止每次调用都推进
    const baseDate = visitDate || Utils.today();
    return Utils.addDays(baseDate, interval);
  }

  /**
   * 生成提醒记录（存储固定的下次复诊日期）
   */
  function generateReminder(visit, patient) {
    // 使用就诊日期作为基准（防止重复推进）
    const nextDate = getNextVisitDate(patient, visit.riskLevel, visit.date);

    return {
      patientId: patient.id,
      patientName: patient.name,
      visitId: visit.id,
      visitDate: visit.date,
      nextVisitDate: nextDate, // 固定值，不会随时间变化
      riskLevel: visit.riskLevel || patient.riskLevel,
      diseases: patient.diseases,
      interval: _calculateInterval(patient, visit.riskLevel),
      reason: _generateReason(visit, patient),
      createdAt: Utils.now()
    };
  }

  /** 计算间隔天数（用于显示） */
  function _calculateInterval(patient, riskLevel) {
    const risk = riskLevel || patient.riskLevel || 'none';
    let interval = RISK_INTERVALS[risk] || RISK_INTERVALS.none;

    if (patient.diseases && patient.diseases.length > 0) {
      for (const disease of patient.diseases) {
        const diseaseInterval = DISEASE_DEFAULT_INTERVALS[disease];
        if (diseaseInterval && diseaseInterval < interval) {
          interval = diseaseInterval;
        }
      }
    }

    if (risk === 'high' && interval > 7) interval = 7;
    return interval;
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

      // 使用就诊日期作为基准计算下次复诊日期
      const nextDate = getNextVisitDate(patient, recentVisit.riskLevel, recentVisit.date);
      const diff = Utils.daysBetween(today, nextDate);

      if (diff < 0) {
        overdue.push({
          patient,
          visitDate: recentVisit.date,
          nextDate,
          daysOverdue: Math.abs(diff),
          reason: _generateReason(recentVisit, patient)
        });
      } else if (diff === 0) {
        dueToday.push({
          patient,
          visitDate: recentVisit.date,
          reason: _generateReason(recentVisit, patient)
        });
      } else if (diff <= 3) {
        upcoming.push({
          patient,
          visitDate: recentVisit.date,
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

  /**
   * 同步/冲突合并后重新计算所有提醒
   * 当风险等级或就诊日期因合并而变化时，提醒日期需要重新计算
   * @returns {Promise<Object>} 重新计算结果 { total, changed, changes }
   */
  async function recalculateReminders() {
    const db = await DB.open();
    const patients = await DB.loadAllPatients();
    const today = Utils.today();
    const results = { total: 0, changed: 0, changes: [] };

    for (const patient of patients) {
      const visits = await DB.loadVisitsByPatient(patient.id);
      if (visits.length === 0) continue;

      const recentVisit = visits
        .filter(v => !v.isDraft)
        .sort((a, b) => new Date(b.date) - new Date(a.date))[0];

      if (!recentVisit) continue;

      results.total++;

      // 获取旧提醒（从 settings 中查找）
      const oldReminderKey = `reminder_${patient.id}`;
      const oldReminder = await DB.getSetting(oldReminderKey);

      // 计算新提醒
      const newNextDate = getNextVisitDate(patient, recentVisit.riskLevel, recentVisit.date);
      const newReminder = {
        patientId: patient.id,
        patientName: patient.name,
        visitId: recentVisit.id,
        visitDate: recentVisit.date,
        nextVisitDate: newNextDate,
        riskLevel: recentVisit.riskLevel || patient.riskLevel,
        diseases: patient.diseases,
        interval: _calculateInterval(patient, recentVisit.riskLevel),
        reason: _generateReason(recentVisit, patient),
        recalculatedAt: Utils.now()
      };

      // 检测是否有变化
      const oldNextDate = oldReminder ? (typeof oldReminder === 'string' ? JSON.parse(oldReminder).nextVisitDate : oldReminder.nextVisitDate) : null;

      if (oldNextDate !== newNextDate) {
        results.changed++;
        results.changes.push({
          patientId: patient.id,
          patientName: patient.name,
          oldNextDate: oldNextDate,
          newNextDate: newNextDate,
          riskLevel: recentVisit.riskLevel,
          reason: newReminder.reason
        });
      }

      // 保存新提醒到 settings
      await DB.setSetting(oldReminderKey, JSON.stringify(newReminder));
    }

    // 如果有变化，记录操作日志
    if (results.changed > 0 && typeof DB._logOperation === 'function') {
      await DB._logOperation('reminders', 'all', 'recalculated', {
        total: results.total,
        changed: results.changed,
        changes: results.changes.map(c => ({
          patientId: c.patientId,
          oldDate: c.oldNextDate,
          newDate: c.newNextDate
        }))
      });
    }

    return results;
  }

  function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  return {
    getNextVisitDate, generateReminder, checkTodayReminders,
    showReminderBanner, requestNotificationPermission,
    recalculateReminders,
    RISK_INTERVALS, DISEASE_DEFAULT_INTERVALS
  };
})();
