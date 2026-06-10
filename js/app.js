import { router } from './router.js';
import { eventBus } from './core/event-bus.js';
import { APP_NAME } from './core/config.js';

class App {
  constructor() {
    this._navEl = document.getElementById('app-nav');
    this._mainEl = document.getElementById('main-content');
    this._headerTitle = document.getElementById('header-title');
    this._backBtn = document.getElementById('header-back');
    this._isLoggedIn = false;
  }

  async init() {
    this._registerRoutes();
    this._bindEvents();
    router.init(this._mainEl, this._headerTitle, this._backBtn);
    this._updateOnlineStatus();
    this._registerServiceWorker();
  }

  _registerRoutes() {
    router.register('/login', () => import('./views/login.js').then(m => m.default), {
      title: APP_NAME, showBack: false
    });
    router.register('/patients', () => import('./views/patient-list.js').then(m => m.default), {
      title: '患者列表', showBack: false
    });
    router.register('/patient/:id', () => import('./views/patient-detail.js').then(m => m.default), {
      title: '患者详情', showBack: true
    });
    router.register('/followup/:patientId', () => import('./views/followup-form.js').then(m => m.default), {
      title: '随访记录', showBack: true
    });
    router.register('/followup/:patientId/:followupId', () => import('./views/followup-form.js').then(m => m.default), {
      title: '随访记录', showBack: true
    });
    router.register('/questionnaire/:followupId', () => import('./views/questionnaire-view.js').then(m => m.default), {
      title: '随访问卷', showBack: true
    });
    router.register('/vitals/:followupId', () => import('./views/vital-signs-form.js').then(m => m.default), {
      title: '体征记录', showBack: true
    });
    router.register('/photos/:followupId', () => import('./views/photo-capture.js').then(m => m.default), {
      title: '拍照附件', showBack: true
    });
    router.register('/reminders', () => import('./views/reminders-view.js').then(m => m.default), {
      title: '复诊提醒', showBack: false
    });
    router.register('/sync', () => import('./views/sync-status.js').then(m => m.default), {
      title: '数据同步', showBack: false
    });
    router.register('/conflict/:recordId', () => import('./views/conflict-resolver.js').then(m => m.default), {
      title: '冲突合并', showBack: true
    });
    router.register('/export', () => import('./views/export-view.js').then(m => m.default), {
      title: '数据管理', showBack: false
    });
  }

  _bindEvents() {
    this._backBtn.addEventListener('click', () => router.back());

    this._navEl.addEventListener('click', (e) => {
      const item = e.target.closest('.app-nav__item');
      if (!item) return;
      const route = item.dataset.route;
      if (route) router.navigate(route);
    });

    eventBus.on('route:changed', ({ hash }) => {
      const navItems = this._navEl.querySelectorAll('.app-nav__item');
      navItems.forEach(item => {
        const route = item.dataset.route;
        item.classList.toggle('active', hash.startsWith(route));
      });

      const hideNav = hash.startsWith('/login');
      this._navEl.style.display = hideNav ? 'none' : '';
    });

    eventBus.on('auth:login', async () => {
      this._isLoggedIn = true;
      try {
        const { seedData } = await import('./seed-data.js');
        const seeded = await seedData();
        if (seeded) console.log('Sample data loaded');
      } catch (e) {
        console.warn('Seed data load skipped:', e);
      }
      router.navigate('/patients');
    });

    eventBus.on('auth:logout', () => {
      this._isLoggedIn = false;
      router.navigate('/login');
    });

    window.addEventListener('online', () => {
      this._updateOnlineStatus();
      eventBus.emit('network:online');
    });
    window.addEventListener('offline', () => {
      this._updateOnlineStatus();
      eventBus.emit('network:offline');
    });
  }

  _updateOnlineStatus() {
    const el = document.getElementById('offline-indicator');
    if (!el) return;
    const online = navigator.onLine;
    el.innerHTML = `<span class="badge ${online ? 'badge--success' : 'badge--danger'}">${online ? '在线' : '离线'}</span>`;
  }

  async _registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      try {
        await navigator.serviceWorker.register('./sw.js');
      } catch (e) {
        console.warn('SW registration failed:', e);
      }
    }
  }
}

// Due to dynamic imports, we need to handle route viewFactory as async
const originalRegister = router.register.bind(router);
router.register = function(path, asyncViewFactory, options) {
  originalRegister(path, () => {
    let view = null;
    return {
      async render(container, params) {
        const module = await asyncViewFactory();
        view = typeof module === 'function' ? new module() : module;
        if (view.render) view.render(container, params);
      },
      destroy() {
        if (view && view.destroy) view.destroy();
        view = null;
      }
    };
  }, options);
};

const app = new App();
app.init().catch(console.error);
