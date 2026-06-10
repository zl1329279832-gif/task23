// 复诊提醒系统 - 基于实际末次随访日期、幂等计算
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

  // 计算随访间隔天数（纯函数，不依赖日期）
  function getVisitInterval(patient, riskLevel) {
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

  // 基于末次随访日期计算下次随访日期（幂等）
  function getNextVisitDate(patient, riskLevel, lastVisitDate) {
    const interval = getVisitInterval(patient, riskLevel);
    const baseDate = lastVisitDate || Utils.today();
    return Utils.addDays(baseDate, interval);
  }

  // 从具体 visit 记录生成提醒（带来源追踪，幂等）
  function generateReminder(visit, patient) {
    const lastVisitDate = visit.date || Utils.today();
    const nextDate = getNextVisitDate(patient, visit.riskLevel, lastVisitDate);
    return {
      patientId: patient.id,
      patientName: patient.name,
      sourceVisitId: visit.id,        // 追踪产生此提醒的 visit
      sourceVisitDate: lastVisitDate,  // 追踪计算基准日期
      nextVisitDate: nextDate,
      interval: getVisitInterval(patient, visit.riskLevel),
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

  // 去重提醒：同一 sourceVisitId 只产生一个提醒
  function deduplicateReminders(reminders) {
    const seen = new Map();
    for (const r of reminders) {
      const key = r.sourceVisitId || r.patientId;
      const existing = seen.get(key);
      if (!existing || new Date(r.sourceVisitDate) > new Date(existing.sourceVisitDate)) {
        seen.set(key, r);
      }
    }
    return Array.from(seen.values());
  }

  // 在合并时安全计算提醒（防止重复推进）
  // 给定本地和远程 visit 列表，找出真正最新的 visit 来计算提醒
  function computeMergedReminder(patient, localVisits, remoteVisits) {
    const allVisits = [];
    const seenIds = new Set();

    // 合并两端 visit，同 ID 取更新的
    for (const v of [...(localVisits || []), ...(remoteVisits || [])]) {
      if (seenIds.has(v.id)) {
        const idx = allVisits.findIndex(e => e.id === v.id);
        if (idx >= 0 && new Date(v.updatedAt || 0) > new Date(allVisits[idx].updatedAt || 0)) {
          allVisits[idx] = v;
        }
        continue;
      }
      seenIds.add(v.id);
      allVisits.push(v);
    }

    // 找到真正最新的非草稿 visit
    const latest = allVisits
      .filter(v => !v.isDraft)
      .sort((a, b) => new Date(b.date) - new Date(a.date))[0];

    if (!latest) return null;
    return generateReminder(latest, patient);
  }

  async function checkTodayReminders() {
    const patients = await DB.loadAllPatients();
    const today = Utils.today();
    const overdue = [];
    const dueToday = [];
    const upcoming = [];

    for (const patient of patients) {
      const visits = await DB.loadVisitsByPatient(patient.id);
      if (visits.length === 0) continue;

      const recentVisit = visits
        .filter(v => !v.isDraft)
        .sort((a, b) => new Date(b.date) - new Date(a.date))[0];

      if (!recentVisit) continue;

      // 基于实际末次随访日期计算
      const lastVisitDate = recentVisit.date || today;
      const nextDate = getNextVisitDate(patient, recentVisit.riskLevel, lastVisitDate);
      const diff = Utils.daysBetween(today, nextDate);

      const entry = {
        patient,
        nextDate,
        sourceVisitId: recentVisit.id,
        sourceVisitDate: lastVisitDate,
        reason: _generateReason(recentVisit, patient)
      };

      if (diff < 0) {
        overdue.push({ ...entry, daysOverdue: Math.abs(diff) });
      } else if (diff === 0) {
        dueToday.push(entry);
      } else if (diff <= 3) {
        upcoming.push({ ...entry, daysUntil: diff });
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
    getNextVisitDate, getVisitInterval, generateReminder, checkTodayReminders,
    showReminderBanner, requestNotificationPermission,
    deduplicateReminders, computeMergedReminder
  };
})();
