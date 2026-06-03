import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import {
  acceptPlanInvite,
  cancelPlan,
  createPlan,
  getAcceptedFriends,
  getPlanInvites,
  getUserPlans,
  suggestHangout,
} from '../services/suggestionsService.js';

const router = express.Router();

//using protect function to allow only authenticated users to access
router.use(protect);

//route to get current users accepted friends
router.get('/friends', async (req, res) => {
  try {
    console.log('GET /suggestions/friends', { userId: req.user.userId });

    const friends = await getAcceptedFriends(req.user.userId);

    res.json({ friends });
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
});

/*This is main suggestion engine
- validates request body
- loads accepted friends and their information
- gets busy slots from user calendars
- gets place suggestions
- finds common free slots between group of users
 */
router.post('/hangout', async (req, res) => {
  try {
    console.log('POST /suggestions/hangout', {
      userId: req.user.userId,
      participantCount: Array.isArray(req.body.participantIds) ? req.body.participantIds.length : 0,
      activityType: req.body.activityType,
    });

    const result = await suggestHangout(req.user.userId, req.body);

    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
});

//route used create new plan in database from confirmed suggestions
router.post('/plans', async (req, res) => {
  try {
    console.log('POST /suggestions/plans', {
      userId: req.user.userId,
      participantCount: Array.isArray(req.body.participantIds) ? req.body.participantIds.length : 0,
      title: req.body.title,
    });

    const result = await createPlan(req.user.userId, req.body);

    res.status(201).json(result);
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
});

//route to fetch plans where current user is invited but not accepted the invitation yet for notifications
router.get('/plan-invites', async (req, res) => {
  try {
    console.log('GET /suggestions/plan-invites', { userId: req.user.userId });

    const invites = await getPlanInvites(req.user.userId);

    res.json({ invites });
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
});

//route to accept plan invitation and create separate group conversation if plan accepted
router.post('/plans/:id/accept', async (req, res) => {
  try {
    console.log('POST /suggestions/plans/:id/accept', {
      userId: req.user.userId,
      planId: req.params.id,
    });

    const result = await acceptPlanInvite(req.user.userId, req.params.id);

    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
});

async function cancelPlan(req, res) {
  try {
    console.log(`${req.method} /suggestions/plans/:id/cancel`, {
      userId: req.user.userId,
      planId: req.params.id,
    });

    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Plan not found.' });
    }

    const cancellingUserId = toObjectId(req.user.userId);
    const plan = await Plan.findById(req.params.id);

    if (!plan) {
      return res.status(404).json({ message: 'Plan not found.' });
    }

    const involvedUserIds = uniqueIds([
      plan.creatorId,
      ...plan.participantIds,
      ...plan.invitedParticipantIds,
      ...plan.acceptedParticipantIds,
    ]);
    const isAllowedToCancel = involvedUserIds.includes(req.user.userId);

    if (!isAllowedToCancel) {
      return res.status(403).json({ message: 'You are not allowed to cancel this plan.' });
    }

    if (plan.status === 'cancelled') {
      return res.status(409).json({ message: 'Plan is already cancelled.' });
    }

    const cancellingUser = await User.findById(cancellingUserId);
    const cancellingUserName = cancellingUser?.name || 'Someone';
    const notifiedUserIds = involvedUserIds.filter((userId) => userId !== req.user.userId);

    plan.status = 'cancelled';
    plan.cancelledBy = cancellingUserId;
    plan.cancelledAt = new Date();
    await plan.save();

    if (plan.conversationId) {
      await Message.create({
        conversationId: plan.conversationId,
        senderId: cancellingUserId,
        type: 'system',
        planId: plan._id,
        content: `Plan cancelled by ${cancellingUserName}`,
        readBy: [req.user.userId],
      });
      await Conversation.findByIdAndUpdate(plan.conversationId, { $set: { updatedAt: new Date() } });
    }

    if (notifiedUserIds.length) {
      await Notification.insertMany(
        notifiedUserIds.map((recipientId) => ({
          type: 'plan_cancelled',
          recipientId,
          actorId: cancellingUserId,
          planId: plan._id,
          title: 'Plan cancelled',
          message: `${cancellingUserName} cancelled ${plan.title}`,
          read: false,
        }))
      );
    }

    res.json({
      message: 'Plan cancelled',
      planId: plan._id.toString(),
      cancelledBy: {
        id: req.user.userId,
        name: cancellingUserName,
      },
      notifiedCount: notifiedUserIds.length,
    });
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
}

router.post('/plans/:id/cancel', cancelPlan);
router.patch('/plans/:id/cancel', cancelPlan);
router.delete('/plans/:id', cancelPlan);


//route for getting all the plan in which current user is participant
router.get('/plans', async (req, res) => {
  try {
    console.log('GET /suggestions/plans', { userId: req.user.userId });

    const plans = await getUserPlans(req.user.userId);

    res.json({ plans });
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
});

//route for canceling plan
router.patch('/plans/:id/cancel', async (req, res) => {
  try {
    console.log('PATCH /suggestions/plans/:id/cancel', {
      userId: req.user.userId,
      planId: req.params.id,
    });

    const plan = await cancelPlan(req.user.userId, req.params.id);

    res.json({ plan });
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
});


//route for canceling plan
router.patch('/plans/:id/cancel', async (req, res) => {
  try {
    console.log('PATCH /suggestions/plans/:id/cancel', {
      userId: req.user.userId,
      planId: req.params.id,
    });

    const plan = await cancelPlan(req.user.userId, req.params.id);

    res.json({ plan });
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
});

export default router;
