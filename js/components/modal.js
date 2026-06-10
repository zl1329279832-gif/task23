const modalContainer = document.getElementById('modal-container');

export const modal = {
  show({ title, content, buttons = [], closable = true }) {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed; inset: 0; background: rgba(0,0,0,0.5);
      display: flex; align-items: center; justify-content: center;
      z-index: 1000; padding: 16px;
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: #fff; border-radius: 12px; width: 100%; max-width: 360px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.2); animation: fadeIn 0.2s ease;
    `;

    let html = '';
    if (title) html += `<div style="padding:16px 16px 8px;font-size:18px;font-weight:600;">${title}</div>`;
    if (content) html += `<div style="padding:8px 16px 16px;font-size:14px;color:#5f6368;line-height:1.6;">${content}</div>`;

    if (buttons.length > 0) {
      html += '<div style="display:flex;border-top:1px solid #dadce0;">';
      buttons.forEach((btn, i) => {
        const borderLeft = i > 0 ? 'border-left:1px solid #dadce0;' : '';
        const color = btn.type === 'danger' ? '#ea4335' : btn.type === 'primary' ? '#1a73e8' : '#5f6368';
        html += `<button data-idx="${i}" style="flex:1;padding:14px;font-size:15px;font-weight:500;cursor:pointer;background:none;border:none;color:${color};${borderLeft}">${btn.label}</button>`;
      });
      html += '</div>';
    }

    dialog.innerHTML = html;

    dialog.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-idx]');
      if (btn) {
        const idx = parseInt(btn.dataset.idx);
        if (buttons[idx] && buttons[idx].action) buttons[idx].action();
        overlay.remove();
      }
    });

    if (closable) {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
      });
    }

    overlay.appendChild(dialog);
    (modalContainer || document.body).appendChild(overlay);

    return { close: () => overlay.remove() };
  },

  confirm(title, content) {
    return new Promise(resolve => {
      this.show({
        title,
        content,
        buttons: [
          { label: '取消', action: () => resolve(false) },
          { label: '确定', type: 'primary', action: () => resolve(true) }
        ]
      });
    });
  },

  alert(title, content) {
    return new Promise(resolve => {
      this.show({
        title,
        content,
        buttons: [{ label: '确定', type: 'primary', action: () => resolve() }]
      });
    });
  }
};
