import { FcmToken } from '../models/appModels.js';
import { decryptValue } from './dataEncryptionService.js';
import { getFirebaseMessaging } from './firebaseAdminService.js';

const INVALID_TOKEN_ERRORS = new Set([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
]);

function stringifyData(data = {}) {
  return Object.fromEntries(
    Object.entries(data)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)])
  );
}

function looksLikeTokenHash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function getPushTokenValue(tokenDoc) {
  const encryptedToken = tokenDoc.tokenEncrypted ? decryptValue(tokenDoc.tokenEncrypted) : null;

  if (encryptedToken) {
    return encryptedToken;
  }

  if (!tokenDoc.token || looksLikeTokenHash(tokenDoc.token)) {
    return null;
  }

  return tokenDoc.token;
}

export async function sendPushToUsers({ userIds, title, body, data }) {
  const messaging = getFirebaseMessaging();

  if (!messaging) {
    console.warn('FCM is not configured. Skipping push notification send.');
    return { sentCount: 0, skipped: true };
  }

  const tokens = await FcmToken.find({
    userId: { $in: userIds },
  });

  if (!tokens.length) {
    console.warn('No FCM tokens registered for push recipients.', {
      recipientCount: userIds.length,
      type: data?.type,
    });
    return { sentCount: 0, skipped: false };
  }

  const sendableTokens = tokens
    .map((tokenDoc) => ({
      tokenDoc,
      token: getPushTokenValue(tokenDoc),
    }))
    .filter((entry) => entry.token);

  if (!sendableTokens.length) {
    console.warn('No decryptable FCM tokens registered for push recipients.', {
      recipientCount: userIds.length,
      type: data?.type,
    });
    return { sentCount: 0, skipped: false };
  }

  const results = await Promise.allSettled(
    sendableTokens.map(({ token }) => messaging.send({
      token,
      notification: {
        title,
        body,
      },
      data: stringifyData(data),
    }))
  );

  const invalidTokenIds = [];
  let sentCount = 0;

  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      sentCount += 1;
      return;
    }

    const errorCode = result.reason?.errorInfo?.code || result.reason?.code;

    if (INVALID_TOKEN_ERRORS.has(errorCode)) {
      invalidTokenIds.push(sendableTokens[index].tokenDoc._id);
    } else {
      console.warn('FCM send failed:', {
        tokenId: sendableTokens[index].tokenDoc._id.toString(),
        errorCode,
        message: result.reason?.message,
      });
    }
  });

  if (invalidTokenIds.length) {
    await FcmToken.deleteMany({ _id: { $in: invalidTokenIds } });
  }

  return {
    sentCount,
    failedCount: results.length - sentCount,
    removedInvalidTokenCount: invalidTokenIds.length,
  };
}
