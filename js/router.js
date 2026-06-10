import { eventBus } from './core/event-bus.js';

class Router {
  constructor() {
    this._routes = {};
    this._currentView = null;
    this._container = null;
    this._headerTitle = null;
    this._backBtn = null;
    this._defaultRoute = '/login';
    this._history = [];
  }

  init(container, headerTitle, backBtn) {
    this._container = container;
    this._headerTitle = headerTitle;
    this._backBtn = backBtn;
    window.addEventListener('hashchange', () => this._onHashChange());
    this._onHashChange();
  }

  register(path, viewFactory, options = {}) {
    this._routes[path] = { viewFactory, ...options };
  }

  navigate(path) {
    window.location.hash = path;
  }

  back() {
    if (this._history.length > 1) {
      this._history.pop();
      const prev = this._history[this._history.length - 1];
      window.location.hash = prev;
    }
  }

  _onHashChange() {
    const hash = window.location.hash.slice(1) || this._defaultRoute;
    const { route, params } = this._matchRoute(hash);

    if (!route) {
      this.navigate(this._defaultRoute);
      return;
    }

    if (this._history[this._history.length - 1] !== hash) {
      this._history.push(hash);
    }

    if (this._currentView && this._currentView.destroy) {
      this._currentView.destroy();
    }

    this._container.innerHTML = '';
    const config = this._routes[route];
    this._headerTitle.textContent = config.title || '';
    this._backBtn.classList.toggle('hidden', !config.showBack);

    this._currentView = config.viewFactory();
    this._currentView.render(this._container, params);

    eventBus.emit('route:changed', { route, params, hash });
  }

  _matchRoute(hash) {
    for (const pattern of Object.keys(this._routes)) {
      const params = this._extractParams(pattern, hash);
      if (params !== null) return { route: pattern, params };
    }
    return { route: null, params: {} };
  }

  _extractParams(pattern, hash) {
    const patternParts = pattern.split('/');
    const hashParts = hash.split('/');
    if (patternParts.length !== hashParts.length) return null;
    const params = {};
    for (let i = 0; i < patternParts.length; i++) {
      if (patternParts[i].startsWith(':')) {
        params[patternParts[i].slice(1)] = decodeURIComponent(hashParts[i]);
      } else if (patternParts[i] !== hashParts[i]) {
        return null;
      }
    }
    return params;
  }

  getCurrentRoute() {
    const hash = window.location.hash.slice(1) || this._defaultRoute;
    return this._matchRoute(hash);
  }
}

export const router = new Router();
