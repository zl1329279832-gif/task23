// 风险分层规则配置视图
const RiskConfigView = (() => {
  let _rules = null;

  async function render() {
    document.getElementById('page-title').textContent = '风险分层规则';
    document.getElementById('btn-back').style.display = 'flex';
    document.getElementById('bottom-nav').style.display = 'none';

    await FollowupPlan.loadSavedRules();
    _rules = FollowupPlan.getRules();

    const container = document.getElementById('view-container');
    container.innerHTML = `
      <div style="padding:12px">
        <div style="font-size:13px;color:var(--text-secondary);margin-bottom:12px">
          配置各风险等级的随访间隔、阈值和必填要求。修改后立即生效。
        </div>

        ${_renderRiskSection('high', '高风险', '#e53935')}
        ${_renderRiskSection('medium', '中风险', '#fb8c00')}
        ${_renderRiskSection('low', '低风险', '#43a047')}
        ${_renderRiskSection('none', '未评估', '#9e9e9e')}

        <div class="btn-group" style="padding:12px 0 24px">
          <button class="btn btn-secondary" id="btn-reset-rules">恢复默认</button>
          <button class="btn btn-primary" id="btn-save-rules">保存配置</button>
        </div>
      </div>
    `;

    _bindEvents();
  }

  function _renderRiskSection(level, label, color) {
    const r = _rules[level];
    return `
      <div class="card" style="margin-bottom:12px;padding:12px;border-left:3px solid ${color}">
        <div style="font-weight:600;font-size:14px;color:${color};margin-bottom:10px">${label}</div>

        <div class="config-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px">
          <label>随访间隔(天)</label>
          <input type="number" class="form-input config-input" data-level="${level}" data-field="baseInterval"
            value="${r.baseInterval}" min="1" max="365" style="height:32px;font-size:13px">

          <label>漏访升级阈值(次)</label>
          <input type="number" class="form-input config-input" data-level="${level}" data-field="maxMissedBeforeUrgent"
            value="${r.maxMissedBeforeUrgent}" min="1" max="20" style="height:32px;font-size:13px">

          <label>补访截止(天)</label>
          <input type="number" class="form-input config-input" data-level="${level}" data-field="makeupDeadlineDays"
            value="${r.makeupDeadlineDays}" min="1" max="30" style="height:32px;font-size:13px">

          <label>收缩压阈值</label>
          <input type="number" class="form-input config-input" data-level="${level}" data-field="abnormal_bpSystolic"
            value="${r.abnormalThresholds.bpSystolic}" min="100" max="300" style="height:32px;font-size:13px">

          <label>舒张压阈值</label>
          <input type="number" class="form-input config-input" data-level="${level}" data-field="abnormal_bpDiastolic"
            value="${r.abnormalThresholds.bpDiastolic}" min="50" max="200" style="height:32px;font-size:13px">

          <label>血糖阈值</label>
          <input type="number" class="form-input config-input" data-level="${level}" data-field="abnormal_bloodSugar"
            value="${r.abnormalThresholds.bloodSugar}" min="3" max="50" step="0.1" style="height:32px;font-size:13px">
        </div>

        <div style="margin-top:8px;display:flex;gap:12px;font-size:13px">
          <label style="display:flex;align-items:center;gap:4px">
            <input type="checkbox" class="config-check" data-level="${level}" data-field="requireAttachment"
              ${r.requireAttachment ? 'checked' : ''}>
            必须附件
          </label>
          <label style="display:flex;align-items:center;gap:4px">
            <input type="checkbox" class="config-check" data-level="${level}" data-field="requireQuestionnaire"
              ${r.requireQuestionnaire ? 'checked' : ''}>
            必须问卷
          </label>
        </div>
      </div>
    `;
  }

  function _bindEvents() {
    // Back
    document.getElementById('btn-back').onclick = () => {
      App.navigate('followup-plan');
    };

    // Save
    document.getElementById('btn-save-rules').addEventListener('click', async () => {
      _collectRules();
      await FollowupPlan.updateRules(_rules);
      Utils.showToast('规则已保存', 'success');
      App.navigate('followup-plan');
    });

    // Reset
    document.getElementById('btn-reset-rules').addEventListener('click', async () => {
      const confirm = await Utils.showModal(
        '恢复默认',
        '<p>确定要恢复所有规则为默认值吗？</p>',
        [
          { label: '取消', value: false },
          { label: '确认恢复', value: true, primary: true }
        ]
      );
      if (!confirm) return;
      await DB.setSetting('stratification_rules', null);
      Utils.showToast('已恢复默认', 'success');
      render();
    });
  }

  function _collectRules() {
    document.querySelectorAll('.config-input').forEach(input => {
      const level = input.dataset.level;
      const field = input.dataset.field;

      if (field.startsWith('abnormal_')) {
        const key = field.replace('abnormal_', '');
        _rules[level].abnormalThresholds[key] = parseFloat(input.value) || 0;
      } else {
        _rules[level][field] = parseInt(input.value) || 0;
      }
    });

    document.querySelectorAll('.config-check').forEach(check => {
      const level = check.dataset.level;
      const field = check.dataset.field;
      _rules[level][field] = check.checked;
    });
  }

  return { render };
})();
