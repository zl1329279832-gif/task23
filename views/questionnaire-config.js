// 问卷模板管理 + 设置视图
const QuestionnaireConfigView = (() => {
  let _templates = [];

  async function render() {
    document.getElementById('page-title').textContent = '设置';
    document.getElementById('btn-back').style.display = 'none';
    document.getElementById('bottom-nav').style.display = 'flex';

    _templates = await DB.getAllTemplates();
    const lastSync = await DB.getSetting('lastSyncTime');
    const pinSet = await DB.getSetting('pin_verify');
    const stats = await DB.getStorageStats();

    const container = document.getElementById('view-container');
    container.innerHTML = `
      <div class="settings-group">
        <div class="group-title">安全设置</div>
        <div class="settings-item" id="btn-change-pin">
          <span class="label">${pinSet ? '修改 PIN 码' : '设置 PIN 码'}</span>
          <svg width="20" height="20" viewBox="0 0 24 24"><path fill="var(--text-hint)" d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>
        </div>
        <div class="settings-item" id="btn-switch-pin">
          <div>
            <span class="label">PIN 快速切换</span>
            <div style="font-size:12px;color:var(--text-hint);margin-top:2px">临时锁定并切换到不同 PIN 配置</div>
          </div>
          <svg width="20" height="20" viewBox="0 0 24 24"><path fill="var(--text-hint)" d="M12 6V1.5l-5 5 5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>
        </div>
        <div class="settings-item" id="btn-auto-lock">
          <span class="label">自动锁定</span>
          <span class="value" id="auto-lock-value">${await DB.getSetting('autoLockMinutes') || '5'} 分钟</span>
        </div>
      </div>

      <div class="settings-group">
        <div class="group-title">随访计划</div>
        <div class="settings-item" id="btn-manage-plans">
          <div>
            <span class="label">管理随访计划</span>
            <div style="font-size:12px;color:var(--text-hint);margin-top:2px">查看和刷新分层随访计划</div>
          </div>
          <svg width="20" height="20" viewBox="0 0 24 24"><path fill="var(--text-hint)" d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>
        </div>
        <div class="settings-item" id="btn-risk-rules">
          <div>
            <span class="label">风险分层规则</span>
            <div style="font-size:12px;color:var(--text-hint);margin-top:2px">配置随访间隔和触发条件</div>
          </div>
          <svg width="20" height="20" viewBox="0 0 24 24"><path fill="var(--text-hint)" d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>
        </div>
      </div>

      <div class="settings-group">
        <div class="group-title">问卷模板</div>
        ${_templates.length === 0 ? `
          <div class="settings-item">
            <span class="label" style="color:var(--text-hint)">暂无模板</span>
          </div>
        ` : _templates.map(t => `
          <div class="settings-item">
            <div>
              <div class="label">${Utils.escapeHTML(t.name)}</div>
              <div class="value">${Utils.diseaseLabel(t.diseaseType)} · v${t.version} · ${t.questions.length}题</div>
            </div>
            <span class="tag tag-disease" style="font-size:11px">${t.diseaseType}</span>
          </div>
        `).join('')}
        <div class="settings-item" id="btn-import-templates" style="color:var(--primary)">
          <span class="label">导入/更新问卷模板</span>
          <svg width="20" height="20" viewBox="0 0 24 24"><path fill="var(--primary)" d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>
        </div>
      </div>

      <div class="settings-group">
        <div class="group-title">同步设置</div>
        <div class="settings-item">
          <span class="label">自动同步</span>
          <span class="value">每 30 秒检查</span>
        </div>
        <div class="settings-item">
          <span class="label">上次同步</span>
          <span class="value">${lastSync ? Utils.formatDateTime(lastSync) : '从未同步'}</span>
        </div>
        <div class="settings-item">
          <span class="label">待同步记录</span>
          <span class="value">${stats.sync_queue || 0} 条</span>
        </div>
      </div>

      <div class="settings-group">
        <div class="group-title">通知设置</div>
        <div class="settings-item" id="btn-notification">
          <span class="label">浏览器通知</span>
          <span class="value">${Notification && Notification.permission === 'granted' ? '已开启' : '未开启'}</span>
        </div>
      </div>

      <div class="settings-group">
        <div class="group-title">演示数据</div>
        <div class="settings-item" id="btn-load-demo" style="color:var(--primary)">
          <span class="label">加载演示数据</span>
          <svg width="20" height="20" viewBox="0 0 24 24"><path fill="var(--primary)" d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>
        </div>
        <div class="settings-item" id="btn-upgrade-template" style="color:var(--primary)">
          <span class="label">模拟问卷版本升级</span>
          <svg width="20" height="20" viewBox="0 0 24 24"><path fill="var(--primary)" d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>
        </div>
      </div>

      <div class="settings-group">
        <div class="group-title">关于</div>
        <div class="settings-item">
          <span class="label">版本</span>
          <span class="value">1.0.0</span>
        </div>
        <div class="settings-item">
          <span class="label">技术栈</span>
          <span class="value">HTML5 / PWA / IndexedDB</span>
        </div>
      </div>

      <div style="padding:16px;text-align:center;font-size:12px;color:var(--text-hint)">
        医疗随访离线采集系统 · 仅供演示
      </div>
    `;

    _bindEvents();
  }

  function _bindEvents() {
    // Change PIN
    document.getElementById('btn-change-pin').addEventListener('click', async () => {
      const pinSet = await DB.getSetting('pin_verify');
      if (pinSet) {
        // Verify old PIN
        const oldPin = await _showPinInput('输入当前 PIN 码');
        if (oldPin === null) return;
        const valid = await CryptoManager.verifyPin(oldPin);
        if (!valid) {
          Utils.showToast('当前 PIN 码不正确', 'error');
          return;
        }
      }

      const newPin = await _showPinInput('设置新 PIN 码 (4-6位)');
      if (newPin === null) return;
      if (newPin.length < 4 || newPin.length > 6 || !/^\d+$/.test(newPin)) {
        Utils.showToast('PIN 码需为 4-6 位数字', 'error');
        return;
      }

      if (pinSet) {
        await CryptoManager.changePin(
          document.querySelector('.pin-input-temp')?.value || '',
          newPin
        );
      } else {
        await CryptoManager.init(newPin);
      }
      Utils.showToast('PIN 码已更新', 'success');
      render();
    });

    // PIN 快速切换 - 验证当前 PIN 后设置临时 PIN
    document.getElementById('btn-switch-pin').addEventListener('click', async () => {
      const pinSet = await DB.getSetting('pin_verify');
      if (!pinSet) {
        Utils.showToast('请先设置 PIN 码', 'warning');
        return;
      }

      const currentPin = await _showPinInput('输入当前 PIN 码验证');
      if (currentPin === null) return;
      const valid = await CryptoManager.verifyPin(currentPin);
      if (!valid) {
        Utils.showToast('当前 PIN 码不正确', 'error');
        return;
      }

      // 保存当前 PIN 作为主 PIN
      await DB.setSetting('primary_pin_backup', currentPin);

      const tempPin = await _showPinInput('设置临时 PIN 码 (4-6位)');
      if (tempPin === null) return;
      if (tempPin.length < 4 || tempPin.length > 6 || !/^\d+$/.test(tempPin)) {
        Utils.showToast('PIN 码需为 4-6 位数字', 'error');
        return;
      }

      await CryptoManager.changePin(currentPin, tempPin);
      await DB.setSetting('pin_switched', true);
      Utils.showToast('已切换到临时 PIN，重启后生效', 'success');
      render();
    });

    // 自动锁定时间
    document.getElementById('btn-auto-lock').addEventListener('click', async () => {
      const current = await DB.getSetting('autoLockMinutes') || '5';
      const content = document.createElement('div');
      content.innerHTML = `
        <div class="form-group">
          <label class="form-label">自动锁定时间（分钟）</label>
          <select class="form-select" id="auto-lock-select">
            <option value="1" ${current === '1' ? 'selected' : ''}>1 分钟</option>
            <option value="5" ${current === '5' ? 'selected' : ''}>5 分钟</option>
            <option value="10" ${current === '10' ? 'selected' : ''}>10 分钟</option>
            <option value="30" ${current === '30' ? 'selected' : ''}>30 分钟</option>
            <option value="60" ${current === '60' ? 'selected' : ''}>60 分钟</option>
          </select>
        </div>
      `;
      const result = await Utils.showModal('自动锁定', content, [
        { label: '取消', value: false },
        { label: '保存', value: true, primary: true }
      ]);
      if (result) {
        const minutes = document.getElementById('auto-lock-select').value;
        await DB.setSetting('autoLockMinutes', minutes);
        const label = document.getElementById('auto-lock-value');
        if (label) label.textContent = minutes + ' 分钟';
      }
    });

    // 管理计划
    document.getElementById('btn-manage-plans').addEventListener('click', () => {
      App.navigate('followup-plan');
    });

    // 风险规则
    document.getElementById('btn-risk-rules').addEventListener('click', () => {
      App.navigate('risk-config');
    });

    // Import templates
    document.getElementById('btn-import-templates').addEventListener('click', async () => {
      try {
        const response = await fetch('data/questionnaire-templates.json');
        const templates = await response.json();

        let imported = 0;
        let upgraded = 0;
        for (const t of templates) {
          const existing = _templates.find(e => e.id === t.id);
          if (existing) {
            if (t.version > existing.version) {
              await DB.saveTemplate(t);
              upgraded++;
            }
          } else {
            await DB.saveTemplate(t);
            imported++;
          }
        }

        Utils.showToast(`导入完成：新增 ${imported} 个，升级 ${upgraded} 个`, 'success');
        render();
      } catch (err) {
        Utils.showToast('导入失败: ' + err.message, 'error');
      }
    });

    // Notification permission
    document.getElementById('btn-notification').addEventListener('click', () => {
      Reminders.requestNotificationPermission();
      setTimeout(render, 500);
    });

    // Load demo data
    document.getElementById('btn-load-demo').addEventListener('click', async () => {
      const confirm = await Utils.showModal(
        '加载演示数据',
        '<p>将添加 5 位模拟患者及其随访记录，用于体验系统功能。</p>',
        [
          { label: '取消', value: false },
          { label: '加载', value: true, primary: true }
        ]
      );
      if (!confirm) return;
      await _loadDemoData();
      Utils.showToast('演示数据已加载', 'success');
      render();
    });

    // Simulate template upgrade
    document.getElementById('btn-upgrade-template').addEventListener('click', async () => {
      const hypertension = _templates.find(t => t.diseaseType === 'hypertension');
      if (!hypertension) {
        Utils.showToast('请先导入问卷模板', 'warning');
        return;
      }

      const upgraded = {
        ...hypertension,
        version: hypertension.version + 1,
        questions: [
          ...hypertension.questions,
          {
            id: 'sleep_quality',
            text: '近两周睡眠质量',
            type: 'select',
            options: ['很好', '较好', '一般', '较差', '失眠'],
            required: false,
            conditions: null,
            dependsOn: null
          },
          {
            id: 'mental_health',
            text: '情绪状态评估',
            type: 'select',
            options: ['积极乐观', '基本平稳', '偶有焦虑', '持续焦虑', '抑郁倾向'],
            required: false,
            conditions: { field: 'age', 'operator': 'gte', 'value': 50 },
            dependsOn: null
          }
        ]
      };

      await DB.saveTemplate(upgraded);
      Utils.showToast(`高血压问卷已升级到 v${upgraded.version}`, 'success');
      render();
    });
  }

  async function _showPinInput(title) {
    return new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'password';
      input.className = 'form-input';
      input.maxLength = 6;
      input.pattern = '[0-9]*';
      input.inputMode = 'numeric';
      input.style.cssText = 'text-align:center;font-size:24px;letter-spacing:8px;width:200px;margin:0 auto';
      input.placeholder = '····';

      const content = document.createElement('div');
      content.innerHTML = `<div class="form-group" style="text-align:center"><label class="form-label">${title}</label></div>`;
      content.querySelector('.form-group').appendChild(input);

      Utils.showModal(title, content, [
        { label: '取消', value: null },
        { label: '确认', value: true, primary: true }
      ]).then(result => {
        if (result) resolve(input.value);
        else resolve(null);
      });
    });
  }

  async function _loadDemoData() {
    // Import templates first
    try {
      const response = await fetch('data/questionnaire-templates.json');
      const templates = await response.json();
      for (const t of templates) {
        await DB.saveTemplate(t);
      }
    } catch { /* templates may already be loaded */ }

    const demoPatients = [
      {
        name: '张建国', age: 68, gender: 'male', idCard: '310101195601011234',
        phone: '13800138001', address: '幸福村一组 12 号',
        diseases: ['hypertension', 'diabetes'], riskLevel: 'high'
      },
      {
        name: '李秀英', age: 72, gender: 'female', idCard: '310101195203052345',
        phone: '13800138002', address: '和平社区三号楼',
        diseases: ['hypertension'], riskLevel: 'medium'
      },
      {
        name: '王大明', age: 55, gender: 'male', idCard: '310101196908083456',
        phone: '13800138003', address: '建设路 45 号',
        diseases: ['diabetes'], riskLevel: 'medium'
      },
      {
        name: '陈美丽', age: 45, gender: 'female', idCard: '310101197905054567',
        phone: '13800138004', address: '光明村五组',
        diseases: ['hypertension', 'heart_disease'], riskLevel: 'low'
      },
      {
        name: '刘老根', age: 80, gender: 'male', idCard: '310101194401015678',
        phone: '13800138005', address: '长寿路 88 号',
        diseases: ['hypertension', 'diabetes', 'stroke'], riskLevel: 'high'
      }
    ];

    for (const p of demoPatients) {
      p.id = Utils.uuid();
      p.lastVisitDate = Utils.addDays(Utils.today(), -Math.floor(Math.random() * 30));
      p.syncStatus = 'pending';
      await DB.savePatient(p);

      // Create 1-3 past visits
      const visitCount = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < visitCount; i++) {
        const visit = {
          id: Utils.uuid(),
          patientId: p.id,
          date: Utils.addDays(Utils.today(), -(i + 1) * 14 - Math.floor(Math.random() * 5)),
          bpSystolic: 120 + Math.floor(Math.random() * 60),
          bpDiastolic: 70 + Math.floor(Math.random() * 40),
          bloodSugar: parseFloat((4 + Math.random() * 10).toFixed(1)),
          medications: ['阿莫西林 500mg', '二甲双胍 250mg'].slice(0, 1 + Math.floor(Math.random() * 2)),
          questionnaires: [],
          attachments: [],
          riskLevel: ['low', 'medium', 'high'][Math.floor(Math.random() * 3)],
          notes: i === 0 ? '患者精神状态良好' : '',
          isDraft: false,
          syncStatus: i > 0 ? 'synced' : 'pending',
          syncVersion: i > 0 ? 1 : 0
        };
        await DB.saveVisit(visit);
      }
    }
  }

  return { render, loadDemoData: _loadDemoData };
})();
