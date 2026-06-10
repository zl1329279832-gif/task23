import { CRYPTO } from './config.js';

class CryptoManager {
  constructor() {
    this._encKey = null;
    this._hmacKey = null;
  }

  get isUnlocked() {
    return this._encKey !== null;
  }

  async deriveKeys(pin) {
    const enc = new TextEncoder();
    const pinData = enc.encode(pin);

    let salt = this._loadSalt();
    if (!salt) {
      salt = crypto.getRandomValues(new Uint8Array(CRYPTO.SALT_LENGTH));
      this._saveSalt(salt);
    }

    const keyMaterial = await crypto.subtle.importKey(
      'raw', pinData, 'PBKDF2', false, ['deriveKey']
    );

    this._encKey = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: CRYPTO.PBKDF2_ITERATIONS, hash: 'SHA-256' },
      keyMaterial,
      { name: CRYPTO.ALGO, length: CRYPTO.KEY_LENGTH },
      false,
      ['encrypt', 'decrypt']
    );

    const hmacSalt = new Uint8Array(salt.length);
    salt.forEach((b, i) => hmacSalt[i] = b ^ 0xff);

    this._hmacKey = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: hmacSalt, iterations: CRYPTO.PBKDF2_ITERATIONS, hash: 'SHA-256' },
      keyMaterial,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign', 'verify']
    );
  }

  async encrypt(plainObj) {
    if (!this._encKey) throw new Error('Crypto not unlocked');
    const iv = crypto.getRandomValues(new Uint8Array(CRYPTO.IV_LENGTH));
    const data = new TextEncoder().encode(JSON.stringify(plainObj));
    const ciphertext = await crypto.subtle.encrypt(
      { name: CRYPTO.ALGO, iv },
      this._encKey,
      data
    );
    return {
      iv: Array.from(iv),
      ciphertext: Array.from(new Uint8Array(ciphertext))
    };
  }

  async decrypt(encrypted) {
    if (!this._encKey) throw new Error('Crypto not unlocked');
    const iv = new Uint8Array(encrypted.iv);
    const ciphertext = new Uint8Array(encrypted.ciphertext).buffer;
    const decrypted = await crypto.subtle.decrypt(
      { name: CRYPTO.ALGO, iv },
      this._encKey,
      ciphertext
    );
    const json = new TextDecoder().decode(decrypted);
    return JSON.parse(json);
  }

  async computeChecksum(record) {
    if (!this._hmacKey) throw new Error('Crypto not unlocked');
    const filtered = {};
    for (const [k, v] of Object.entries(record)) {
      if (k !== '_checksum') filtered[k] = v;
    }
    const sortedKeys = Object.keys(filtered).sort();
    const data = new TextEncoder().encode(JSON.stringify(filtered, sortedKeys));
    const sig = await crypto.subtle.sign('HMAC', this._hmacKey, data);
    return this._bufToHex(sig);
  }

  async verifyChecksum(record) {
    if (!record._checksum) return false;
    const computed = await this.computeChecksum(record);
    return computed === record._checksum;
  }

  async verifyPin(pin) {
    try {
      const testKey = 'medical_followup_pin_test';
      const stored = localStorage.getItem(testKey);
      if (!stored) {
        await this.deriveKeys(pin);
        const testData = await this.encrypt({ verify: true, ts: Date.now() });
        localStorage.setItem(testKey, JSON.stringify(testData));
        return true;
      }
      await this.deriveKeys(pin);
      const parsed = JSON.parse(stored);
      const result = await this.decrypt(parsed);
      return result && result.verify === true;
    } catch {
      this._encKey = null;
      this._hmacKey = null;
      return false;
    }
  }

  lock() {
    this._encKey = null;
    this._hmacKey = null;
  }

  _loadSalt() {
    const stored = localStorage.getItem('medical_followup_salt');
    if (!stored) return null;
    return new Uint8Array(JSON.parse(stored));
  }

  _saveSalt(salt) {
    localStorage.setItem('medical_followup_salt', JSON.stringify(Array.from(salt)));
  }

  _bufToHex(buf) {
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
}

export const cryptoManager = new CryptoManager();
