// Web Crypto API 封装 - AES-GCM + PBKDF2 + HMAC-SHA256
const CryptoManager = (() => {
  let _cryptoKey = null;
  let _hmacKey = null;
  const SALT_LENGTH = 16;
  const IV_LENGTH = 12;
  const PBKDF2_ITERATIONS = 100000;
  const HMAC_SALT_SUFFIX = new Uint8Array([0x48, 0x4D, 0x41, 0x43]); // "HMAC"

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

  // 为 HMAC 派生独立盐值（主盐 + 后缀）
  function deriveHmacSalt(salt) {
    const hmacSalt = new Uint8Array(salt.length + HMAC_SALT_SUFFIX.length);
    hmacSalt.set(salt, 0);
    hmacSalt.set(HMAC_SALT_SUFFIX, salt.length);
    return hmacSalt;
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

  // 派生独立的 HMAC 密钥（使用不同盐，避免从不可导出的 AES 密钥提取）
  async function deriveHmacKey(pin, salt) {
    const encoder = new TextEncoder();
    const hmacSalt = deriveHmacSalt(salt);
    const keyMaterial = await crypto.subtle.importKey(
      'raw', encoder.encode(pin), 'PBKDF2', false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: hmacSalt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      keyMaterial,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign', 'verify']
    );
  }

  async function computeHMAC(data) {
    if (!_hmacKey) throw new Error('HMAC 密钥未初始化');
    const encoder = new TextEncoder();
    const sig = await crypto.subtle.sign('HMAC', _hmacKey, encoder.encode(JSON.stringify(data)));
    return arrayBufferToBase64(sig);
  }

  async function verifyHMAC(data, signature) {
    if (!signature || !_hmacKey) return false;
    const computed = await computeHMAC(data);
    // 时间恒定比较（防止时序攻击）
    if (computed.length !== signature.length) return false;
    let diff = 0;
    for (let i = 0; i < computed.length; i++) {
      diff |= computed.charCodeAt(i) ^ signature.charCodeAt(i);
    }
    return diff === 0;
  }

  async function init(pin) {
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
    _hmacKey = await deriveHmacKey(pin, salt);
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
    _hmacKey = await deriveHmacKey(pin, salt);
    const verifySetting = await DB.get(db, 'settings', 'pin_verify');
    if (!verifySetting) return true;
    try {
      const decrypted = await decrypt(verifySetting.value);
      return decrypted === '__verify__';
    } catch {
      _cryptoKey = null;
      _hmacKey = null;
      return false;
    }
  }

  async function changePin(oldPin, newPin) {
    const db = await DB.open();
    const patients = await DB.getAll(db, 'patients');
    const queueItems = await DB.getAll(db, 'sync_queue');

    const decryptedPatients = [];
    for (const p of patients) {
      if (p._encrypted_idCard) {
        try { p.idCard = await decrypt(p._encrypted_idCard); } catch { /* keep as is */ }
      }
      decryptedPatients.push(p);
    }

    const decryptedQueue = [];
    for (const q of queueItems) {
      if (q._encrypted_payload) {
        try { q.payload = await decrypt(q._encrypted_payload); } catch { /* keep as is */ }
      }
      decryptedQueue.push(q);
    }

    // Re-derive both keys with new PIN
    const newSalt = generateSalt();
    _cryptoKey = await deriveKey(newPin, newSalt);
    _hmacKey = await deriveHmacKey(newPin, newSalt);

    // Re-encrypt everything and recompute HMACs
    for (const p of decryptedPatients) {
      if (p.idCard) {
        p._encrypted_idCard = await encrypt(p.idCard);
        delete p.idCard;
      }
      p._hmac = await computeHMAC({
        id: p.id, name: p.name, age: p.age, diseases: p.diseases
      });
      await DB.put(db, 'patients', p);
    }
    for (const q of decryptedQueue) {
      if (typeof q.payload === 'string' && q.payload.length > 0) {
        q._encrypted_payload = await encrypt(q.payload);
        delete q.payload;
      }
      await DB.put(db, 'sync_queue', q);
    }

    await DB.put(db, 'settings', {
      key: 'crypto_salt',
      value: arrayBufferToBase64(newSalt.buffer)
    });
    const verifyToken = await encrypt('__verify__');
    await DB.put(db, 'settings', { key: 'pin_verify', value: verifyToken });
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
    return _cryptoKey !== null && _hmacKey !== null;
  }

  return {
    init, verifyPin, changePin, encrypt, decrypt,
    computeHMAC, verifyHMAC, isReady,
    arrayBufferToBase64, base64ToArrayBuffer
  };
})();
