// 应用主入口 - 路由、初始化、PIN 锁屏、事件绑定
const App = (() => {
  let _currentView = null;
  let _pinInput = '';
  let _pinMode = 'verify'; // 'verify' | 'setup' | 'confirm'
  let _pinSetupFirst = '';

  const VIEWS = {
    'patient-list': PatientListView,
    'detail': DetailView,
    'questionnaire': QuestionnaireView,
    'record': RecordView,
    'sync-review': SyncReviewView,
    'conflict': ConflictView,
    'export': ExportView,
    'questionnaire-config': QuestionnaireConfigView,
    'followup-plan': FollowupPlanView,
    'risk-config': RiskConfigView
  };

  // --- 初始化 ---
  async function init() {
    _registerServiceWorker();
    _bindGlobalEvents();
    _updateOnlineStatus();

    try {
      await DB.open();
    } catch (err) {
      Utils.showToast('数据库初始化失败: ' + err.message, 'error');
      return;
    }

    // Check if PIN is set up
    const hasPin = await DB.getSetting('pin_verify');
    if (hasPin) {
      _pinMode = 'verify';
      document.getElementById('pin-title').textContent = '输入 PIN 码';
      document.getElementById('pin-subtitle').textContent = '请输入密码以解锁';
    } else {
      _pinMode = 'setup';
      document.getElementById('pin-title').textContent = '设置 PIN 码';
      document.getElementById('pin-subtitle').textContent = '首次使用请设置 4-6 位数字密码';
    }

    _bindPinEvents();
  }

  function _registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js')
        .then(reg => console.log('SW registered'))
        .catch(err => console.warn('SW registration failed:', err));
    }
  }

  // --- 全局事件 ---
  function _bindGlobalEvents() {
    // Bottom nav
    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', () => {
        const view = item.dataset.view;
        if (view) navigate(view);
      });
    });

    // Online/offline
    window.addEventListener('online', _updateOnlineStatus);
    window.addEventListener('offline', _updateOnlineStatus);

    // Sync badge click
    document.getElementById('btn-sync-badge').addEventListener('click', () => {
      navigate('sync-review');
    });

    // Reminder banner dismiss
    document.getElementById('reminder-dismiss').addEventListener('click', () => {
      document.getElementById('reminder-banner').style.display = 'none';
    });

    // Reminder banner click -> show details
    document.getElementById('reminder-text').addEventListener('click', () => {
      const data = document.getElementById('reminder-banner').dataset.reminders;
      if (data) {
        try {
          const reminders = JSON.parse(data);
          _showReminderDetail(reminders);
        } catch { /* ignore */ }
      }
    });
  }

  function _updateOnlineStatus() {
    const btn = document.getElementById('btn-online-status');
    if (navigator.onLine) {
      btn.classList.add('status-online');
      btn.classList.remove('status-offline');
    } else {
      btn.classList.add('status-offline');
      btn.classList.remove('status-online');
    }
  }

  async function _updateSyncBadge() {
    try {
      const queue = await DB.getSyncQueue();
      const count = document.getElementById('sync-count');
      if (queue.length > 0) {
        count.textContent = queue.length;
        count.style.display = 'flex';
      } else {
        count.style.display = 'none';
      }
    } catch { /* db not ready yet */ }
  }

  // --- 路由 ---
  function navigate(viewName, params = {}) {
    _currentView = viewName;

    // Update nav active state
    document.querySelectorAll('.nav-item').forEach(item => {
      item.classList.toggle('active', item.dataset.view === viewName);
    });

    // Find view
    const view = VIEWS[viewName];
    if (!view) {
      console.error('Unknown view:', viewName);
      return;
    }

    // Render
    const loading = document.getElementById('loading-overlay');
    loading.style.display = 'flex';
    document.getElementById('loading-text').textContent = '加载中...';

    Promise.resolve(view.render(params))
      .then(() => {
        loading.style.display = 'none';
        _updateSyncBadge();
      })
      .catch(err => {
        loading.style.display = 'none';
        console.error('View render error:', err);
        Utils.showToast('页面加载失败: ' + err.message, 'error');
      });
  }

  // --- PIN 锁屏 ---
  function _bindPinEvents() {
    const pinScreen = document.getElementById('pin-screen');

    pinScreen.addEventListener('click', e => {
      const key = e.target.closest('.pin-key');
      if (!key) return;

      const value = key.dataset.key;
      if (!value) return;

      if (value === 'del') {
        _pinInput = _pinInput.slice(0, -1);
      } else {
        if (_pinInput.length >= 6) return;
        _pinInput += value;
      }

      _updatePinDots();

      // Auto-submit when length is sufficient
      if (_pinInput.length >= 4) {
        setTimeout(() => _processPin(), 200);
      }
    });
  }

  function _updatePinDots() {
    const dots = document.querySelectorAll('.pin-dot');
    dots.forEach((dot, i) => {
      dot.classList.toggle('filled', i < _pinInput.length);
      dot.classList.remove('error');
    });
  }

  async function _processPin() {
    if (_pinMode === 'setup') {
      if (_pinInput.length < 4) {
        _showPinError('请输入至少 4 位数字');
        return;
      }
      _pinSetupFirst = _pinInput;
      _pinInput = '';
      _pinMode = 'confirm';
      document.getElementById('pin-title').textContent = '确认 PIN 码';
      document.getElementById('pin-subtitle').textContent = '请再次输入以确认';
      _updatePinDots();
    } else if (_pinMode === 'confirm') {
      if (_pinInput !== _pinSetupFirst) {
        _showPinError('两次输入不一致');
        _pinInput = '';
        _pinMode = 'setup';
        document.getElementById('pin-title').textContent = '设置 PIN 码';
        document.getElementById('pin-subtitle').textContent = '请重新输入 4-6 位数字';
        _updatePinDots();
        return;
      }
      // Initialize crypto
      try {
        await CryptoManager.init(_pinInput);
        _unlock();
      } catch (err) {
        _showPinError('初始化失败: ' + err.message);
        _pinInput = '';
        _updatePinDots();
      }
    } else if (_pinMode === 'verify') {
      const valid = await CryptoManager.verifyPin(_pinInput);
      if (valid) {
        _unlock();
      } else {
        _showPinError('PIN 码不正确');
        _pinInput = '';
        _updatePinDots();
      }
    }
  }

  function _showPinError(msg) {
    const errorEl = document.getElementById('pin-error');
    errorEl.textContent = msg;
    document.querySelectorAll('.pin-dot').forEach(dot => dot.classList.add('error'));
    setTimeout(() => {
      errorEl.textContent = '';
      document.querySelectorAll('.pin-dot').forEach(dot => dot.classList.remove('error'));
    }, 2000);
  }

  async function _unlock() {
    const pinScreen = document.getElementById('pin-screen');
    pinScreen.style.opacity = '0';
    pinScreen.style.transition = 'opacity 0.3s';
    setTimeout(() => { pinScreen.style.display = 'none'; }, 300);

    // Load templates
    try {
      const response = await fetch('data/questionnaire-templates.json');
      const templates = await response.json();
      const existing = await DB.getAllTemplates();
      for (const t of templates) {
        const ex = existing.find(e => e.id === t.id);
        if (!ex || ex.version < t.version) {
          await DB.saveTemplate(t);
        }
      }
    } catch { /* offline - templates already in cache/db */ }

    await QuestionnaireEngine.loadTemplates();

    // Start sync
    SyncManager.startAutoSync();

    // Generate/update follow-up plans
    try {
      await FollowupPlan.generateAllPlans();
    } catch (e) { console.warn('Plan generation failed:', e); }

    // Show reminders
    await Reminders.showReminderBanner();
    Reminders.requestNotificationPermission();

    // Navigate to default view
    navigate('patient-list');
    _updateSyncBadge();
  }

  // --- 提醒详情 ---
  async function _showReminderDetail(reminders) {
    const content = document.createElement('div');

    let html = '';
    if (reminders.overdue && reminders.overdue.length > 0) {
      html += '<div style="margin-bottom:16px"><strong style="color:var(--danger)">逾期未访</strong>';
      reminders.overdue.forEach(r => {
        html += `<div style="padding:8px 0;border-bottom:1px solid var(--border-light)">
          <div style="font-weight:500">${Utils.escapeHTML(r.patient.name)}</div>
          <div style="font-size:12px;color:var(--text-secondary)">逾期 ${r.daysOverdue} 天 · ${Utils.escapeHTML(r.reason)}</div>
        </div>`;
      });
      html += '</div>';
    }

    if (reminders.dueToday && reminders.dueToday.length > 0) {
      html += '<div style="margin-bottom:16px"><strong style="color:var(--warning)">今日待访</strong>';
      reminders.dueToday.forEach(r => {
        html += `<div style="padding:8px 0;border-bottom:1px solid var(--border-light)">
          <div style="font-weight:500">${Utils.escapeHTML(r.patient.name)}</div>
          <div style="font-size:12px;color:var(--text-secondary)">${Utils.escapeHTML(r.reason)}</div>
        </div>`;
      });
      html += '</div>';
    }

    if (reminders.upcoming && reminders.upcoming.length > 0) {
      html += '<div><strong style="color:var(--primary)">即将到期</strong>';
      reminders.upcoming.forEach(r => {
        html += `<div style="padding:8px 0;border-bottom:1px solid var(--border-light)">
          <div style="font-weight:500">${Utils.escapeHTML(r.patient.name)}</div>
          <div style="font-size:12px;color:var(--text-secondary)">${Utils.formatDate(r.nextDate)} (${r.daysUntil}天后) · ${Utils.escapeHTML(r.reason)}</div>
        </div>`;
      });
      html += '</div>';
    }

    content.innerHTML = html;

    const result = await Utils.showModal('随访提醒详情', content, [
      { label: '关闭', value: true, primary: true }
    ]);
  }

  // --- 公共 API ---
  return { init, navigate };
})();

// 启动应用
document.addEventListener('DOMContentLoaded', () => {
  App.init();
});
