// 分层随访计划引擎 - 风险分层规则 + 计划生成 + 补访触发 + 异常上报 + 附件必传
const FollowupPlan = (() => {
  // ==================== 默认风险分层规则 ====================
  const DEFAULT_RISK_RULES = [
    {
      id: 'rule_high_risk',
      name: '高风险患者',
      priority: 1,
      conditions: [
        { field: 'riskLevel', operator: 'eq', value: 'high' }
      ],
      intervalDays: 7,
      visitType: 'routine',
      requireAttachments: false,
      requireQuestionnaire: true,
      questionnaireTypes: ['disease-specific'],
      description: '高风险患者每 7 天随访一次，必填问卷'
    },
    {
      id: 'rule_medium_risk',
      name: '中风险患者',
      priority: 2,
      conditions: [
        { field: 'riskLevel', operator: 'eq', value: 'medium' }
      ],
      intervalDays: 14,
      visitType: 'routine',
      requireAttachments: false,
      requireQuestionnaire: true,
      questionnaireTypes: ['disease-specific'],
      description: '中风险患者每 14 天随访一次，必填问卷'
    },
    {
      id: 'rule_low_risk',
      name: '低风险患者',
      priority: 3,
      conditions: [
        { field: 'riskLevel', operator: 'eq', value: 'low' }
      ],
      intervalDays: 30,
      visitType: 'routine',
      requireAttachments: false,
      requireQuestionnaire: false,
      questionnaireTypes: [],
      description: '低风险患者每 30 天随访一次'
    },
    {
      id: 'rule_tuberculosis',
      name: '肺结核患者',
      priority: 0,
      conditions: [
        { field: 'diseases', operator: 'includes', value: 'tuberculosis' }
      ],
      intervalDays: 7,
      visitType: 'routine',
      requireAttachments: true,
      requireAttachmentTypes: ['sputum_report'],
      requireQuestionnaire: true,
      questionnaireTypes: ['disease-specific'],
      description: '肺结核患者每 7 天随访，必传痰检报告'
    },
    {
      id: 'rule_abnormal_bp',
      name: '血压异常',
      priority: 0,
      conditions: [
        { field: 'lastVisit.bpSystolic', operator: 'gte', value: 180 }
      ],
      intervalDays: 3,
      visitType: 'abnormal',
      requireAttachments: false,
      requireQuestionnaire: true,
      questionnaireTypes: ['hypertension'],
      triggerReport: true,
      reportReason: '血压严重偏高（≥180mmHg），需紧急关注',
      description: '血压严重偏高，3 天内复查'
    },
    {
      id: 'rule_abnormal_bs',
      name: '血糖异常',
      priority: 0,
      conditions: [
        { field: 'lastVisit.bloodSugar', operator: 'gte', value: 16.7 }
      ],
      intervalDays: 3,
      visitType: 'abnormal',
      requireAttachments: false,
      requireQuestionnaire: true,
      questionnaireTypes: ['diabetes'],
      triggerReport: true,
      reportReason: '血糖严重偏高（≥16.7mmol/L），需紧急关注',
      description: '血糖严重偏高，3 天内复查'
    }
  ];

  // ==================== 补访触发规则 ====================
  const REVISIT_TRIGGER_RULES = {
    // 逾期未访自动触发补访问卷
    missedVisit: {
      threshold: 1,        // 逾期次数达到此值触发补访
      maxAutoTrigger: 3,   // 最多自动触发补访次数
      escalationLevels: [
        { missedCount: 1, action: 'questionnaire', label: '补访问卷' },
        { missedCount: 2, action: 'reminder', label: '复诊提醒+补访问卷' },
        { missedCount: 3, action: 'report', label: '异常上报+补访问卷' }
      ]
    },
    // 异常指标上报规则
    abnormalIndicator: {
      bpSystolicHigh: { threshold: 180, unit: 'mmHg', label: '收缩压严重偏高' },
      bpDiastolicHigh: { threshold: 110, unit: 'mmHg', label: '舒张压严重偏高' },
      bloodSugarHigh: { threshold: 16.7, unit: 'mmol/L', label: '血糖严重偏高' },
      bloodSugarLow: { threshold: 3.9, unit: 'mmol/L', label: '血糖偏低' }
    },
    // 附件必传规则
    attachmentRequired: {
      tuberculosis: {
        types: ['sputum_report'],
        labels: ['痰检报告'],
        description: '肺结核患者每次随访必须上传痰检报告'
      },
      highRiskAbnormal: {
        types: ['exam_report'],
        labels: ['检查报告'],
        description: '高风险异常患者需上传检查报告'
      }
    }
  };

  // ==================== 计划生成 ====================

  /**
   * 为患者生成随访计划
   * @param {Object} patient - 患者对象
   * @param {Array} visits - 该患者的随访记录
   * @param {Array} customRules - 自定义规则（可选）
   * @returns {Object} 随访计划
   */
  async function generatePlan(patient, visits, customRules) {
    const rules = customRules || await _loadRules();
    const sortedVisits = (visits || []).filter(v => !v.isDraft)
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    const lastVisit = sortedVisits[0] || null;

    // 计算漏访次数
    const missedCount = await _calculateMissedCount(patient, sortedVisits);

    // 匹配最佳规则（优先级最高的匹配规则）
    const matchedRule = _matchRule(patient, lastVisit, rules);

    // 计算计划日期
    const baseDate = lastVisit ? lastVisit.date : Utils.today();
    const intervalDays = matchedRule ? matchedRule.intervalDays : 30;
    const planDate = Utils.addDays(baseDate, intervalDays);
    const dueDate = Utils.addDays(planDate, 3); // 3 天宽限期

    // 判断是否触发补访
    const revisitTrigger = _evaluateRevisitTrigger(missedCount, patient, lastVisit);

    // 判断异常指标
    const abnormalIndicators = _detectAbnormalIndicators(lastVisit);

    // 判断附件必传
    const requiredAttachments = _getRequiredAttachments(patient, lastVisit, revisitTrigger);

    // 确定优先级
    const priority = _calculatePriority(patient, missedCount, abnormalIndicators, matchedRule);

    // 确定访问类型
    let visitType = matchedRule ? matchedRule.visitType : 'routine';
    if (missedCount >= REVISIT_TRIGGER_RULES.missedVisit.threshold) {
      visitType = 'missed_revisit';
    }
    if (abnormalIndicators.length > 0) {
      visitType = 'abnormal_revisit';
    }

    const plan = {
      id: Utils.uuid(),
      patientId: patient.id,
      patientName: patient.name,
      planDate: planDate,
      dueDate: dueDate,
      priority: priority,
      visitType: visitType,
      status: 'pending',
      matchedRuleId: matchedRule ? matchedRule.id : null,
      intervalDays: intervalDays,
      riskLevel: patient.riskLevel,
      diseases: patient.diseases || [],
      missedCount: missedCount,
      lastVisitDate: lastVisit ? lastVisit.date : null,
      lastVisitResult: lastVisit ? _summarizeVisitResult(lastVisit) : null,
      revisitTrigger: revisitTrigger,
      abnormalIndicators: abnormalIndicators,
      requiredAttachments: requiredAttachments,
      requireQuestionnaire: matchedRule ? matchedRule.requireQuestionnaire : false,
      questionnaireTypes: matchedRule ? matchedRule.questionnaireTypes : [],
      triggerReport: revisitTrigger.action === 'report' ||
        (matchedRule && matchedRule.triggerReport) || false,
      reportReason: revisitTrigger.reportReason ||
        (matchedRule ? matchedRule.reportReason : null) || null,
      createdAt: Utils.now(),
      updatedAt: Utils.now(),
      _generatedBy: 'FollowupPlan'
    };

    return plan;
  }

  /**
   * 为所有患者批量生成/更新随访计划
   */
  async function generateAllPlans() {
    const patients = await DB.loadAllPatients();
    const rules = await _loadRules();
    const plans = [];

    for (const patient of patients) {
      const visits = await DB.loadVisitsByPatient(patient.id);

      // 检查是否已有未完成的计划
      const existingPlans = await DB.getPlansByPatient(patient.id);
      const pendingPlan = existingPlans.find(p => p.status === 'pending' || p.status === 'overdue');

      if (pendingPlan) {
        // 更新现有计划
        const updated = await generatePlan(patient, visits, rules);
        updated.id = pendingPlan.id;
        updated.createdAt = pendingPlan.createdAt;
        updated.status = _checkOverdue(updated);
        const saved = await DB.savePlan(updated);
        plans.push(saved);
      } else {
        // 创建新计划
        const newPlan = await generatePlan(patient, visits, rules);
        newPlan.status = _checkOverdue(newPlan);
        const saved = await DB.savePlan(newPlan);
        plans.push(saved);
      }
    }

    return plans;
  }

  /**
   * 完成随访后处理：判断是否触发补访、复诊提醒、异常上报、附件必传
   * @param {Object} visit - 刚完成的随访记录
   * @param {Object} patient - 患者对象
   * @returns {Object} 后续动作列表
   */
  async function processPostVisit(visit, patient) {
    const actions = [];

    // 1. 检测异常指标
    const abnormalIndicators = _detectAbnormalIndicators(visit);
    if (abnormalIndicators.length > 0) {
      actions.push({
        type: 'abnormal_report',
        indicators: abnormalIndicators,
        message: `发现 ${abnormalIndicators.length} 项异常指标，需上报`
      });
    }

    // 2. 检查附件必传规则
    const requiredAttachments = _getRequiredAttachments(patient, visit, { action: 'none' });
    const uploadedTypes = (visit.attachments || []).map(a => a.type || 'photo');
    const missingAttachments = requiredAttachments.filter(
      req => !uploadedTypes.some(t => req.types.includes(t))
    );
    if (missingAttachments.length > 0) {
      actions.push({
        type: 'attachment_required',
        missing: missingAttachments,
        message: `缺少必传附件：${missingAttachments.map(m => m.labels.join('/')).join('、')}`
      });
    }

    // 3. 判断是否需要补访问卷
    const visits = await DB.loadVisitsByPatient(patient.id);
    const sortedVisits = visits.filter(v => !v.isDraft)
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    const missedCount = await _calculateMissedCount(patient, sortedVisits);

    if (missedCount >= REVISIT_TRIGGER_RULES.missedVisit.threshold) {
      const revisitAction = _evaluateRevisitTrigger(missedCount, patient, visit);
      actions.push({
        type: 'revisit_questionnaire',
        trigger: revisitAction,
        message: `患者有 ${missedCount} 次漏访记录，需进行补访问卷`
      });
    }

    // 4. 生成下次随访计划
    const rules = await _loadRules();
    const nextPlan = await generatePlan(patient, sortedVisits, rules);
    nextPlan.status = 'pending';
    await DB.savePlan(nextPlan);

    actions.push({
      type: 'next_plan',
      plan: nextPlan,
      message: `下次随访计划：${Utils.formatDate(nextPlan.planDate)}`
    });

    // 5. 复诊提醒
    const nextDate = Reminders.getNextVisitDate(patient, visit.riskLevel, visit.date);
    actions.push({
      type: 'revisit_reminder',
      nextDate: nextDate,
      message: `复诊提醒已设置：${Utils.formatDate(nextDate)}`
    });

    // 6. 标记当前计划为已完成
    const existingPlans = await DB.getPlansByPatient(patient.id);
    for (const plan of existingPlans) {
      if ((plan.status === 'pending' || plan.status === 'overdue') && plan.id !== nextPlan.id) {
        plan.status = 'completed';
        plan.completedAt = Utils.now();
        plan.completedVisitId = visit.id;
        await DB.savePlan(plan);
      }
    }

    return actions;
  }

  // ==================== 规则匹配 ====================

  function _matchRule(patient, lastVisit, rules) {
    const sortedRules = [...rules].sort((a, b) => a.priority - b.priority);

    for (const rule of sortedRules) {
      if (_evaluateConditions(rule.conditions, patient, lastVisit)) {
        return rule;
      }
    }
    return null;
  }

  function _evaluateConditions(conditions, patient, lastVisit) {
    if (!conditions || conditions.length === 0) return false;

    return conditions.every(cond => {
      let fieldValue;
      const fieldParts = cond.field.split('.');

      if (fieldParts[0] === 'lastVisit' && lastVisit) {
        fieldValue = lastVisit[fieldParts[1]];
      } else {
        fieldValue = patient[fieldParts[0]];
      }

      switch (cond.operator) {
        case 'eq': return fieldValue === cond.value;
        case 'ne': return fieldValue !== cond.value;
        case 'gt': return Number(fieldValue) > Number(cond.value);
        case 'gte': return Number(fieldValue) >= Number(cond.value);
        case 'lt': return Number(fieldValue) < Number(cond.value);
        case 'lte': return Number(fieldValue) <= Number(cond.value);
        case 'includes':
          return Array.isArray(fieldValue) && fieldValue.includes(cond.value);
        case 'not_empty':
          return fieldValue !== null && fieldValue !== undefined && fieldValue !== '';
        default: return true;
      }
    });
  }

  // ==================== 漏访计算 ====================

  async function _calculateMissedCount(patient, sortedVisits) {
    if (!sortedVisits || sortedVisits.length === 0) return 0;

    const today = Utils.today();
    let missedCount = 0;
    const rules = await _loadRules();

    // 从第一次随访开始，检查每次随访间隔是否超出预期
    for (let i = 0; i < sortedVisits.length - 1; i++) {
      const current = sortedVisits[i];
      const previous = sortedVisits[i + 1];
      const gap = Utils.daysBetween(previous.date, current.date);

      // 根据当时的风险等级计算预期间隔
      const matchedRule = _matchRule(patient, previous, rules);
      const expectedInterval = matchedRule ? matchedRule.intervalDays : 30;

      // 如果间隔超过预期的 1.5 倍，算一次漏访
      if (gap > expectedInterval * 1.5) {
        missedCount += Math.floor(gap / expectedInterval) - 1;
      }
    }

    // 检查最后一次随访到今天是否已逾期
    const lastVisit = sortedVisits[0];
    const matchedRule = _matchRule(patient, lastVisit, rules);
    const expectedInterval = matchedRule ? matchedRule.intervalDays : 30;
    const daysSinceLastVisit = Utils.daysBetween(lastVisit.date, today);

    if (daysSinceLastVisit > expectedInterval * 1.5) {
      missedCount += Math.floor(daysSinceLastVisit / expectedInterval) - 1;
    }

    return Math.max(0, missedCount);
  }

  // ==================== 补访触发评估 ====================

  function _evaluateRevisitTrigger(missedCount, patient, lastVisit) {
    const rules = REVISIT_TRIGGER_RULES.missedVisit;

    if (missedCount < rules.threshold) {
      return { action: 'none', missedCount, label: '无需补访' };
    }

    if (missedCount > rules.maxAutoTrigger) {
      return {
        action: 'report',
        missedCount,
        label: '漏访超限，需人工上报',
        reportReason: `患者 ${patient.name} 累计漏访 ${missedCount} 次，已超过自动补访上限`
      };
    }

    // 按升级级别匹配
    const escalation = [...rules.escalationLevels]
      .sort((a, b) => b.missedCount - a.missedCount)
      .find(e => missedCount >= e.missedCount);

    if (escalation) {
      return {
        action: escalation.action,
        missedCount,
        label: escalation.label,
        reportReason: escalation.action === 'report'
          ? `患者 ${patient.name} 漏访 ${missedCount} 次，触发异常上报`
          : null
      };
    }

    return { action: 'questionnaire', missedCount, label: '补访问卷' };
  }

  // ==================== 异常指标检测 ====================

  function _detectAbnormalIndicators(visit) {
    if (!visit) return [];
    const indicators = [];
    const thresholds = REVISIT_TRIGGER_RULES.abnormalIndicator;

    if (visit.bpSystolic && visit.bpSystolic >= thresholds.bpSystolicHigh.threshold) {
      indicators.push({
        field: 'bpSystolic',
        value: visit.bpSystolic,
        threshold: thresholds.bpSystolicHigh.threshold,
        unit: thresholds.bpSystolicHigh.unit,
        label: thresholds.bpSystolicHigh.label,
        severity: 'high'
      });
    }

    if (visit.bpDiastolic && visit.bpDiastolic >= thresholds.bpDiastolicHigh.threshold) {
      indicators.push({
        field: 'bpDiastolic',
        value: visit.bpDiastolic,
        threshold: thresholds.bpDiastolicHigh.threshold,
        unit: thresholds.bpDiastolicHigh.unit,
        label: thresholds.bpDiastolicHigh.label,
        severity: 'high'
      });
    }

    if (visit.bloodSugar) {
      if (visit.bloodSugar >= thresholds.bloodSugarHigh.threshold) {
        indicators.push({
          field: 'bloodSugar',
          value: visit.bloodSugar,
          threshold: thresholds.bloodSugarHigh.threshold,
          unit: thresholds.bloodSugarHigh.unit,
          label: thresholds.bloodSugarHigh.label,
          severity: 'high'
        });
      }
      if (visit.bloodSugar <= thresholds.bloodSugarLow.threshold) {
        indicators.push({
          field: 'bloodSugar',
          value: visit.bloodSugar,
          threshold: thresholds.bloodSugarLow.threshold,
          unit: thresholds.bloodSugarLow.unit,
          label: thresholds.bloodSugarLow.label,
          severity: 'warning'
        });
      }
    }

    return indicators;
  }

  // ==================== 附件必传规则 ====================

  function _getRequiredAttachments(patient, lastVisit, revisitTrigger) {
    const required = [];
    const diseases = patient.diseases || [];

    // 肺结核必传痰检报告
    if (diseases.includes('tuberculosis')) {
      const rule = REVISIT_TRIGGER_RULES.attachmentRequired.tuberculosis;
      required.push({
        types: rule.types,
        labels: rule.labels,
        reason: rule.description
      });
    }

    // 高风险异常患者必传检查报告
    if (patient.riskLevel === 'high' && revisitTrigger &&
        (revisitTrigger.action === 'report' || revisitTrigger.action === 'reminder')) {
      const rule = REVISIT_TRIGGER_RULES.attachmentRequired.highRiskAbnormal;
      required.push({
        types: rule.types,
        labels: rule.labels,
        reason: rule.description
      });
    }

    return required;
  }

  // ==================== 辅助函数 ====================

  function _calculatePriority(patient, missedCount, abnormalIndicators, matchedRule) {
    let priority = 3; // 默认普通

    if (patient.riskLevel === 'high') priority = 2;
    if (matchedRule && matchedRule.priority === 0) priority = 1; // 特殊规则最高
    if (abnormalIndicators.length > 0) priority = 1;
    if (missedCount >= 3) priority = 1;
    else if (missedCount >= 2) priority = Math.min(priority, 2);

    return priority;
  }

  function _summarizeVisitResult(visit) {
    const parts = [];
    if (visit.bpSystolic) parts.push(`血压 ${visit.bpSystolic}/${visit.bpDiastolic}`);
    if (visit.bloodSugar) parts.push(`血糖 ${visit.bloodSugar}`);
    if (visit.riskLevel && visit.riskLevel !== 'none') parts.push(Utils.riskLabel(visit.riskLevel));
    return parts.join('，') || '无异常';
  }

  function _checkOverdue(plan) {
    const today = Utils.today();
    if (Utils.daysBetween(plan.dueDate, today) > 0) {
      return 'overdue';
    }
    return plan.status || 'pending';
  }

  async function _loadRules() {
    try {
      const customRules = await DB.getRiskConfig();
      if (customRules && customRules.length > 0) return customRules;
    } catch { /* DB not ready */ }
    return DEFAULT_RISK_RULES;
  }

  // ==================== 计划状态汇总 ====================

  /**
   * 冲突合并后重新计算指定患者的随访计划
   * 当 visit 数据因合并而变化时，需要重新生成计划以反映最新的 visit 日期和风险等级
   * @param {Object} patient - 患者对象
   * @param {Array} visits - 该患者的随访记录（合并后的最新数据）
   * @returns {Object|null} 更新后的计划
   */
  async function recalculatePlansForPatient(patient, visits) {
    if (!patient || !patient.id) return null;

    const rules = await _loadRules();
    const sortedVisits = (visits || []).filter(v => !v.isDraft)
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    // 获取现有计划
    const existingPlans = await DB.getPlansByPatient(patient.id);
    const pendingPlans = existingPlans.filter(p => p.status === 'pending' || p.status === 'overdue');

    // 重新生成计划
    const newPlan = await generatePlan(patient, sortedVisits, rules);
    newPlan.status = _checkOverdue(newPlan);

    if (pendingPlans.length > 0) {
      // 更新现有 pending 计划（使用第一个）
      const updated = pendingPlans[0];
      updated.planDate = newPlan.planDate;
      updated.dueDate = newPlan.dueDate;
      updated.priority = newPlan.priority;
      updated.visitType = newPlan.visitType;
      updated.matchedRuleId = newPlan.matchedRuleId;
      updated.intervalDays = newPlan.intervalDays;
      updated.riskLevel = newPlan.riskLevel;
      updated.missedCount = newPlan.missedCount;
      updated.lastVisitDate = newPlan.lastVisitDate;
      updated.lastVisitResult = newPlan.lastVisitResult;
      updated.revisitTrigger = newPlan.revisitTrigger;
      updated.abnormalIndicators = newPlan.abnormalIndicators;
      updated.requiredAttachments = newPlan.requiredAttachments;
      updated.requireQuestionnaire = newPlan.requireQuestionnaire;
      updated.questionnaireTypes = newPlan.questionnaireTypes;
      updated.triggerReport = newPlan.triggerReport;
      updated.reportReason = newPlan.reportReason;
      updated.status = newPlan.status;
      updated.updatedAt = Utils.now();
      updated._recalculatedAt = Utils.now();
      updated._recalcSource = 'post_merge';
      await DB.savePlan(updated);

      // 标记多余的 pending 计划为 cancelled
      for (let i = 1; i < pendingPlans.length; i++) {
        pendingPlans[i].status = 'cancelled';
        pendingPlans[i].cancelledReason = '合并后重新计算';
        pendingPlans[i].supersededByPlanId = updated.id;
        await DB.savePlan(pendingPlans[i]);
      }

      if (typeof DB._logOperation === 'function') {
        await DB._logOperation('followup_plans', updated.id, 'recalculated', {
          patientId: patient.id,
          planDate: updated.planDate,
          dueDate: updated.dueDate,
          source: 'post_merge'
        });
      }

      return updated;
    } else {
      // 无现有 pending 计划 → 创建新计划
      newPlan._recalculatedAt = Utils.now();
      newPlan._recalcSource = 'post_merge';
      await DB.savePlan(newPlan);
      return newPlan;
    }
  }

  // ==================== 计划状态汇总 ====================

  async function getPlanSummary() {
    const plans = await DB.getAllPlans();
    const today = Utils.today();

    const summary = {
      total: plans.length,
      pending: 0,
      overdue: 0,
      completed: 0,
      today: 0,
      upcoming: 0,
      highPriority: 0,
      needRevisit: 0,
      needReport: 0,
      needAttachment: 0
    };

    for (const plan of plans) {
      // 自动检查逾期
      if (plan.status === 'pending' && Utils.daysBetween(plan.dueDate, today) > 0) {
        plan.status = 'overdue';
      }

      switch (plan.status) {
        case 'pending':
          summary.pending++;
          if (plan.planDate === today) summary.today++;
          else if (Utils.daysBetween(today, plan.planDate) <= 3) summary.upcoming++;
          break;
        case 'overdue': summary.overdue++; break;
        case 'completed': summary.completed++; break;
      }

      if (plan.priority === 1) summary.highPriority++;
      if (plan.revisitTrigger && plan.revisitTrigger.action !== 'none') summary.needRevisit++;
      if (plan.triggerReport) summary.needReport++;
      if (plan.requiredAttachments && plan.requiredAttachments.length > 0) summary.needAttachment++;
    }

    return summary;
  }

  // ==================== 导出审计数据 ====================

  async function exportAuditData() {
    const plans = await DB.getAllPlans();
    const patients = await DB.loadAllPatients();
    const rules = await _loadRules();

    const auditData = {
      exportDate: Utils.now(),
      reportType: 'followup_plan_audit',
      version: '1.0',
      summary: await getPlanSummary(),
      riskRules: rules,
      plans: plans.map(p => ({
        id: p.id,
        patientId: p.patientId,
        patientName: p.patientName,
        planDate: p.planDate,
        dueDate: p.dueDate,
        priority: p.priority,
        visitType: p.visitType,
        status: p.status,
        matchedRuleId: p.matchedRuleId,
        missedCount: p.missedCount,
        revisitTrigger: p.revisitTrigger,
        abnormalIndicators: p.abnormalIndicators,
        requiredAttachments: p.requiredAttachments,
        triggerReport: p.triggerReport,
        reportReason: p.reportReason,
        createdAt: p.createdAt,
        completedAt: p.completedAt || null
      })),
      patientRiskProfile: patients.map(p => ({
        id: p.id,
        name: p.name,
        riskLevel: p.riskLevel,
        diseases: p.diseases,
        lastVisitDate: p.lastVisitDate
      }))
    };

    return auditData;
  }

  return {
    generatePlan, generateAllPlans, processPostVisit,
    recalculatePlansForPatient,
    getPlanSummary, exportAuditData,
    DEFAULT_RISK_RULES, REVISIT_TRIGGER_RULES,
    _matchRule, _evaluateConditions, _detectAbnormalIndicators,
    _evaluateRevisitTrigger, _getRequiredAttachments,
    _calculateMissedCount
  };
})();
