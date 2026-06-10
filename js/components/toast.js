const toastContainer = document.getElementById('toast-container');

export const toast = {
  show(message, type = 'info', duration = 3000) {
    const el = document.createElement('div');
    el.style.cssText = `
      padding: 12px 16px; border-radius: 8px; font-size: 14px;
      color: #fff; pointer-events: auto; animation: fadeIn 0.2s ease;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15); display: flex; align-items: center; gap: 8px;
    `;
    const colors = {
      info: '#4285f4', success: '#34a853', warning: '#f9ab00', error: '#ea4335'
    };
    el.style.background = colors[type] || colors.info;

    const icons = { info: '\u2139\uFE0F', success: '\u2705', warning: '\u26A0\uFE0F', error: '\u274C' };
    el.textContent = `${icons[type] || ''} ${message}`;

    if (toastContainer) toastContainer.appendChild(el);

    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.3s';
      setTimeout(() => el.remove(), 300);
    }, duration);

    return el;
  },

  info(msg) { return this.show(msg, 'info'); },
  success(msg) { return this.show(msg, 'success'); },
  warning(msg) { return this.show(msg, 'warning'); },
  error(msg) { return this.show(msg, 'error'); }
};
