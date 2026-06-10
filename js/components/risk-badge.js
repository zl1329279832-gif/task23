import { RISK_LEVELS } from '../core/config.js';

export function createRiskBadge(level) {
  const info = RISK_LEVELS.find(r => r.level === level) || RISK_LEVELS[0];
  const el = document.createElement('span');
  el.className = 'badge';
  el.style.background = info.color;
  el.style.color = '#fff';
  el.textContent = info.label;
  return el;
}
