import { cryptoManager } from '../core/crypto.js';
import { db } from '../core/db.js';
import { eventBus } from '../core/event-bus.js';

const LoginView = {
  _container: null,

  render(container) {
    this._container = container;
    const isFirstUse = !localStorage.getItem('medical_followup_salt');

    container.innerHTML = `
      <div class="view-login">
        <div class="view-login__logo">&#127973;</div>
        <div class="view-login__title">${isFirstUse ? '设置访问密码' : '输入访问密码'}</div>
        <div class="view-login__subtitle">${isFirstUse ? '首次使用，请设置6位数字密码保护数据安全' : '请输入密码以解锁本地数据'}</div>
        <div class="view-login__form">
          <div class="view-login__pin-dots" id="pin-dots">
            ${Array(6).fill('<div class="view-login__pin-dot"></div>').join('')}
          </div>
          <input type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6"
            id="pin-input" class="form-input" placeholder="请输入6位数字密码"
            style="text-align:center;font-size:20px;letter-spacing:8px;" autofocus>
          <div id="pin-error" class="form-error" style="text-align:center;margin-top:8px;min-height:20px;"></div>
          ${isFirstUse ? `
            <input type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6"
              id="pin-confirm" class="form-input" placeholder="再次确认密码"
              style="text-align:center;font-size:20px;letter-spacing:8px;margin-top:12px;">
          ` : ''}
          <button class="btn btn--primary btn--block btn--lg" id="pin-submit" style="margin-top:24px;">
            ${isFirstUse ? '设置密码并进入' : '解锁'}
          </button>
        </div>
      </div>
    `;

    this._bindEvents(isFirstUse);
  },

  _bindEvents(isFirstUse) {
    const input = document.getElementById('pin-input');
    const dots = document.querySelectorAll('.view-login__pin-dot');
    const errorEl = document.getElementById('pin-error');
    const submitBtn = document.getElementById('pin-submit');

    input.addEventListener('input', () => {
      const len = input.value.length;
      dots.forEach((dot, i) => dot.classList.toggle('filled', i < len));
      errorEl.textContent = '';
    });

    const handleSubmit = async () => {
      const pin = input.value;
      if (pin.length !== 6 || !/^\d{6}$/.test(pin)) {
        errorEl.textContent = '请输入6位数字密码';
        return;
      }

      if (isFirstUse) {
        const confirm = document.getElementById('pin-confirm');
        if (confirm.value !== pin) {
          errorEl.textContent = '两次密码不一致';
          return;
        }
      }

      submitBtn.disabled = true;
      submitBtn.textContent = '验证中...';

      try {
        const ok = await cryptoManager.verifyPin(pin);
        if (ok) {
          await db.open();
          eventBus.emit('auth:login');
        } else {
          errorEl.textContent = '密码错误，请重试';
          input.value = '';
          dots.forEach(d => d.classList.remove('filled'));
        }
      } catch (e) {
        errorEl.textContent = '系统错误: ' + e.message;
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = isFirstUse ? '设置密码并进入' : '解锁';
      }
    };

    submitBtn.addEventListener('click', handleSubmit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleSubmit(); });
  },

  destroy() {
    this._container = null;
  }
};

export default LoginView;
