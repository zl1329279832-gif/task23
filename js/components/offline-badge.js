import { eventBus } from '../core/event-bus.js';

export function createOfflineBadge() {
  const el = document.createElement('span');
  const update = () => {
    const online = navigator.onLine;
    el.className = `badge ${online ? 'badge--success' : 'badge--danger'}`;
    el.textContent = online ? '在线' : '离线';
  };
  update();
  const unsub1 = eventBus.on('network:online', update);
  const unsub2 = eventBus.on('network:offline', update);
  el._destroy = () => { unsub1(); unsub2(); };
  return el;
}
