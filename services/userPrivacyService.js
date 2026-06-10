import {
  buildEncryptedFieldUpdate,
  hasEncryptedField,
  readEncryptedField,
} from './dataEncryptionService.js';

export const ENCRYPTED_USER_FIELDS = [
  'contactNumber',
  'homeArea',
  'homeLat',
  'homeLng',
  'googleAccessToken',
  'googleRefreshToken',
];

export function splitUserPrivacyFields(values) {
  const publicValues = {};
  const privateValues = {};

  for (const [key, value] of Object.entries(values)) {
    if (ENCRYPTED_USER_FIELDS.includes(key)) {
      privateValues[key] = value;
    } else {
      publicValues[key] = value;
    }
  }

  return {
    publicValues,
    privateUpdate: buildEncryptedFieldUpdate(privateValues, ENCRYPTED_USER_FIELDS),
  };
}

export function applyMongoUpdatePart(target, operator, values) {
  if (Object.keys(values).length) {
    target[operator] = {
      ...(target[operator] || {}),
      ...values,
    };
  }
}

export function buildUserUpdateDocument(values) {
  const { publicValues, privateUpdate } = splitUserPrivacyFields(values);
  const update = {};

  applyMongoUpdatePart(update, '$set', {
    ...publicValues,
    ...privateUpdate.$set,
  });
  applyMongoUpdatePart(update, '$unset', privateUpdate.$unset);

  return update;
}

export function buildUserCreateDocument(values) {
  const { publicValues, privateUpdate } = splitUserPrivacyFields(values);

  return {
    ...publicValues,
    ...privateUpdate.$set,
  };
}

export function getUserPrivateField(user, field) {
  return readEncryptedField(user, field);
}

export function hasUserPrivateField(user, field) {
  return hasEncryptedField(user, field);
}
