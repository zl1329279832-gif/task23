// 分层随访计划引擎 - 按风险等级、疾病类型、随访结果、漏访次数自动生成随访计划
const FollowupPlan = (() => {
  // 计划类型
  const PLAN_TYPE = {
    ROUTINE: 'routine',     // 常规随访
    MAKEUP: 'makeup',       // 补访
    REVIEW: 'review',       // 复诊
    URGENT: 'urgent'        // 紧急随访
  };

  // 计划状态
  const PLAN_STATUS = {
    PENDING: 'pending',       // 待执行
    COMPLETED: 'completed',   // 已完成
    OVERDUE: 'overdue',       // 已逾期
    CANCELLED: 'cancelled'    // 已取消
  };

  // 默认分层规则（可通过 risk-config 视图修改）
  let _stratificationRules = {
    high: {
      baseInterval: 7,
      maxMissedBeforeUrgent: 1,
      requireAttachment: true,
      requireQuestionnaire: true,
      abnormalThresholds: {
        bpSystolic: 180, bpDiastolic: 110,
        bloodSugar: 16.7
      },
      makeupDeadlineDays: 3,
      reviewTriggers: ['bpSystolic', 'bpDiastolic', 'bloodSugar']
    },
    medium: {
      baseInterval: 14,
      maxMissedBeforeUrgent: 2,
      requireAttachment: false,
      requireQuestionnaire: true,
      abnormalThresholds: {
        bpSystolic: 160, bpDiastolic: 100,
        bloodSugar: 13.9
      },
      makeupDeadlineDays: 5,
      reviewTriggers: ['bpSystolic', 'bloodSugar']
    },
    low: {
      baseInterval: 30,
      maxMissedBeforeUrgent: 3,
      requireAttachment: false,
      requireQuestionnaire: false,
      abnormalThresholds: {
        bpSystolic: 160, bpDiastolic: 100,
        bloodSugar: 11.1
      },
      makeupDeadlineDays: 7,
      reviewTriggers: []
    },
    none: {
      baseInterval: 60,
      maxMissedBeforeUrgent: 5,
      requireAttachment: false,
      requireQuestionnaire: false,
      abnormalThresholds: {
        bpSystolic: 180, bpDiastolic: 110,
        bloodSugar: 16.7
      },
      makeupDeadlineDays: 14,
      reviewTriggers: []
    }
  };

  // 疾病特定间隔覆盖
  const DISEASE_INTERVALS = {
    hypertension: 14,
    diabetes: 14,
    copd: 30,
    heart_disease: 14,
    stroke: 14,
    mental_illness: 30,
    tuberculosis: 7
  };

  // 疾病特定必填问卷映射
  const DISEASE_QUESTIONNAIRE_MAP = {
    hypertension: 'hypertension',
    diabetes: 'diabetes'
  };

  /** 获取当前分层规则 */
  function getRules() {
    return JSON.parse(JSON.stringify(_stratificationRules));
  }

  /** 更新分层规则 */
  async function updateRules(newRules) {
    _stratificationRules = { ..._stratificationRules, ...newRules };
    await DB.setSetting('stratification_rules', JSON.stringify(_stratificationRules));
  }

  /** 从设置中加载保存的规则 */
  async function loadSavedRules() {
    const saved = await DB.getSetting('stratification_rules');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        _stratificationRules = { ..._stratificationRules, ...parsed };
      } catch { /* use defaults */ }
    }
  }

  /** 获取患者的风险分层规则 */
  function getPatientRules(patient) {
    const level = patient.riskLevel || 'none';
    return _stratificationRules[level] || _stratificationRules.none;
  }

  /**
   * 计算有效随访间隔（考虑风险等级和疾病类型）
   */
  function computeInterval(patient, riskLevel) {
    const risk = riskLevel || patient.riskLevel || 'none';
    const rules = _stratificationRules[risk] || _stratificationRules.none;
    let interval = rules.baseInterval;

    if (patient.diseases && patient.diseases.length > 0) {
      for (const disease of patient.diseases) {
        const di = DISEASE_INTERVALS[disease];
        if (di && di < interval) interval = di;
      }
    }
    if (risk === 'high' && interval > 7) interval = 7;
    return interval;
  }

  /**
   * 统计患者漏访次数
   */
  async function countMissedVisits(patientId) {
    const plans = await DB.loadPlansByPatient(patientId);
    return plans.filter(p => p.status === PLAN_STATUS.OVERDUE).length;
  }

  /**
   * 为单个患者生成随访计划
   * @param {Object} patient - 患者对象
   * @param {Object} lastVisit - 最近一次随访记录（可为null）
   * @param {Object} options - { force: boolean }
   * @returns {Object|null} 新计划或null
   */
  async function generatePlanForPatient(patient, lastVisit, options = {}) {
    const existingPlans = await DB.loadPlansByPatient(patient.id);
    const activePlans = existingPlans.filter(
      p => p.status === PLAN_STATUS.PENDING
    );

    // 如果已有待执行计划且非强制，跳过
    if (activePlans.length > 0 && !options.force) return null;

    const riskLevel = patient.riskLevel || 'none';
    const rules = getPatientRules(patient);
    const missedCount = existingPlans.filter(p => p.status === PLAN_STATUS.OVERDUE).length;
    const interval = computeInterval(patient, riskLevel);

    // 确定计划类型
    let planType = PLAN_TYPE.ROUTINE;
    if (missedCount > 0) {
      planType = missedCount >= rules.maxMissedBeforeUrgent ? PLAN_TYPE.URGENT : PLAN_TYPE.MAKEUP;
    }

    // 确定基准日期
    const baseDate = lastVisit ? lastVisit.date : Utils.today();
    let plannedDate;

    if (planType === PLAN_TYPE.MAKEUP) {
      // 补访：在 makeupDeadlineDays 内安排
      plannedDate = Utils.addDays(Utils.today(), Math.min(rules.makeupDeadlineDays, interval));
    } else if (planType === PLAN_TYPE.URGENT) {
      // 紧急：尽快安排（1-2天内）
      plannedDate = Utils.addDays(Utils.today(), Math.min(2, interval));
    } else {
      // 常规：按间隔从上次就诊日计算
      plannedDate = Utils.addDays(baseDate, interval);
    }

    // 确定需要的问卷
    const requiredQuestionnaires = [];
    if (rules.requireQuestionnaire && patient.diseases) {
      for (const disease of patient.diseases) {
        const qType = DISEASE_QUESTIONNAIRE_MAP[disease];
        if (qType) requiredQuestionnaires.push(qType);
      }
    }

    // 判断是否需要附件
    const requireAttachment = rules.requireAttachment ||
      (planType === PLAN_TYPE.URGENT) ||
      (missedCount >= 2);

    // 根据上次随访结果调整
    let adjustmentReason = '';
    if (lastVisit) {
      const abnormals = detectAbnormalIndicators(lastVisit, rules);
      if (abnormals.length > 0) {
        // 异常指标缩短间隔
        const urgentDate = Utils.addDays(baseDate, Math.ceil(interval / 2));
        if (urgentDate < plannedDate) {
          plannedDate = urgentDate;
          adjustmentReason = `异常指标: ${abnormals.map(a => a.label).join('、')}`;
          if (planType === PLAN_TYPE.ROUTINE) planType = PLAN_TYPE.REVIEW;
        }
      }
    }

    const plan = {
      id: Utils.uuid(),
      patientId: patient.id,
      patientName: patient.name,
      planType,
      status: PLAN_STATUS.PENDING,
      riskLevel,
      diseases: patient.diseases || [],
      plannedDate,
      deadlineDate: Utils.addDays(plannedDate, rules.makeupDeadlineDays),
      interval,
      missedCount,
      lastVisitId: lastVisit ? lastVisit.id : null,
      lastVisitDate: lastVisit ? lastVisit.date : null,
      requiredQuestionnaires,
      requireAttachment,
      adjustmentReason,
      completedVisitId: null,
      createdAt: Utils.now(),
      updatedAt: Utils.now()
    };

    await DB.savePlan(plan);
    return plan;
  }

  /**
   * 检测异常指标
   */
  function detectAbnormalIndicators(visit, rules) {
    const abnormals = [];
    const thresholds = rules ? rules.abnormalThresholds : _stratificationRules.none.abnormalThresholds;

    if (visit.bpSystolic && thresholds.bpSystolic && visit.bpSystolic >= thresholds.bpSystolic) {
      abnormals.push({ field: 'bpSystolic', value: visit.bpSystolic, threshold: thresholds.bpSystolic, label: '收缩压偏高' });
    }
    if (visit.bpDiastolic && thresholds.bpDiastolic && visit.bpDiastolic >= thresholds.bpDiastolic) {
      abnormals.push({ field: 'bpDiastolic', value: visit.bpDiastolic, threshold: thresholds.bpDiastolic, label: '舒张压偏高' });
    }
    if (visit.bloodSugar && thresholds.bloodSugar && visit.bloodSugar >= thresholds.bloodSugar) {
      abnormals.push({ field: 'bloodSugar', value: visit.bloodSugar, threshold: thresholds.bloodSugar, label: '血糖偏高' });
    }
    return abnormals;
  }

  /**
   * 为所有患者批量生成随访计划
   */
  async function generateAllPlans() {
    const patients = await DB.loadAllPatients();
    const results = { generated: 0, skipped: 0, errors: 0 };

    for (const patient of patients) {
      try {
        const visits = await DB.loadVisitsByPatient(patient.id);
        const recentVisit = visits
          .filter(v => !v.isDraft)
          .sort((a, b) => new Date(b.date) - new Date(a.date))[0] || null;

        // 先更新逾期状态
        await updateOverdueStatus(patient.id);

        const plan = await generatePlanForPatient(patient, recentVisit);
        if (plan) {
          results.generated++;
        } else {
          results.skipped++;
        }
      } catch (err) {
        console.error(`生成计划失败 (${patient.name}):`, err);
        results.errors++;
      }
    }
    return results;
  }

  /**
   * 更新患者的逾期状态
   */
  async function updateOverdueStatus(patientId) {
    const plans = await DB.loadPlansByPatient(patientId);
    const today = Utils.today();

    for (const plan of plans) {
      if (plan.status === PLAN_STATUS.PENDING) {
        const deadlinePassed = Utils.daysBetween(today, plan.deadlineDate) < 0;
        if (deadlinePassed) {
          plan.status = PLAN_STATUS.OVERDUE;
          plan.updatedAt = Utils.now();
          await DB.savePlan(plan);
        }
      }
    }
  }

  /**
   * 完成计划（随访完成时调用）
   */
  async function completePlan(planId, visitId) {
    const plan = await DB.loadPlan(planId);
    if (!plan) return null;

    plan.status = PLAN_STATUS.COMPLETED;
    plan.completedVisitId = visitId;
    plan.completedAt = Utils.now();
    plan.updatedAt = Utils.now();
    await DB.savePlan(plan);
    return plan;
  }

  /**
   * 取消计划
   */
  async function cancelPlan(planId, reason) {
    const plan = await DB.loadPlan(planId);
    if (!plan) return null;

    plan.status = PLAN_STATUS.CANCELLED;
    plan.cancelReason = reason;
    plan.updatedAt = Utils.now();
    await DB.savePlan(plan);
    return plan;
  }

  /**
   * 获取患者的随访计划摘要
   */
  async function getPatientPlanSummary(patientId) {
    const plans = await DB.loadPlansByPatient(patientId);
    const missedCount = plans.filter(p => p.status === PLAN_STATUS.OVERDUE).length;
    const pendingPlans = plans.filter(p => p.status === PLAN_STATUS.PENDING)
      .sort((a, b) => new Date(a.plannedDate) - new Date(b.plannedDate));
    const completedPlans = plans.filter(p => p.status === PLAN_STATUS.COMPLETED);
    const nextPlan = pendingPlans[0] || null;

    return {
      total: plans.length,
      pending: pendingPlans.length,
      completed: completedPlans.length,
      missed: missedCount,
      nextPlan,
      plans
    };
  }

  /**
   * 获取今日待执行计划
   */
  async function getTodayPlans() {
    const allPlans = await DB.loadAllPlans();
    const today = Utils.today();
    return allPlans.filter(p =>
      p.status === PLAN_STATUS.PENDING && p.plannedDate <= today
    ).sort((a, b) => {
      const riskOrder = { high: 0, medium: 1, low: 2, none: 3 };
      return (riskOrder[a.riskLevel] || 3) - (riskOrder[b.riskLevel] || 3);
    });
  }

  /**
   * 获取全局计划统计
   */
  async function getPlanStats() {
    const allPlans = await DB.loadAllPlans();
    const today = Utils.today();

    return {
      total: allPlans.length,
      pending: allPlans.filter(p => p.status === PLAN_STATUS.PENDING).length,
      overdue: allPlans.filter(p => p.status === PLAN_STATUS.OVERDUE).length,
      completed: allPlans.filter(p => p.status === PLAN_STATUS.COMPLETED).length,
      todayDue: allPlans.filter(p => p.status === PLAN_STATUS.PENDING && p.plannedDate === today).length,
      byRisk: {
        high: allPlans.filter(p => p.riskLevel === 'high' && p.status === PLAN_STATUS.PENDING).length,
        medium: allPlans.filter(p => p.riskLevel === 'medium' && p.status === PLAN_STATUS.PENDING).length,
        low: allPlans.filter(p => p.riskLevel === 'low' && p.status === PLAN_STATUS.PENDING).length,
        none: allPlans.filter(p => p.riskLevel === 'none' && p.status === PLAN_STATUS.PENDING).length
      },
      byType: {
        routine: allPlans.filter(p => p.planType === PLAN_TYPE.ROUTINE && p.status === PLAN_STATUS.PENDING).length,
        makeup: allPlans.filter(p => p.planType === PLAN_TYPE.MAKEUP && p.status === PLAN_STATUS.PENDING).length,
        review: allPlans.filter(p => p.planType === PLAN_TYPE.REVIEW && p.status === PLAN_STATUS.PENDING).length,
        urgent: allPlans.filter(p => p.planType === PLAN_TYPE.URGENT && p.status === PLAN_STATUS.PENDING).length
      }
    };
  }

  /**
   * 同步冲突时保留本地补访链路
   * 合并远程最新计划和本地补访记录
   */
  function mergePlanData(localPlans, remotePlans) {
    const merged = [];
    const remoteMap = new Map(remotePlans.map(p => [p.id, p]));
    const localMap = new Map(localPlans.map(p => [p.id, p]));

    // 保留所有远程计划
    for (const rp of remotePlans) {
      const lp = localMap.get(rp.id);
      if (lp) {
        // 两端都有：保留远程计划但保留本地完成状态
        if (lp.status === PLAN_STATUS.COMPLETED && rp.status === PLAN_STATUS.PENDING) {
          merged.push({ ...rp, ...lp }); // 本地完成优先
        } else {
          merged.push(rp); // 远程最新计划优先
        }
      } else {
        merged.push(rp);
      }
    }

    // 保留本地独有的补访计划（本地补访链路）
    for (const lp of localPlans) {
      if (!remoteMap.has(lp.id)) {
        if (lp.planType === PLAN_TYPE.MAKEUP || lp.planType === PLAN_TYPE.URGENT) {
          merged.push(lp); // 保留本地补访链路
        }
      }
    }

    return merged;
  }

  return {
    PLAN_TYPE, PLAN_STATUS,
    DISEASE_INTERVALS, DISEASE_QUESTIONNAIRE_MAP,
    getRules, updateRules, loadSavedRules, getPatientRules,
    computeInterval, countMissedVisits,
    generatePlanForPatient, generateAllPlans,
    detectAbnormalIndicators,
    updateOverdueStatus, completePlan, cancelPlan,
    getPatientPlanSummary, getTodayPlans, getPlanStats,
    mergePlanData
  };
})();
