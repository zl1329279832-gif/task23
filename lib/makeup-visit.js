// 离线智能补访引擎 - 随访完成后判断是否触发补访问卷、复诊提醒、异常指标上报、附件必传
const MakeupVisit = (() => {

  // 触发动作类型
  const ACTION_TYPE = {
    MAKEUP_QUESTIONNAIRE: 'makeup_questionnaire', // 触发补访问卷
    REVIEW_REMINDER: 'review_reminder',           // 复诊提醒
    ABNORMAL_REPORT: 'abnormal_report',           // 异常指标上报
    REQUIRE_ATTACHMENT: 'require_attachment'       // 附件必传
  };

  // 补访问卷触发条件
  const MAKEUP_TRIGGERS = {
    // 漏访后首次随访
    missedVisitFollowup: (patient, visit, context) => {
      return context.missedCount > 0;
    },
    // 高风险指标
    highRiskIndicators: (patient, visit, context) => {
      const rules = FollowupPlan.getPatientRules(patient);
      const abnormals = FollowupPlan.detectAbnormalIndicators(visit, rules);
      return abnormals.length > 0;
    },
    // 用药变更
    medicationChange: (patient, visit, context) => {
      if (!context.previousVisit || !visit.medications) return false;
      const prev = (context.previousVisit.medications || []).sort().join(',');
      const curr = (visit.medications || []).sort().join(',');
      return prev !== curr;
    }
  };

  /**
   * 离线随访完成后的智能判断
   * @param {Object} patient - 患者对象
   * @param {Object} visit - 本次随访记录
   * @param {Object} activePlan - 当前执行的计划（可为null）
   * @returns {Object} { actions: Array, plan: Object }
   */
  async function evaluateVisit(patient, visit, activePlan) {
    const actions = [];
    const visits = await DB.loadVisitsByPatient(patient.id);
    const previousVisit = visits
      .filter(v => !v.isDraft && v.id !== visit.id)
      .sort((a, b) => new Date(b.date) - new Date(a.date))[0] || null;

    const missedCount = await FollowupPlan.countMissedVisits(patient.id);
    const rules = FollowupPlan.getPatientRules(patient);
    const context = { missedCount, previousVisit, rules, activePlan };

    // 1. 检查是否触发补访问卷
    const makeupResult = checkMakeupQuestionnaire(patient, visit, context);
    if (makeupResult.triggered) {
      actions.push({
        type: ACTION_TYPE.MAKEUP_QUESTIONNAIRE,
        priority: makeupResult.priority,
        reason: makeupResult.reason,
        questionnaires: makeupResult.questionnaires,
        data: makeupResult
      });
    }

    // 2. 检查是否触发复诊提醒
    const reviewResult = checkReviewReminder(patient, visit, context);
    if (reviewResult.triggered) {
      actions.push({
        type: ACTION_TYPE.REVIEW_REMINDER,
        priority: reviewResult.priority,
        reason: reviewResult.reason,
        reviewDate: reviewResult.reviewDate,
        data: reviewResult
      });
    }

    // 3. 检查异常指标上报
    const abnormalResult = checkAbnormalReport(patient, visit, context);
    if (abnormalResult.triggered) {
      actions.push({
        type: ACTION_TYPE.ABNORMAL_REPORT,
        priority: 'high',
        reason: abnormalResult.reason,
        indicators: abnormalResult.indicators,
        data: abnormalResult
      });
    }

    // 4. 检查附件必传规则
    const attachmentResult = checkAttachmentRequirement(patient, visit, context);
    if (attachmentResult.required) {
      actions.push({
        type: ACTION_TYPE.REQUIRE_ATTACHMENT,
        priority: attachmentResult.priority,
        reason: attachmentResult.reason,
        data: attachmentResult
      });
    }

    // 完成当前计划并生成下一个
    let nextPlan = null;
    if (activePlan) {
      await FollowupPlan.completePlan(activePlan.id, visit.id);
    }

    // 根据触发结果生成下一个计划
    const hasUrgent = actions.some(a => a.priority === 'high');
    if (hasUrgent) {
      nextPlan = await FollowupPlan.generatePlanForPatient(patient, visit, { force: true });
    } else {
      nextPlan = await FollowupPlan.generatePlanForPatient(patient, visit);
    }

    return { actions, nextPlan };
  }

  /**
   * 检查是否需要补访问卷
   */
  function checkMakeupQuestionnaire(patient, visit, context) {
    const result = { triggered: false, reason: '', questionnaires: [], priority: 'normal' };
    const triggers = [];

    // 漏访后首次随访 → 需要补访问卷
    if (MAKEUP_TRIGGERS.missedVisitFollowup(patient, visit, context)) {
      triggers.push(`漏访 ${context.missedCount} 次后补访`);
      result.priority = context.missedCount >= 2 ? 'high' : 'normal';
    }

    // 高风险指标 → 需要详细问卷
    if (MAKEUP_TRIGGERS.highRiskIndicators(patient, visit, context)) {
      triggers.push('异常指标需补充评估');
      result.priority = 'high';
    }

    // 用药变更 → 需要用药评估问卷
    if (MAKEUP_TRIGGERS.medicationChange(patient, visit, context)) {
      triggers.push('用药方案变更');
    }

    if (triggers.length > 0) {
      result.triggered = true;
      result.reason = triggers.join('；');

      // 确定需要的补访问卷
      if (patient.diseases) {
        for (const disease of patient.diseases) {
          const qType = FollowupPlan.DISEASE_QUESTIONNAIRE_MAP[disease];
          if (qType) result.questionnaires.push(qType);
        }
      }
      // 至少需要通用问卷
      if (result.questionnaires.length === 0) {
        result.questionnaires.push('general');
      }
    }

    return result;
  }

  /**
   * 检查是否需要复诊提醒
   */
  function checkReviewReminder(patient, visit, context) {
    const result = { triggered: false, reason: '', reviewDate: null, priority: 'normal' };
    const rules = context.rules;
    const abnormals = FollowupPlan.detectAbnormalIndicators(visit, rules);

    // 异常指标需要复诊
    if (abnormals.length > 0) {
      result.triggered = true;
      result.reason = `${abnormals.map(a => a.label).join('、')}，建议复诊`;
      result.priority = 'high';
      // 复诊日期：当前日期 + 间隔的一半
      const interval = FollowupPlan.computeInterval(patient, visit.riskLevel);
      result.reviewDate = Utils.addDays(visit.date, Math.ceil(interval / 2));
    }

    // 高风险 + 漏访 → 强制复诊
    if (patient.riskLevel === 'high' && context.missedCount > 0) {
      result.triggered = true;
      result.reason = result.reason
        ? result.reason + '；高风险漏访需复诊'
        : '高风险患者漏访，需尽快复诊';
      result.priority = 'high';
      if (!result.reviewDate) {
        result.reviewDate = Utils.addDays(visit.date, 3);
      }
    }

    // 风险等级上升 → 建议复诊
    if (context.previousVisit &&
        _riskOrder(visit.riskLevel) < _riskOrder(context.previousVisit.riskLevel)) {
      result.triggered = true;
      const prevLabel = Utils.riskLabel(context.previousVisit.riskLevel);
      const currLabel = Utils.riskLabel(visit.riskLevel);
      result.reason = result.reason
        ? result.reason + `；风险等级 ${prevLabel}→${currLabel}`
        : `风险等级从 ${prevLabel} 升至 ${currLabel}，建议复诊`;
      if (!result.reviewDate) {
        result.reviewDate = Utils.addDays(visit.date, 7);
      }
    }

    return result;
  }

  function _riskOrder(level) {
    return { high: 0, medium: 1, low: 2, none: 3 }[level] || 3;
  }

  /**
   * 检查异常指标上报
   */
  function checkAbnormalReport(patient, visit, context) {
    const result = { triggered: false, reason: '', indicators: [] };
    const rules = context.rules;
    const abnormals = FollowupPlan.detectAbnormalIndicators(visit, rules);

    if (abnormals.length > 0) {
      result.triggered = true;
      result.indicators = abnormals;
      result.reason = abnormals.map(a =>
        `${a.label}: ${a.value} (阈值 ${a.threshold})`
      ).join('；');
    }

    return result;
  }

  /**
   * 检查附件必传规则
   */
  function checkAttachmentRequirement(patient, visit, context) {
    const result = { required: false, reason: '', priority: 'normal' };
    const rules = context.rules;
    const reasons = [];

    // 规则要求必传
    if (rules.requireAttachment) {
      reasons.push('当前风险等级要求附件');
    }

    // 异常指标需要附件佐证
    const abnormals = FollowupPlan.detectAbnormalIndicators(visit, rules);
    if (abnormals.length > 0) {
      reasons.push('异常指标需附件佐证');
      result.priority = 'high';
    }

    // 漏访补访需要附件
    if (context.missedCount >= 2) {
      reasons.push('多次漏访补访需附件');
    }

    // 当前计划要求附件
    if (context.activePlan && context.activePlan.requireAttachment) {
      reasons.push('随访计划要求附件');
    }

    // 检查是否已有附件
    const hasAttachment = visit.attachments && visit.attachments.length > 0;
    if (reasons.length > 0 && !hasAttachment) {
      result.required = true;
      result.reason = reasons.join('；');
    }

    return result;
  }

  /**
   * 获取患者的待处理动作列表（用于UI展示）
   */
  async function getPendingActions(patientId) {
    const key = `pending_actions_${patientId}`;
    const saved = await DB.getSetting(key);
    if (saved) {
      try { return JSON.parse(saved); } catch { return []; }
    }
    return [];
  }

  /**
   * 保存待处理动作（离线状态下暂存）
   */
  async function savePendingActions(patientId, actions) {
    const key = `pending_actions_${patientId}`;
    await DB.setSetting(key, JSON.stringify(actions));
  }

  /**
   * 清除已处理的动作
   */
  async function clearPendingActions(patientId) {
    const key = `pending_actions_${patientId}`;
    await DB.setSetting(key, JSON.stringify([]));
  }

  /**
   * 批量检查所有患者的待处理状态
   */
  async function checkAllPendingActions() {
    const patients = await DB.loadAllPatients();
    const allActions = [];

    for (const patient of patients) {
      const actions = await getPendingActions(patient.id);
      if (actions.length > 0) {
        allActions.push({
          patient,
          actions
        });
      }
    }

    return allActions;
  }

  return {
    ACTION_TYPE,
    evaluateVisit,
    checkMakeupQuestionnaire,
    checkReviewReminder,
    checkAbnormalReport,
    checkAttachmentRequirement,
    getPendingActions, savePendingActions, clearPendingActions,
    checkAllPendingActions
  };
})();
