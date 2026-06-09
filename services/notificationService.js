import { Notification } from '../models/appModels.js';
import { sendPushToUsers } from './pushNotificationService.js';

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null)
  );
}

function stringId(value) {
  return value?._id?.toString?.() || value?.toString?.();
}

function uniqueRecipientIds(recipientIds = [], actorId) {
  const actor = stringId(actorId);

  return [...new Set(recipientIds.map(stringId).filter(Boolean))]
    .filter((recipientId) => recipientId !== actor);
}

export async function createAndSendNotifications({
  type,
  recipientIds,
  actorId,
  title,
  message,
  planId,
  friendshipId,
  conversationId,
  messageId,
  data = {},
}) {
  const recipients = uniqueRecipientIds(recipientIds, actorId);

  if (!recipients.length) {
    return {
      notifications: [],
      pushResult: { sentCount: 0, skipped: true },
    };
  }

  const baseNotification = compactObject({
    type,
    actorId,
    planId,
    friendshipId,
    conversationId,
    messageId,
    title,
    message,
    read: false,
  });

  const notifications = await Notification.insertMany(
    recipients.map((recipientId) => ({
      ...baseNotification,
      recipientId,
    }))
  );

  const pushResult = await sendPushToUsers({
    userIds: recipients,
    title,
    body: message,
    data: compactObject({
      type,
      planId: stringId(planId),
      friendshipId: stringId(friendshipId),
      conversationId: stringId(conversationId),
      messageId: stringId(messageId),
      notificationIds: notifications.map((notification) => notification._id.toString()).join(','),
      ...data,
    }),
  });

  console.log('Notification fanout complete', {
    type,
    recipientCount: recipients.length,
    notificationCount: notifications.length,
    pushResult,
  });

  return {
    notifications,
    pushResult,
  };
}
