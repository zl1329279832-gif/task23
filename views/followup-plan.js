// 随访计划视图 - 分层随访计划列表 + 补访状态 + 操作
const FollowupPlanView = (() => {
  let _plans = [];
  let _filter = 'all'; // all | pending | overdue | completed
  let _summary = null;

  async function render() {
    document.getElementById('page-title').textContent = '随访计划';
    document.getElementById('btn-back').style.display = 'none';
    document.getElementById('bottom-nav').style.display = 'flex';

    _plans = await DB.getAllPlans();
    _summary = await FollowupPlan.getPlanSummary();

    // 自动更新逾期状态
    const today = Utils.today();
    for (const plan of _plans) {
      if (plan.status === 'pending' && Utils.daysBetween(plan.dueDate, today) > 0) {
        plan.status = 'overdue';
        await DB.savePlan(plan);
      }
    }

    const container = document.getElementById('view-container');

    container.innerHTML = `
      <!-- 汇总卡片 -->
      <div class="card plan-summary" style="margin:12px">
        <div class="card-title" style="margin-bottom:12px">计划概览</div>
        <div class="plan-summary-grid">
          <div class="plan-stat">
            <div class="value" style="color:var(--danger)">${_summary.overdue}</div>
            <div class="label">逾期</div>
          </div>
          <div class="plan-stat">
            <div class="value" style="color:var(--warning)">${_summary.today}</div>
            <div class="label">今日</div>
          </div>
          <div class="plan-stat">
            <div class="value" style="color:var(--primary)">${_summary.upcoming}</div>
            <div class="label">即将到期</div>
          </div>
          <div class="plan-stat">
            <div class="value" style="color:var(--success)">${_summary.completed}</div>
            <div class="label">已完成</div>
          </div>
        </div>
        ${_summary.needRevisit > 0 || _summary.needReport > 0 ? `
          <div class="plan-alerts" style="margin-top:12px">
            ${_summary.needRevisit > 0 ? `<span class="tag tag-risk-high">需补访 ${_summary.needRevisit}</span>` : ''}
            ${_summary.needReport > 0 ? `<span class="tag" style="background:#ffebee;color:#c62828">需上报 ${_summary.needReport}</span>` : ''}
            ${_summary.needAttachment > 0 ? `<span class="tag" style="background:#fff3e0;color:#e65100">需附件 ${_summary.needAttachment}</span>` : ''}
          </div>
        ` : ''}
      </div>

      <!-- 操作按钮 -->
      <div style="display:flex;gap:8px;padding:0 12px 8px">
        <button class="btn btn-primary btn-block" id="btn-generate-plans">
          <svg width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
          生成/刷新计划
        </button>
        <button class="btn btn-outline btn-sm" id="btn-risk-config" title="规则配置">
          <svg width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
          规则
        </button>
      </div>

      <!-- 筛选 -->
      <div class="filter-bar">
        <button class="filter-chip ${_filter === 'all' ? 'active' : ''}" data-filter="all">全部 (${_plans.length})</button>
        <button class="filter-chip ${_filter === 'overdue' ? 'active' : ''}" data-filter="overdue">逾期 (${_summary.overdue})</button>
        <button class="filter-chip ${_filter === 'pending' ? 'active' : ''}" data-filter="pending">待执行 (${_summary.pending})</button>
        <button class="filter-chip ${_filter === 'completed' ? 'active' : ''}" data-filter="completed">已完成 (${_summary.completed})</button>
      </div>

      <!-- 计划列表 -->
      <div id="plan-list"></div>
    `;

    _renderList();
    _bindEvents();
  }

  function _renderList() {
    const listEl = document.getElementById('plan-list');
    let filtered = _plans;

    if (_filter !== 'all') {
      filtered = filtered.filter(p => p.status === _filter);
    }

    // Sort: overdue first, then by priority, then by plan date
    filtered.sort((a, b) => {
      const statusOrder = { overdue: 0, pending: 1, completed: 2 };
      const sa = statusOrder[a.status] || 1;
      const sb = statusOrder[b.status] || 1;
      if (sa !== sb) return sa - sb;
      if (a.priority !== b.priority) return a.priority - b.priority;
      return new Date(a.planDate) - new Date(b.planDate);
    });

    if (filtered.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <svg width="64" height="64" viewBox="0 0 24 24"><path fill="currentColor" d="M19 3h-1V1h-2v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11zM9 10H7v2h2v-2zm4 0h-2v2h2v-2zm4 0h-2v2h2v-2z"/></svg>
          <div class="title">暂无随访计划</div>
          <div class="desc">点击"生成/刷新计划"按钮创建计划</div>
        </div>
      `;
      return;
    }

    listEl.innerHTML = filtered.map(plan => _renderPlanCard(plan)).join('');
  }

  function _renderPlanCard(plan) {
    const priorityLabels = { 1: '紧急', 2: '高', 3: '普通' };
    const priorityColors = { 1: 'var(--danger)', 2: 'var(--warning)', 3: 'var(--primary)' };
    const statusLabels = { pending: '待执行', overdue: '逾期', completed: '已完成' };
    const statusColors = { pending: 'var(--warning)', overdue: 'var(--danger)', completed: 'var(--success)' };
    const visitTypeLabels = {
      routine: '常规随访',
      missed_revisit: '补访',
      abnormal_revisit: '异常复查',
      abnormal: '异常随访'
    };

    const daysUntil = Utils.daysBetween(Utils.today(), plan.planDate);
    let dateLabel;
    if (plan.status === 'overdue') {
      dateLabel = `逾期 ${Math.abs(daysUntil)} 天`;
    } else if (daysUntil === 0) {
      dateLabel = '今日';
    } else if (daysUntil === 1) {
      dateLabel = '明日';
    } else if (daysUntil > 0) {
      dateLabel = `${daysUntil} 天后`;
    } else {
      dateLabel = Utils.formatDate(plan.planDate);
    }

    const diseases = (plan.diseases || []).map(d =>
      `<span class="tag tag-disease" style="font-size:11px">${Utils.diseaseLabel(d)}</span>`
    ).join('');

    const alerts = [];
    if (plan.revisitTrigger && plan.revisitTrigger.action !== 'none') {
      alerts.push(`<span class="tag tag-risk-high" style="font-size:11px">${plan.revisitTrigger.label}</span>`);
    }
    if (plan.triggerReport) {
      alerts.push(`<span class="tag" style="background:#ffebee;color:#c62828;font-size:11px">需上报</span>`);
    }
    if (plan.requiredAttachments && plan.requiredAttachments.length > 0) {
      alerts.push(`<span class="tag" style="background:#fff3e0;color:#e65100;font-size:11px">需附件</span>`);
    }
    if (plan.abnormalIndicators && plan.abnormalIndicators.length > 0) {
      alerts.push(`<span class="tag" style="background:#ffebee;color:#c62828;font-size:11px">异常指标</span>`);
    }

    return `
      <div class="card plan-card fade-in" data-plan-id="${plan.id}" style="position:relative;overflow:hidden">
        <div class="risk-bar" style="background:${priorityColors[plan.priority] || 'var(--primary)'};position:absolute;left:0;top:0;bottom:0;width:4px"></div>
        <div style="padding-left:12px">
          <div class="card-header" style="margin-bottom:8px">
            <div>
              <div style="font-size:15px;font-weight:600">${Utils.escapeHTML(plan.patientName || '未知')}</div>
              <div style="font-size:12px;color:var(--text-secondary)">
                ${Utils.formatDate(plan.planDate)} · ${dateLabel}
              </div>
            </div>
            <div style="text-align:right">
              <div style="font-size:12px;font-weight:600;color:${statusColors[plan.status]}">${statusLabels[plan.status]}</div>
              <div style="font-size:11px;color:var(--text-hint)">${priorityLabels[plan.priority] || '普通'}</div>
            </div>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px">
            <span class="tag" style="background:var(--primary-light);color:var(--primary);font-size:11px">
              ${visitTypeLabels[plan.visitType] || plan.visitType}
            </span>
            ${diseases}
            ${alerts.join('')}
          </div>
          ${plan.lastVisitResult ? `
            <div style="font-size:12px;color:var(--text-secondary)">
              上次：${Utils.escapeHTML(plan.lastVisitResult)}
              ${plan.missedCount > 0 ? ` · 漏访 ${plan.missedCount} 次` : ''}
            </div>
          ` : ''}
          ${plan.reportReason ? `
            <div style="font-size:12px;color:var(--danger);margin-top:4px;padding:4px 8px;background:var(--danger-light);border-radius:4px">
              ${Utils.escapeHTML(plan.reportReason)}
            </div>
          ` : ''}
          ${plan.status !== 'completed' ? `
            <div style="display:flex;gap:8px;margin-top:10px">
              <button class="btn btn-sm btn-primary plan-action-btn" data-action="visit" data-plan-id="${plan.id}">执行随访</button>
              ${plan.revisitTrigger && plan.revisitTrigger.action !== 'none'
                ? `<button class="btn btn-sm btn-outline plan-action-btn" data-action="revisit" data-plan-id="${plan.id}">补访问卷</button>`
                : ''}
              ${plan.requireQuestionnaire
                ? `<button class="btn btn-sm btn-secondary plan-action-btn" data-action="questionnaire" data-plan-id="${plan.id}">填写问卷</button>`
                : ''}
            </div>
          ` : `
            <div style="font-size:12px;color:var(--success);margin-top:6px">
              已完成 ${plan.completedAt ? Utils.formatDateTime(plan.completedAt) : ''}
            </div>
          `}
        </div>
      </div>
    `;
  }

  function _bindEvents() {
    // Filter chips
    document.querySelectorAll('.filter-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        _filter = chip.dataset.filter;
        document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        _renderList();
      });
    });

    // Generate plans
    document.getElementById('btn-generate-plans').addEventListener('click', async () => {
      Utils.showToast('正在生成计划...', 'info');
      try {
        const plans = await FollowupPlan.generateAllPlans();
        Utils.showToast(`已生成 ${plans.length} 条计划`, 'success');
        render();
      } catch (err) {
        Utils.showToast('生成失败: ' + err.message, 'error');
      }
    });

    // Risk config
    document.getElementById('btn-risk-config').addEventListener('click', () => {
      App.navigate('risk-config');
    });

    // Plan actions
    document.getElementById('plan-list').addEventListener('click', async e => {
      const btn = e.target.closest('.plan-action-btn');
      if (!btn) return;

      const planId = btn.dataset.planId;
      const action = btn.dataset.action;
      const plan = _plans.find(p => p.id === planId);
      if (!plan) return;

      if (action === 'visit') {
        App.navigate('record', { patientId: plan.patientId });
      } else if (action === 'revisit') {
        // 补访问卷：先弹提示再跳转
        const info = plan.revisitTrigger;
        if (info && info.reportReason) {
          await Utils.showModal('补访提醒',
            `<p style="color:var(--danger);font-weight:500">${Utils.escapeHTML(info.reportReason)}</p>
             <p style="margin-top:8px;font-size:13px">请先完成补访问卷，再进行随访。</p>`,
            [{ label: '知道了', value: true, primary: true }]
          );
        }
        App.navigate('questionnaire', { patientId: plan.patientId });
      } else if (action === 'questionnaire') {
        App.navigate('questionnaire', { patientId: plan.patientId });
      }
    });
  }

  return { render };
})();
