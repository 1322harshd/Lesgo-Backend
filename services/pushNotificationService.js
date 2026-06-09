import { FcmToken } from '../models/appModels.js';
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

  const results = await Promise.allSettled(
    tokens.map((tokenDoc) => messaging.send({
      token: tokenDoc.token,
      notification: {
        title,
        body,
      },
      data: stringifyData(data),
    }))
  );

  const invalidTokens = [];
  let sentCount = 0;

  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      sentCount += 1;
      return;
    }

    const errorCode = result.reason?.errorInfo?.code || result.reason?.code;

    if (INVALID_TOKEN_ERRORS.has(errorCode)) {
      invalidTokens.push(tokens[index].token);
    } else {
      console.warn('FCM send failed:', {
        tokenId: tokens[index]._id.toString(),
        errorCode,
        message: result.reason?.message,
      });
    }
  });

  if (invalidTokens.length) {
    await FcmToken.deleteMany({ token: { $in: invalidTokens } });
  }

  return {
    sentCount,
    failedCount: results.length - sentCount,
    removedInvalidTokenCount: invalidTokens.length,
  };
}
