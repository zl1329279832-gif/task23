// 通用工具函数
const Utils = (() => {
  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function now() {
    return new Date().toISOString();
  }

  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  function formatDate(isoStr) {
    if (!isoStr) return '-';
    const d = new Date(isoStr);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function formatDateTime(isoStr) {
    if (!isoStr) return '-';
    const d = new Date(isoStr);
    return `${formatDate(isoStr)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function daysBetween(date1, date2) {
    const d1 = new Date(date1);
    const d2 = new Date(date2);
    return Math.floor((d2 - d1) / (1000 * 60 * 60 * 24));
  }

  function addDays(dateStr, days) {
    const d = new Date(dateStr);
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }

  function riskColor(level) {
    const colors = { high: '#e53935', medium: '#fb8c00', low: '#43a047', none: '#9e9e9e' };
    return colors[level] || colors.none;
  }

  function riskLabel(level) {
    const labels = { high: '高风险', medium: '中风险', low: '低风险', none: '未评估' };
    return labels[level] || labels.none;
  }

  function diseaseLabel(code) {
    const map = {
      hypertension: '高血压',
      diabetes: '糖尿病',
      copd: '慢阻肺',
      heart_disease: '冠心病',
      stroke: '脑卒中',
      mental_illness: '严重精神障碍',
      tuberculosis: '肺结核'
    };
    return map[code] || code;
  }

  function debounce(fn, delay) {
    let timer = null;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  function escapeHTML(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function showToast(message, type = 'info', duration = 3000) {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.className = 'toast-container';
      document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('toast-show'));
    setTimeout(() => {
      toast.classList.remove('toast-show');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  function showModal(title, content, actions = []) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      const modal = document.createElement('div');
      modal.className = 'modal';
      const header = document.createElement('div');
      header.className = 'modal-header';
      header.textContent = title;
      const body = document.createElement('div');
      body.className = 'modal-body';
      if (typeof content === 'string') body.innerHTML = content;
      else body.appendChild(content);
      const footer = document.createElement('div');
      footer.className = 'modal-footer';
      if (actions.length === 0) {
        actions = [{ label: '确定', value: true, primary: true }];
      }
      actions.forEach(action => {
        const btn = document.createElement('button');
        btn.className = `btn ${action.primary ? 'btn-primary' : 'btn-secondary'}`;
        btn.textContent = action.label;
        btn.onclick = () => {
          overlay.remove();
          if (action.callback) action.callback();
          resolve(action.value);
        };
        footer.appendChild(btn);
      });
      modal.appendChild(header);
      modal.appendChild(body);
      modal.appendChild(footer);
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add('modal-show'));
    });
  }

  function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function bytesToSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  return {
    uuid, now, today, formatDate, formatDateTime, daysBetween, addDays,
    riskColor, riskLabel, diseaseLabel, debounce, escapeHTML,
    showToast, showModal, downloadFile, bytesToSize
  };
})();
