import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import { FcmToken, Notification } from '../models/appModels.js';
import { encryptValue, hashLookupValue } from '../services/dataEncryptionService.js';

const router = express.Router();

router.use(protect);

function userSummary(user) {
  if (!user) {
    return null;
  }

  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    profilePicture: user.profilePicture,
  };
}

function notificationSummary(notification) {
  return {
    id: notification._id.toString(),
    type: notification.type,
    recipientId: notification.recipientId.toString(),
    actor: userSummary(notification.actorId),
    actorId: notification.actorId?._id?.toString?.() || notification.actorId.toString(),
    planId: notification.planId?._id?.toString?.() || notification.planId?.toString?.(),
    friendshipId: notification.friendshipId?._id?.toString?.() || notification.friendshipId?.toString?.(),
    conversationId: notification.conversationId?._id?.toString?.() || notification.conversationId?.toString?.(),
    messageId: notification.messageId?._id?.toString?.() || notification.messageId?.toString?.(),
    title: notification.title,
    message: notification.message,
    read: notification.read,
    createdAt: notification.createdAt,
  };
}

router.get('/', async (req, res) => {
  try {
    console.log('GET /notifications', { userId: req.user.userId });

    const notifications = await Notification.find({
      recipientId: req.user.userId,
    })
      .populate('actorId')
      .sort({ createdAt: -1 })
      .limit(50);

    res.json({ notifications: notifications.map(notificationSummary) });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.post('/fcm-token', async (req, res) => {
  try {
    const token = String(req.body.token || '').trim();
    const platform = ['ios', 'android', 'web'].includes(req.body.platform)
      ? req.body.platform
      : 'unknown';
    const deviceId = req.body.deviceId ? String(req.body.deviceId).trim() : undefined;

    if (!token) {
      return res.status(400).json({ message: 'FCM token is required.' });
    }

    console.log('POST /notifications/fcm-token', {
      userId: req.user.userId,
      platform,
      hasDeviceId: Boolean(deviceId),
    });

    const tokenHash = hashLookupValue(token);
    let tokenDoc = await FcmToken.findOne({
      $or: [
        { tokenHash },
        { token },
      ],
    });

    if (!tokenDoc) {
      tokenDoc = new FcmToken();
    }

    tokenDoc.userId = req.user.userId;
    tokenDoc.token = tokenHash;
    tokenDoc.tokenHash = tokenHash;
    tokenDoc.tokenEncrypted = encryptValue(token);
    tokenDoc.platform = platform;
    tokenDoc.deviceId = deviceId;
    tokenDoc.lastSeenAt = new Date();
    await tokenDoc.save();

    res.status(201).json({
      fcmToken: {
        id: tokenDoc._id.toString(),
        platform: tokenDoc.platform,
        deviceId: tokenDoc.deviceId,
        lastSeenAt: tokenDoc.lastSeenAt,
      },
    });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.delete('/fcm-token', async (req, res) => {
  try {
    const token = String(req.body.token || '').trim();

    if (!token) {
      return res.status(400).json({ message: 'FCM token is required.' });
    }

    const tokenHash = hashLookupValue(token);

    await FcmToken.deleteOne({
      userId: req.user.userId,
      $or: [
        { tokenHash },
        { token },
      ],
    });

    res.status(204).send();
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    console.log('DELETE /notifications/:id', {
      userId: req.user.userId,
      notificationId: req.params.id,
    });

    const result = await Notification.deleteOne({
      _id: req.params.id,
      recipientId: req.user.userId,
    });

    if (!result.deletedCount) {
      return res.status(404).json({ message: 'Notification not found.' });
    }

    res.status(204).send();
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

export default router;
