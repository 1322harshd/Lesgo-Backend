import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import { Notification } from '../models/appModels.js';

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
    planId: notification.planId?._id?.toString?.() || notification.planId.toString(),
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

export default router;
