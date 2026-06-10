export const loading = {
  show(container, message = '加载中...') {
    const el = document.createElement('div');
    el.className = 'empty-state';
    el.innerHTML = `
      <div style="width:36px;height:36px;border:3px solid var(--border);border-top-color:var(--primary);border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 16px;"></div>
      <div class="empty-state__text">${message}</div>
    `;
    container.appendChild(el);
    return el;
  },

  hide(el) {
    if (el) el.remove();
  }
};
