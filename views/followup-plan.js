// 随访计划视图 - 展示计划时间线、状态、分层信息、附件队列状态联动
const FollowupPlanView = (() => {
  let _filter = 'all'; // all | pending | overdue | completed

  async function render(params = {}) {
    document.getElementById('page-title').textContent = '随访计划';
    document.getElementById('btn-back').style.display = 'none';
    document.getElementById('bottom-nav').style.display = 'flex';

    await FollowupPlan.loadSavedRules();
    const stats = await FollowupPlan.getPlanStats();
    const allPlans = await DB.loadAllPlans();
    const attachmentQueue = await DB.getAttachmentQueue();

    // 按筛选条件过滤
    let plans = allPlans;
    if (_filter === 'pending') plans = plans.filter(p => p.status === 'pending');
    else if (_filter === 'overdue') plans = plans.filter(p => p.status === 'overdue');
    else if (_filter === 'completed') plans = plans.filter(p => p.status === 'completed');

    // 排序：紧急 > 补访 > 复诊 > 常规，同类按日期
    const typeOrder = { urgent: 0, makeup: 1, review: 2, routine: 3 };
    plans.sort((a, b) => {
      if (a.status !== b.status) {
        const so = { overdue: 0, pending: 1, completed: 2, cancelled: 3 };
        return (so[a.status] || 9) - (so[b.status] || 9);
      }
      if (a.planType !== b.planType) return (typeOrder[a.planType] || 9) - (typeOrder[b.planType] || 9);
      return new Date(a.plannedDate) - new Date(b.plannedDate);
    });

    const container = document.getElementById('view-container');
    container.innerHTML = `
      <div style="padding:12px">
        <!-- 统计卡片 -->
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;margin-bottom:12px">
          <div class="stat-card" style="text-align:center;padding:8px;background:var(--primary-light);border-radius:8px">
            <div style="font-size:20px;font-weight:700;color:var(--primary)">${stats.pending}</div>
            <div style="font-size:11px;color:var(--text-secondary)">待执行</div>
          </div>
          <div class="stat-card" style="text-align:center;padding:8px;background:#fff3e0;border-radius:8px">
            <div style="font-size:20px;font-weight:700;color:#fb8c00">${stats.overdue}</div>
            <div style="font-size:11px;color:var(--text-secondary)">已逾期</div>
          </div>
          <div class="stat-card" style="text-align:center;padding:8px;background:#e8f5e9;border-radius:8px">
            <div style="font-size:20px;font-weight:700;color:#43a047">${stats.todayDue}</div>
            <div style="font-size:11px;color:var(--text-secondary)">今日待访</div>
          </div>
          <div class="stat-card" style="text-align:center;padding:8px;background:#f3e5f5;border-radius:8px">
            <div style="font-size:20px;font-weight:700;color:#7b1fa2">${stats.completed}</div>
            <div style="font-size:11px;color:var(--text-secondary)">已完成</div>
          </div>
        </div>

        <!-- 风险分布 -->
        <div class="card" style="margin-bottom:12px;padding:12px">
          <div style="font-size:13px;font-weight:600;margin-bottom:8px">待执行分布</div>
          <div style="display:flex;gap:12px;font-size:12px">
            <span style="color:#e53935">高风险: ${stats.byRisk.high}</span>
            <span style="color:#fb8c00">中风险: ${stats.byRisk.medium}</span>
            <span style="color:#43a047">低风险: ${stats.byRisk.low}</span>
            <span style="color:#9e9e9e">未评估: ${stats.byRisk.none}</span>
          </div>
          <div style="display:flex;gap:12px;font-size:12px;margin-top:4px">
            <span>常规: ${stats.byType.routine}</span>
            <span style="color:#fb8c00">补访: ${stats.byType.makeup}</span>
            <span style="color:#1a73e8">复诊: ${stats.byType.review}</span>
            <span style="color:#e53935">紧急: ${stats.byType.urgent}</span>
          </div>
        </div>

        <!-- 附件队列状态 -->
        ${attachmentQueue.length > 0 ? `
        <div class="card" style="margin-bottom:12px;padding:12px;background:#fff3e0">
          <div style="font-size:13px;font-weight:600;color:#e65100;margin-bottom:4px">附件上传队列</div>
          <div style="font-size:12px;color:#bf360c">
            ${attachmentQueue.length} 个附件待上传 ·
            ${attachmentQueue.filter(a => a.status === 'failed').length} 个失败
          </div>
        </div>` : ''}

        <!-- 操作按钮 -->
        <div style="display:flex;gap:8px;margin-bottom:12px">
          <button class="btn btn-primary btn-sm" id="btn-generate-plans" style="flex:1">生成计划</button>
          <button class="btn btn-outline btn-sm" id="btn-plan-config" style="flex:1">规则配置</button>
        </div>

        <!-- 筛选 -->
        <div class="filter-chips" style="margin-bottom:12px;display:flex;gap:6px;flex-wrap:wrap">
          <span class="chip ${_filter === 'all' ? 'active' : ''}" data-filter="all">全部 (${allPlans.length})</span>
          <span class="chip ${_filter === 'pending' ? 'active' : ''}" data-filter="pending">待执行 (${stats.pending})</span>
          <span class="chip ${_filter === 'overdue' ? 'active' : ''}" data-filter="overdue">逾期 (${stats.overdue})</span>
          <span class="chip ${_filter === 'completed' ? 'active' : ''}" data-filter="completed">已完成 (${stats.completed})</span>
        </div>

        <!-- 计划列表 -->
        <div id="plan-list">
          ${plans.length === 0
            ? '<div style="text-align:center;padding:32px;color:var(--text-secondary)">暂无随访计划，点击"生成计划"自动创建</div>'
            : plans.map(p => _renderPlanCard(p, attachmentQueue)).join('')}
        </div>
      </div>
    `;

    _bindEvents();
  }

  function _renderPlanCard(plan, attachmentQueue) {
    const typeLabels = { routine: '常规', makeup: '补访', review: '复诊', urgent: '紧急' };
    const typeColors = { routine: '#1a73e8', makeup: '#fb8c00', review: '#7b1fa2', urgent: '#e53935' };
    const statusLabels = { pending: '待执行', overdue: '已逾期', completed: '已完成', cancelled: '已取消' };
    const statusColors = { pending: '#1a73e8', overdue: '#e53935', completed: '#43a047', cancelled: '#9e9e9e' };

    const today = Utils.today();
    const daysUntil = Utils.daysBetween(today, plan.plannedDate);
    let dateHint = '';
    if (plan.status === 'pending') {
      if (daysUntil < 0) dateHint = `逾期 ${Math.abs(daysUntil)} 天`;
      else if (daysUntil === 0) dateHint = '今日';
      else dateHint = `${daysUntil} 天后`;
    }

    // 附件队列联动：检查关联随访的附件状态
    const relatedAttachments = plan.completedVisitId
      ? attachmentQueue.filter(a => a.visitId === plan.completedVisitId)
      : [];
    const hasPendingAttachments = relatedAttachments.length > 0;

    return `
      <div class="card plan-card" style="margin-bottom:8px;padding:12px;cursor:pointer"
           data-plan-id="${plan.id}" data-patient-id="${plan.patientId}">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <div style="display:flex;align-items:center;gap:6px">
            <span style="font-weight:600;font-size:14px">${Utils.escapeHTML(plan.patientName)}</span>
            <span style="font-size:11px;padding:2px 6px;border-radius:10px;color:#fff;background:${typeColors[plan.planType]}">${typeLabels[plan.planType]}</span>
            ${plan.missedCount > 0 ? `<span style="font-size:11px;padding:2px 6px;border-radius:10px;color:#fff;background:#e53935">漏${plan.missedCount}</span>` : ''}
          </div>
          <span style="font-size:12px;color:${statusColors[plan.status]};font-weight:500">${statusLabels[plan.status]}</span>
        </div>
        <div style="font-size:12px;color:var(--text-secondary);display:flex;gap:12px;flex-wrap:wrap">
          <span>计划日期: ${Utils.formatDate(plan.plannedDate)} ${dateHint ? `(${dateHint})` : ''}</span>
          <span style="color:${Utils.riskColor(plan.riskLevel)}">${Utils.riskLabel(plan.riskLevel)}</span>
        </div>
        ${plan.requiredQuestionnaires && plan.requiredQuestionnaires.length > 0
          ? `<div style="font-size:11px;color:var(--primary);margin-top:4px">需填: ${plan.requiredQuestionnaires.join('、')}问卷</div>` : ''}
        ${plan.requireAttachment ? '<div style="font-size:11px;color:#e65100;margin-top:2px">需附件</div>' : ''}
        ${plan.adjustmentReason ? `<div style="font-size:11px;color:#e53935;margin-top:2px">${Utils.escapeHTML(plan.adjustmentReason)}</div>` : ''}
        ${hasPendingAttachments ? `<div style="font-size:11px;color:#bf360c;margin-top:2px">附件上传中 (${relatedAttachments.length})</div>` : ''}
      </div>
    `;
  }

  function _bindEvents() {
    // Filter chips
    document.querySelectorAll('.filter-chips .chip').forEach(chip => {
      chip.addEventListener('click', () => {
        _filter = chip.dataset.filter;
        render();
      });
    });

    // Generate plans
    document.getElementById('btn-generate-plans').addEventListener('click', async () => {
      const result = await FollowupPlan.generateAllPlans();
      Utils.showToast(`已生成 ${result.generated} 个计划 (跳过 ${result.skipped})`, 'success');
      render();
    });

    // Config
    document.getElementById('btn-plan-config').addEventListener('click', () => {
      App.navigate('risk-config');
    });

    // Plan card click → navigate to patient detail
    document.querySelectorAll('.plan-card').forEach(card => {
      card.addEventListener('click', () => {
        const patientId = card.dataset.patientId;
        if (patientId) App.navigate('detail', { patientId });
      });
    });
  }

  return { render };
})();
