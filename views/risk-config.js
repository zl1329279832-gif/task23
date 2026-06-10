// 风险分层规则配置视图
const RiskConfigView = (() => {
  let _rules = [];
  let _editingRule = null;

  async function render() {
    document.getElementById('page-title').textContent = '风险分层规则';
    document.getElementById('btn-back').style.display = 'flex';
    document.getElementById('bottom-nav').style.display = 'none';
    document.getElementById('btn-back').onclick = () => App.navigate('followup-plan');

    // 加载自定义规则，若无则显示默认规则
    const customRules = await DB.getRiskConfig();
    _rules = customRules.length > 0 ? customRules : [...FollowupPlan.DEFAULT_RISK_RULES];

    const container = document.getElementById('view-container');
    container.innerHTML = `
      <div style="padding:12px 16px 8px">
        <div style="font-size:13px;color:var(--text-secondary);margin-bottom:8px">
          规则按优先级从高到低排序，匹配第一条后停止。优先级数值越小越高。
        </div>
        <button class="btn btn-primary btn-block" id="btn-add-rule">
          <svg width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
          新增规则
        </button>
      </div>

      <div id="rules-list" style="padding:8px 12px">
        ${_rules.map((rule, idx) => _renderRuleCard(rule, idx)).join('')}
      </div>

      <div style="padding:12px">
        <button class="btn btn-secondary btn-block" id="btn-reset-rules">恢复默认规则</button>
      </div>
    `;

    _bindEvents();
  }

  function _renderRuleCard(rule, index) {
    const conditionsText = (rule.conditions || []).map(c => {
      const fieldLabels = {
        riskLevel: '风险等级', diseases: '疾病类型',
        'lastVisit.bpSystolic': '上次收缩压', 'lastVisit.bloodSugar': '上次血糖'
      };
      const opLabels = { eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤', includes: '包含' };
      const field = fieldLabels[c.field] || c.field;
      const op = opLabels[c.operator] || c.operator;
      let value = c.value;
      if (c.field === 'riskLevel') value = Utils.riskLabel(c.value);
      else if (c.field === 'diseases') value = Utils.diseaseLabel(c.value);
      return `${field} ${op} ${value}`;
    }).join(' 且 ');

    const badges = [];
    if (rule.requireQuestionnaire) badges.push('<span class="tag tag-disease" style="font-size:11px">需问卷</span>');
    if (rule.requireAttachments) badges.push('<span class="tag" style="background:#fff3e0;color:#e65100;font-size:11px">需附件</span>');
    if (rule.triggerReport) badges.push('<span class="tag tag-risk-high" style="font-size:11px">触发上报</span>');

    return `
      <div class="card" style="margin-bottom:8px;position:relative;overflow:hidden">
        <div class="risk-bar" style="background:${rule.priority <= 1 ? 'var(--danger)' : rule.priority <= 2 ? 'var(--warning)' : 'var(--primary)'};position:absolute;left:0;top:0;bottom:0;width:4px"></div>
        <div style="padding-left:12px">
          <div class="card-header" style="margin-bottom:4px">
            <div style="font-weight:600;font-size:14px">${Utils.escapeHTML(rule.name)}</div>
            <div style="font-size:12px;color:var(--text-hint)">优先级 ${rule.priority}</div>
          </div>
          <div style="font-size:13px;color:var(--text-secondary);margin-bottom:6px">
            ${conditionsText || '无条件'}
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px">
            <span class="tag" style="background:var(--primary-light);color:var(--primary);font-size:11px">间隔 ${rule.intervalDays} 天</span>
            ${badges.join('')}
          </div>
          <div style="font-size:12px;color:var(--text-hint)">${Utils.escapeHTML(rule.description || '')}</div>
          <div style="display:flex;gap:8px;margin-top:8px">
            <button class="btn btn-sm btn-outline rule-edit-btn" data-idx="${index}">编辑</button>
            <button class="btn btn-sm btn-secondary rule-delete-btn" data-idx="${index}" style="color:var(--danger)">删除</button>
          </div>
        </div>
      </div>
    `;
  }

  function _bindEvents() {
    document.getElementById('btn-add-rule').addEventListener('click', () => _editRule(null));
    document.getElementById('btn-reset-rules').addEventListener('click', async () => {
      const confirm = await Utils.showModal('恢复默认规则',
        '<p>将删除所有自定义规则，恢复为系统默认的风险分层规则。</p>',
        [{ label: '取消', value: false }, { label: '确认恢复', value: true }]);
      if (!confirm) return;
      await DB.clearRiskConfig();
      Utils.showToast('已恢复默认规则', 'success');
      render();
    });

    document.getElementById('rules-list').addEventListener('click', async e => {
      const editBtn = e.target.closest('.rule-edit-btn');
      if (editBtn) {
        _editRule(parseInt(editBtn.dataset.idx));
        return;
      }
      const deleteBtn = e.target.closest('.rule-delete-btn');
      if (deleteBtn) {
        const idx = parseInt(deleteBtn.dataset.idx);
        const confirm = await Utils.showModal('删除规则',
          `<p>确定删除规则"${Utils.escapeHTML(_rules[idx].name)}"吗？</p>`,
          [{ label: '取消', value: false }, { label: '删除', value: true }]);
        if (!confirm) return;
        _rules.splice(idx, 1);
        await _saveAllRules();
        render();
      }
    });
  }

  async function _editRule(index) {
    const isEdit = index !== null && index !== undefined;
    const rule = isEdit ? { ..._rules[index] } : {
      id: Utils.uuid(),
      name: '',
      priority: 3,
      conditions: [{ field: 'riskLevel', operator: 'eq', value: 'high' }],
      intervalDays: 14,
      visitType: 'routine',
      requireAttachments: false,
      requireQuestionnaire: true,
      questionnaireTypes: ['disease-specific'],
      triggerReport: false,
      description: ''
    };

    const content = document.createElement('div');
    content.innerHTML = `
      <div class="form-group">
        <label class="form-label">规则名称 <span class="required">*</span></label>
        <input type="text" class="form-input" id="rule-name" value="${Utils.escapeHTML(rule.name)}" placeholder="例：高风险患者">
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">优先级</label>
          <input type="number" class="form-input" id="rule-priority" value="${rule.priority}" min="0" max="99">
        </div>
        <div class="form-group">
          <label class="form-label">随访间隔（天）</label>
          <input type="number" class="form-input" id="rule-interval" value="${rule.intervalDays}" min="1" max="365">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">匹配条件</label>
        <div id="rule-conditions">
          ${(rule.conditions || []).map((c, i) => _renderConditionRow(c, i)).join('')}
        </div>
        <button class="btn btn-sm btn-outline" id="btn-add-condition" style="margin-top:4px">+ 添加条件</button>
      </div>
      <div class="form-group">
        <label class="form-label">访问类型</label>
        <select class="form-select" id="rule-visit-type">
          <option value="routine" ${rule.visitType === 'routine' ? 'selected' : ''}>常规随访</option>
          <option value="abnormal" ${rule.visitType === 'abnormal' ? 'selected' : ''}>异常随访</option>
          <option value="missed_revisit" ${rule.visitType === 'missed_revisit' ? 'selected' : ''}>补访</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">附加要求</label>
        <div class="checkbox-group">
          <label class="checkbox-item ${rule.requireQuestionnaire ? 'selected' : ''}" data-value="questionnaire">
            <input type="checkbox" id="rule-req-questionnaire" ${rule.requireQuestionnaire ? 'checked' : ''} style="display:none">
            需问卷
          </label>
          <label class="checkbox-item ${rule.requireAttachments ? 'selected' : ''}" data-value="attachments">
            <input type="checkbox" id="rule-req-attachments" ${rule.requireAttachments ? 'checked' : ''} style="display:none">
            需附件
          </label>
          <label class="checkbox-item ${rule.triggerReport ? 'selected' : ''}" data-value="report">
            <input type="checkbox" id="rule-trigger-report" ${rule.triggerReport ? 'checked' : ''} style="display:none">
            触发上报
          </label>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">说明</label>
        <textarea class="form-textarea" id="rule-description" rows="2" placeholder="规则说明">${Utils.escapeHTML(rule.description || '')}</textarea>
      </div>
    `;

    const result = await Utils.showModal(isEdit ? '编辑规则' : '新增规则', content, [
      { label: '取消', value: false },
      { label: '保存', value: true, primary: true }
    ]);

    if (!result) return;

    // 收集表单数据
    const name = document.getElementById('rule-name').value.trim();
    if (!name) { Utils.showToast('请输入规则名称', 'error'); return; }

    rule.name = name;
    rule.priority = parseInt(document.getElementById('rule-priority').value) || 3;
    rule.intervalDays = parseInt(document.getElementById('rule-interval').value) || 14;
    rule.visitType = document.getElementById('rule-visit-type').value;
    rule.requireQuestionnaire = document.getElementById('rule-req-questionnaire').checked;
    rule.requireAttachments = document.getElementById('rule-req-attachments').checked;
    rule.triggerReport = document.getElementById('rule-trigger-report').checked;
    rule.description = document.getElementById('rule-description').value;

    // 收集条件
    const condRows = document.querySelectorAll('#rule-conditions .condition-row');
    rule.conditions = [];
    condRows.forEach(row => {
      const field = row.querySelector('.cond-field').value;
      const operator = row.querySelector('.cond-op').value;
      const value = row.querySelector('.cond-value').value;
      if (field && value) {
        let parsedValue = value;
        if (field === 'riskLevel') parsedValue = value;
        else if (!isNaN(Number(value)) && field !== 'diseases') parsedValue = Number(value);
        rule.conditions.push({ field, operator, value: parsedValue });
      }
    });

    if (isEdit) {
      _rules[index] = rule;
    } else {
      _rules.push(rule);
    }

    // 按优先级排序
    _rules.sort((a, b) => a.priority - b.priority);
    await _saveAllRules();
    render();
  }

  function _renderConditionRow(cond, index) {
    return `
      <div class="condition-row" style="display:flex;gap:4px;margin-bottom:4px;align-items:center">
        <select class="form-select cond-field" style="flex:2;padding:6px 8px;font-size:13px">
          <option value="riskLevel" ${cond.field === 'riskLevel' ? 'selected' : ''}>风险等级</option>
          <option value="diseases" ${cond.field === 'diseases' ? 'selected' : ''}>疾病类型</option>
          <option value="lastVisit.bpSystolic" ${cond.field === 'lastVisit.bpSystolic' ? 'selected' : ''}>上次收缩压</option>
          <option value="lastVisit.bloodSugar" ${cond.field === 'lastVisit.bloodSugar' ? 'selected' : ''}>上次血糖</option>
        </select>
        <select class="form-select cond-op" style="flex:1;padding:6px 8px;font-size:13px">
          <option value="eq" ${cond.operator === 'eq' ? 'selected' : ''}>=</option>
          <option value="ne" ${cond.operator === 'ne' ? 'selected' : ''}>≠</option>
          <option value="gte" ${cond.operator === 'gte' ? 'selected' : ''}>≥</option>
          <option value="lte" ${cond.operator === 'lte' ? 'selected' : ''}>≤</option>
          <option value="includes" ${cond.operator === 'includes' ? 'selected' : ''}>包含</option>
        </select>
        <input type="text" class="form-input cond-value" style="flex:2;padding:6px 8px;font-size:13px"
          value="${Utils.escapeHTML(String(cond.value))}" placeholder="值">
        <button class="btn btn-sm cond-remove" style="color:var(--danger);padding:4px 8px">&times;</button>
      </div>
    `;
  }

  async function _saveAllRules() {
    await DB.clearRiskConfig();
    for (const rule of _rules) {
      await DB.saveRiskConfig({ ...rule });
    }
  }

  // 事件委托处理 checkbox-item 点击（条件编辑弹窗中的）
  document.addEventListener('click', e => {
    const condRemove = e.target.closest('.cond-remove');
    if (condRemove) {
      condRemove.closest('.condition-row')?.remove();
    }
    if (e.target.id === 'btn-add-condition' || e.target.closest('#btn-add-condition')) {
      const container = document.getElementById('rule-conditions');
      if (container) {
        const idx = container.children.length;
        container.insertAdjacentHTML('beforeend',
          _renderConditionRow({ field: 'riskLevel', operator: 'eq', value: '' }, idx));
      }
    }
  });

  return { render };
})();
