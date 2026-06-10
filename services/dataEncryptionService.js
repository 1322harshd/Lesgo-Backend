import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from 'node:crypto';

const ENCRYPTION_PREFIX = 'enc:v1';
const KEY_ENV_NAMES = ['DATA_ENCRYPTION_KEY', 'APP_DATA_ENCRYPTION_KEY'];

let cachedKey;
let warnedAboutMissingKey = false;

function getConfiguredKeyMaterial() {
  for (const envName of KEY_ENV_NAMES) {
    const value = process.env[envName]?.trim();

    if (value) {
      return value;
    }
  }

  return '';
}

function decodeKeyMaterial(keyMaterial) {
  const cleanValue = keyMaterial.trim();

  if (cleanValue.startsWith('base64:')) {
    return Buffer.from(cleanValue.slice('base64:'.length), 'base64');
  }

  if (cleanValue.startsWith('hex:')) {
    return Buffer.from(cleanValue.slice('hex:'.length), 'hex');
  }

  if (/^[a-f0-9]{64}$/i.test(cleanValue)) {
    return Buffer.from(cleanValue, 'hex');
  }

  const base64Decoded = Buffer.from(cleanValue, 'base64');

  if (base64Decoded.length === 32) {
    return base64Decoded;
  }

  return createHash('sha256').update(cleanValue).digest();
}

export function getDataEncryptionKey({ required = true } = {}) {
  if (cachedKey) {
    return cachedKey;
  }

  const keyMaterial = getConfiguredKeyMaterial();

  if (!keyMaterial) {
    if (required) {
      throw new Error('DATA_ENCRYPTION_KEY is required to encrypt sensitive data.');
    }

    if (!warnedAboutMissingKey) {
      warnedAboutMissingKey = true;
      console.warn('DATA_ENCRYPTION_KEY is not set. Legacy plaintext sensitive fields can be read, but new sensitive writes will fail.');
    }

    return null;
  }

  const key = decodeKeyMaterial(keyMaterial);

  if (key.length !== 32) {
    throw new Error('DATA_ENCRYPTION_KEY must resolve to 32 bytes.');
  }

  cachedKey = key;
  return cachedKey;
}

export function encryptValue(value) {
  if (value === undefined || value === null) {
    return value;
  }

  const key = getDataEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = JSON.stringify(value);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    ENCRYPTION_PREFIX,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

export function decryptValue(value) {
  if (value === undefined || value === null) {
    return value;
  }

  if (typeof value !== 'string' || !value.startsWith(`${ENCRYPTION_PREFIX}:`)) {
    return value;
  }

  const [, , ivText, tagText, ciphertextText] = value.split(':');

  if (!ivText || !tagText || !ciphertextText) {
    throw new Error('Encrypted value is malformed.');
  }

  const key = getDataEncryptionKey();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, 'base64url')),
    decipher.final(),
  ]).toString('utf8');

  return JSON.parse(plaintext);
}

export function hashLookupValue(value) {
  const text = String(value || '');
  const key = getDataEncryptionKey({ required: false });

  if (!key) {
    return createHash('sha256').update(text).digest('hex');
  }

  return createHmac('sha256', key).update(text).digest('hex');
}

function getDocumentValue(document, field) {
  if (!document) {
    return undefined;
  }

  if (typeof document.get === 'function') {
    return document.get(field);
  }

  return document[field];
}

export function readEncryptedField(document, field, encryptedField = `${field}Encrypted`) {
  const encryptedValue = getDocumentValue(document, encryptedField);

  if (encryptedValue !== undefined && encryptedValue !== null) {
    return decryptValue(encryptedValue);
  }

  return getDocumentValue(document, field);
}

export function hasEncryptedField(document, field, encryptedField = `${field}Encrypted`) {
  const value = readEncryptedField(document, field, encryptedField);
  return value !== undefined && value !== null && value !== '';
}

export function setEncryptedField(document, field, value, encryptedField = `${field}Encrypted`) {
  document.set(encryptedField, encryptValue(value));
  document.set(field, undefined);
}

export function buildEncryptedFieldUpdate(values, fields) {
  const $set = {};
  const $unset = {};

  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(values, field)) {
      continue;
    }

    const value = values[field];
    const encryptedField = `${field}Encrypted`;

    if (value === undefined) {
      continue;
    }

    if (value === null || value === '') {
      $unset[field] = 1;
      $unset[encryptedField] = 1;
      continue;
    }

    $set[encryptedField] = encryptValue(value);
    $unset[field] = 1;
  }

  return { $set, $unset };
}
