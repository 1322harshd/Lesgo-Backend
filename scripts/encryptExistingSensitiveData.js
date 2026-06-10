import 'dotenv/config';
import mongoose from 'mongoose';
import { FcmToken, User } from '../models/appModels.js';
import {
  encryptValue,
  hashLookupValue,
  readEncryptedField,
  setEncryptedField,
} from '../services/dataEncryptionService.js';
import { ENCRYPTED_USER_FIELDS } from '../services/userPrivacyService.js';

function hasLegacyPlaintext(document, field) {
  return document[field] !== undefined &&
    document[field] !== null &&
    document[field] !== '' &&
    !document[`${field}Encrypted`];
}

function looksLikeTokenHash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

async function migrateUsers() {
  const users = await User.find({
    $or: ENCRYPTED_USER_FIELDS.map((field) => ({
      [field]: { $exists: true, $nin: [null, ''] },
    })),
  });
  let migratedCount = 0;

  for (const user of users) {
    let changed = false;

    for (const field of ENCRYPTED_USER_FIELDS) {
      if (!hasLegacyPlaintext(user, field)) {
        continue;
      }

      setEncryptedField(user, field, user[field]);
      changed = true;
    }

    if (changed) {
      await user.save();
      migratedCount += 1;
    }
  }

  return migratedCount;
}

async function migrateFcmTokens() {
  const tokenDocs = await FcmToken.find({
    $or: [
      { token: { $exists: true, $nin: [null, ''] } },
      { tokenEncrypted: { $exists: true, $nin: [null, ''] } },
    ],
  });
  let migratedCount = 0;
  let skippedHashOnlyCount = 0;

  for (const tokenDoc of tokenDocs) {
    const token = tokenDoc.tokenEncrypted
      ? readEncryptedField(tokenDoc, 'token', 'tokenEncrypted')
      : tokenDoc.token;

    if (!token || looksLikeTokenHash(token)) {
      skippedHashOnlyCount += 1;
      continue;
    }

    const tokenHash = hashLookupValue(token);

    tokenDoc.token = tokenHash;
    tokenDoc.tokenHash = tokenHash;
    tokenDoc.tokenEncrypted = tokenDoc.tokenEncrypted || encryptValue(token);
    await tokenDoc.save();
    migratedCount += 1;
  }

  return { migratedCount, skippedHashOnlyCount };
}

async function run() {
  if (!process.env.MONGO_DB_URI) {
    throw new Error('MONGO_DB_URI is required.');
  }

  await mongoose.connect(process.env.MONGO_DB_URI);

  try {
    const userCount = await migrateUsers();
    const fcmResult = await migrateFcmTokens();

    console.log('Sensitive data encryption migration complete.', {
      migratedUsers: userCount,
      migratedFcmTokens: fcmResult.migratedCount,
      skippedHashOnlyFcmTokens: fcmResult.skippedHashOnlyCount,
    });
  } finally {
    await mongoose.disconnect();
  }
}

run().catch(async (error) => {
  console.error('Sensitive data encryption migration failed:', error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
