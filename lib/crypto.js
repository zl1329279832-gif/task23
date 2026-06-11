// Web Crypto API 封装 - AES-GCM + PBKDF2
const CryptoManager = (() => {
  let _cryptoKey = null;
  const SALT_LENGTH = 16;
  const IV_LENGTH = 12;
  const PBKDF2_ITERATIONS = 100000;

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  function generateSalt() {
    return crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  }

  function generateIV() {
    return crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  }

  async function deriveKey(pin, salt) {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw', encoder.encode(pin), 'PBKDF2', false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function computeHMAC(data) {
    if (!_cryptoKey) throw new Error('加密密钥未初始化');
    const encoder = new TextEncoder();
    const keyData = await crypto.subtle.exportKey('raw', _cryptoKey);
    const hmacKey = await crypto.subtle.importKey(
      'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', hmacKey, encoder.encode(JSON.stringify(data)));
    return arrayBufferToBase64(sig);
  }

  async function verifyHMAC(data, signature) {
    if (!signature) return false;
    const computed = await computeHMAC(data);
    return computed === signature;
  }

  async function init(pin) {
    // Try to load existing salt from settings
    const db = await DB.open();
    let setting = await DB.get(db, 'settings', 'crypto_salt');
    let salt;
    if (setting) {
      salt = new Uint8Array(base64ToArrayBuffer(setting.value));
    } else {
      salt = generateSalt();
      await DB.put(db, 'settings', {
        key: 'crypto_salt',
        value: arrayBufferToBase64(salt.buffer)
      });
    }
    _cryptoKey = await deriveKey(pin, salt);
    // Store PIN verification token
    const verifyToken = await encrypt('__verify__');
    await DB.put(db, 'settings', { key: 'pin_verify', value: verifyToken });
    return true;
  }

  async function verifyPin(pin) {
    const db = await DB.open();
    const saltSetting = await DB.get(db, 'settings', 'crypto_salt');
    if (!saltSetting) return false;
    const salt = new Uint8Array(base64ToArrayBuffer(saltSetting.value));
    _cryptoKey = await deriveKey(pin, salt);
    const verifySetting = await DB.get(db, 'settings', 'pin_verify');
    if (!verifySetting) return true;
    try {
      const decrypted = await decrypt(verifySetting.value);
      return decrypted === '__verify__';
    } catch {
      _cryptoKey = null;
      return false;
    }
  }

  async function changePin(oldPin, newPin) {
    // Decrypt all encrypted data first
    const db = await DB.open();
    const patients = await DB.getAll(db, 'patients');
    const queueItems = await DB.getAll(db, 'sync_queue');
    const attachmentItems = await DB.getAll(db, 'attachment_queue');
    const visits = await DB.getAll(db, 'visits');

    // --- 解密患者敏感字段 ---
    const decryptedPatients = [];
    for (const p of patients) {
      if (p._encrypted_idCard) {
        try { p.idCard = await decrypt(p._encrypted_idCard); } catch { /* keep as is */ }
      }
      decryptedPatients.push(p);
    }

    // --- 解密同步队列 payload（格式：{ _encrypted: "..." }） ---
    const decryptedQueue = [];
    for (const q of queueItems) {
      if (q.payload && q.payload._encrypted) {
        try {
          const decrypted = await decrypt(q.payload._encrypted);
          q._decrypted_payload = decrypted; // 暂存明文，稍后重新加密
        } catch { /* keep as is */ }
      }
      decryptedQueue.push(q);
    }

    // --- 解密附件队列中的数据 ---
    const decryptedAttachments = [];
    for (const a of attachmentItems) {
      if (a.data && typeof a.data === 'string' && a.data.startsWith('ENC:')) {
        try { a.data = await decrypt(a.data); } catch { /* keep */ }
      }
      decryptedAttachments.push(a);
    }

    // --- 解密随访记录中的附件数据 ---
    const decryptedVisits = [];
    for (const v of visits) {
      if (v.attachments && Array.isArray(v.attachments)) {
        for (const att of v.attachments) {
          if (att.data && typeof att.data === 'string' && att.data.startsWith('ENC:')) {
            try { att.data = await decrypt(att.data); } catch { /* keep */ }
          }
        }
      }
      decryptedVisits.push(v);
    }

    // Re-derive key with new PIN
    const newSalt = generateSalt();
    _cryptoKey = await deriveKey(newPin, newSalt);

    // --- 重新加密患者数据 ---
    for (const p of decryptedPatients) {
      if (p.idCard) {
        p._encrypted_idCard = await encrypt(p.idCard);
        delete p.idCard;
      }
      // 重新计算 HMAC（密钥已变）
      p._hmac = await computeHMAC({
        id: p.id, name: p.name, age: p.age, diseases: p.diseases
      });
      await DB.put(db, 'patients', p);
    }

    // --- 重新加密同步队列 payload ---
    for (const q of decryptedQueue) {
      if (q._decrypted_payload) {
        q.payload = { _encrypted: await encrypt(q._decrypted_payload) };
        delete q._decrypted_payload;
      }
      await DB.put(db, 'sync_queue', q);
    }

    // --- 重新加密附件队列数据 ---
    for (const a of decryptedAttachments) {
      // 附件数据通常较大，仅标记已处理
      await DB.put(db, 'attachment_queue', a);
    }

    // --- 重新加密随访记录中的附件 ---
    for (const v of decryptedVisits) {
      if (v.attachments && Array.isArray(v.attachments)) {
        for (const att of v.attachments) {
          if (att.data && !att.data.startsWith('data:') && !att.data.startsWith('mock:')) {
            // 已解密的非 data-URL 数据，无需重新加密（附件数据通常以明文 base64 存储）
          }
        }
        await DB.put(db, 'visits', v);
      }
    }

    // 更新盐值和验证标记
    await DB.put(db, 'settings', {
      key: 'crypto_salt',
      value: arrayBufferToBase64(newSalt.buffer)
    });
    const verifyToken = await encrypt('__verify__');
    await DB.put(db, 'settings', { key: 'pin_verify', value: verifyToken });

    // 记录 PIN 切换事件
    await DB.put(db, 'settings', {
      key: 'pin_last_changed',
      value: new Date().toISOString()
    });

    return true;
  }

  async function encrypt(plaintext) {
    if (!_cryptoKey) throw new Error('加密密钥未初始化');
    const encoder = new TextEncoder();
    const iv = generateIV();
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv },
      _cryptoKey,
      encoder.encode(plaintext)
    );
    // Combine IV + ciphertext
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(encrypted), iv.length);
    return arrayBufferToBase64(combined.buffer);
  }

  async function decrypt(ciphertext) {
    if (!_cryptoKey) throw new Error('加密密钥未初始化');
    const combined = new Uint8Array(base64ToArrayBuffer(ciphertext));
    const iv = combined.slice(0, IV_LENGTH);
    const data = combined.slice(IV_LENGTH);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv },
      _cryptoKey,
      data
    );
    return new TextDecoder().decode(decrypted);
  }

  function isReady() {
    return _cryptoKey !== null;
  }

  return {
    init, verifyPin, changePin, encrypt, decrypt,
    computeHMAC, verifyHMAC, isReady,
    arrayBufferToBase64, base64ToArrayBuffer
  };
})();
