import express from 'express';
import mongoose from 'mongoose';
import { protect } from '../middleware/authMiddleware.js';
import { Conversation, Friendship, Message, User } from '../models/appModels.js';
import { createAndSendNotifications } from '../services/notificationService.js';

const router = express.Router();

//using protect middleware to ensure all routes require authentication
router.use(protect);

//prevents error from invalid id's
function toObjectId(id) {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return null;
  }

  return new mongoose.Types.ObjectId(id);
}

//helper function to pick only safe fields to send to the frontend
function userSummary(user) {
  if (!user) {
    return null;
  }

  return {
    id: user._id.toString(),
    googleId: user.googleId,
    friendCode: user.friendCode,
    name: user.name,
    email: user.email,
    profilePicture: user.profilePicture,
  };
}

//helper functionn for shaping friendship document for frontend
function friendshipSummary(friendship, currentUserId) {
  const requester = userSummary(friendship.requesterId);
  const receiver = userSummary(friendship.receiverId);
  const friend = requester?.id === currentUserId ? receiver : requester;

  return {
    id: friendship._id.toString(),
    status: friendship.status,
    blockedBy: friendship.blockedBy?.toString?.() || null,
    blockedAt: friendship.blockedAt,
    createdAt: friendship.createdAt,
    requester,
    receiver,
    friend,
  };
}

//helper function for shaping message document for frontend converting MongoDB ObjectId into string which can be used by frontend
function messageSummary(message) {
  const sender = typeof message.senderId === 'object' && message.senderId?.name
    ? userSummary(message.senderId)
    : null;

  return {
    id: message._id.toString(),
    conversationId: message.conversationId.toString(),
    senderId: sender?.id || message.senderId?.toString() || null,
    sender,
    senderName: sender?.name || null,
    type: message.type,
    planId: message.planId?.toString() || null,
    content: message.content,
    readBy: message.readBy.map((id) => id.toString()),
    createdAt: message.createdAt,
  };
}

//helper functionf for shaping conversation document for frontend
function conversationSummary(conversation) {
  return {
    id: conversation._id.toString(),
    title: conversation.title,
    type: conversation.type,
    participants: conversation.participants.map(userSummary).filter(Boolean),
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}

function previewText(value, maxLength = 120) {
  const text = String(value || '').trim();

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 3)}...`;
}

function idString(value) {
  return value?._id?.toString?.() || value?.toString?.() || '';
}

//helper function for looking up friendship between two people
async function findFriendship(userId, otherUserId, status) {
  const query = {
    $or: [
      { requesterId: userId, receiverId: otherUserId },
      { requesterId: otherUserId, receiverId: userId },
    ],
  };

  if (status) {
    query.status = status;
  }

  return Friendship.findOne(query);
}

//security check to ensure current user is actually a participant in that conversation
async function ensureConversationParticipant(conversationId, userId) {
  const conversation = await Conversation.findOne({
    _id: conversationId,
    participants: userId,
  });

  if (!conversation) {
    return null;
  }

  return conversation;
}

function getOtherParticipantId(conversation, userId) {
  if (conversation.type !== 'direct') {
    return null;
  }

  return conversation.participants.find((participant) => idString(participant) !== userId.toString()) ?? null;
}

async function ensureDirectConversationNotBlocked(conversation, userId) {
  const otherParticipantId = getOtherParticipantId(conversation, userId);

  if (!otherParticipantId) {
    return true;
  }

  const friendship = await findFriendship(toObjectId(userId), toObjectId(idString(otherParticipantId)));
  return friendship?.status === 'accepted';
}

//route for looking a user from their friend code
router.get('/lookup/:friendCode', async (req, res) => {
  try {
    const friendCode = req.params.friendCode.trim().toUpperCase();
    const user = await User.findOne({ friendCode });

    if (!user) {
      return res.status(404).json({ message: 'No user found with that friend code.' });
    }

    if (user._id.toString() === req.user.userId) {
      return res.status(400).json({ message: 'That is your own friend code.' });
    }

    res.json({ user: userSummary(user) });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

//route for checking friendship status and adding friend
router.post('/friends/request', async (req, res) => {
  try {
    const friendCode = String(req.body.friendCode || '').trim().toUpperCase();

    if (!friendCode) {
      return res.status(400).json({ message: 'Friend code is required.' });
    }

    const receiver = await User.findOne({ friendCode });

    if (!receiver) {
      return res.status(404).json({ message: 'No user found with that friend code.' });
    }

    if (receiver._id.toString() === req.user.userId) {
      return res.status(400).json({ message: 'You cannot add yourself.' });
    }

    const currentUserId = toObjectId(req.user.userId);
    const existingFriendship = await Friendship.findOne({
      $or: [
        { requesterId: currentUserId, receiverId: receiver._id },
        { requesterId: receiver._id, receiverId: currentUserId },
      ],
    });

    if (existingFriendship) {
      const messages = {
        pending: 'A friend request is already pending.',
        accepted: 'You are already friends.',
        blocked: 'This friend connection is blocked.',
      };

      return res.status(existingFriendship.status === 'blocked' ? 403 : 409).json({
        message: messages[existingFriendship.status] || 'Friend request already exists.',
      });
    }

    const friendship = await Friendship.create({
      requesterId: currentUserId,
      receiverId: receiver._id,
      status: 'pending',
    });

    const populatedFriendship = await friendship.populate(['requesterId', 'receiverId']);
    await createAndSendNotifications({
      type: 'friend_request',
      recipientIds: [receiver._id],
      actorId: currentUserId,
      friendshipId: friendship._id,
      title: 'New friend request',
      message: `${populatedFriendship.requesterId.name} sent you a friend request`,
    });

    res.status(201).json({ friendship: friendshipSummary(populatedFriendship, req.user.userId) });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

//route for checking all existing friendships and gives it back in response
router.get('/friends', async (req, res) => {
  try {
    const currentUserId = toObjectId(req.user.userId);
    const friendships = await Friendship.find({
      status: 'accepted',
      $or: [{ requesterId: currentUserId }, { receiverId: currentUserId }],
    }).populate(['requesterId', 'receiverId']);

    res.json({
      friends: friendships.map((friendship) => friendshipSummary(friendship, req.user.userId)),
    });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

//route for getting all the pending friend requests
router.get('/friends/requests', async (req, res) => {
  try {
    const currentUserId = toObjectId(req.user.userId);
    const requests = await Friendship.find({
      receiverId: currentUserId,
      status: 'pending',
    }).populate(['requesterId', 'receiverId']);

    res.json({
      requests: requests.map((friendship) => friendshipSummary(friendship, req.user.userId)),
    });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

//route for accepting friend request(only a request receiver can accept request otherwise it will send an error)
router.post('/friends/:id/accept', async (req, res) => {
  try {
    const friendship = await Friendship.findOneAndUpdate(
      {
        _id: req.params.id,
        receiverId: req.user.userId,
        status: 'pending',
      },
      { $set: { status: 'accepted' }, $unset: { blockedBy: 1, blockedAt: 1 } },
      { new: true }
    ).populate(['requesterId', 'receiverId']);

    if (!friendship) {
      return res.status(404).json({ message: 'Friend request not found.' });
    }

    await createAndSendNotifications({
      type: 'friend_request_accepted',
      recipientIds: [friendship.requesterId._id],
      actorId: friendship.receiverId._id,
      friendshipId: friendship._id,
      title: 'Friend request accepted',
      message: `${friendship.receiverId.name} accepted your friend request`,
    });

    res.json({ friendship: friendshipSummary(friendship, req.user.userId) });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

//route for blocking another person(both users can block eachother unlike accept route)
router.post('/friends/:id/block', async (req, res) => {
  try {
    const currentUserId = toObjectId(req.user.userId);
    const friendship = await Friendship.findOneAndUpdate(
      {
        _id: req.params.id,
        $or: [{ requesterId: currentUserId }, { receiverId: currentUserId }],
      },
      {
        $set: {
          status: 'blocked',
          blockedBy: currentUserId,
          blockedAt: new Date(),
        },
      },
      { new: true }
    ).populate(['requesterId', 'receiverId']);

    if (!friendship) {
      return res.status(404).json({ message: 'Friendship not found.' });
    }

    res.json({ friendship: friendshipSummary(friendship, req.user.userId) });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

//route for permanently deleting friendship document
router.delete('/friends/:id', async (req, res) => {
  try {
    const currentUserId = toObjectId(req.user.userId);
    const friendship = await Friendship.findOneAndDelete({
      _id: req.params.id,
      $or: [{ requesterId: currentUserId }, { receiverId: currentUserId }],
    });

    if (!friendship) {
      return res.status(404).json({ message: 'Friendship not found.' });
    }

    res.status(204).send();
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

//route for getting all the conversation that user is involved in with most recent activity on top
router.get('/conversations', async (req, res) => {
  try {
    console.log('GET /social/conversations', { userId: req.user.userId });
    const currentUserId = toObjectId(req.user.userId);

    const conversations = await Conversation.find({
      participants: req.user.userId,
    })
      .populate('participants')
      .sort({ updatedAt: -1 });

    const acceptedFriendships = await Friendship.find({
      status: 'accepted',
      $or: [{ requesterId: currentUserId }, { receiverId: currentUserId }],
    });
    const acceptedDirectFriendIds = new Set();

    acceptedFriendships.forEach((friendship) => {
      const requesterId = friendship.requesterId.toString();
      const receiverId = friendship.receiverId.toString();
      acceptedDirectFriendIds.add(requesterId === req.user.userId ? receiverId : requesterId);
    });
    const visibleConversations = conversations.filter((conversation) => {
      const otherParticipantId = getOtherParticipantId(conversation, req.user.userId);

      return !otherParticipantId || acceptedDirectFriendIds.has(idString(otherParticipantId));
    });

    res.json({ conversations: visibleConversations.map(conversationSummary) });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

//route for checking if there is existing conversation between friends and creating if there isn't one
router.post('/conversations/direct', async (req, res) => {
  try {
    console.log('POST /social/conversations/direct', {
      userId: req.user.userId,
      friendId: req.body.friendId,
    });

    const currentUserId = toObjectId(req.user.userId);
    const friendId = toObjectId(req.body.friendId);

    if (!friendId) {
      return res.status(400).json({ message: 'Friend ID is required.' });
    }

    const friendship = await findFriendship(currentUserId, friendId, 'accepted');

    if (!friendship) {
      const blockedFriendship = await findFriendship(currentUserId, friendId, 'blocked');
      return res.status(403).json({
        message: blockedFriendship ? 'This friend connection is blocked.' : 'You can only chat with accepted friends.',
      });
    }

    let conversation = await Conversation.findOne({
      type: 'direct',
      participants: { $all: [currentUserId, friendId] },
    }).populate('participants');

    if (!conversation) {
      conversation = await Conversation.create({
        participants: [currentUserId, friendId],
        type: 'direct',
      });
      conversation = await conversation.populate('participants');
    }

    res.json({ conversation: conversationSummary(conversation) });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

//route for getting messages from conversation
router.get('/conversations/:id/messages', async (req, res) => {
  try {
    console.log('GET /social/conversations/:id/messages', {
      userId: req.user.userId,
      conversationId: req.params.id,
    });

    const conversation = await ensureConversationParticipant(req.params.id, req.user.userId);

    if (!conversation) {
      return res.status(404).json({ message: 'Conversation not found.' });
    }

    if (!(await ensureDirectConversationNotBlocked(conversation, req.user.userId))) {
      return res.status(403).json({ message: 'This friend connection is blocked.' });
    }

    const messages = await Message.find({ conversationId: conversation._id })
      .populate('senderId')
      .sort({ createdAt: 1 });
    res.json({ messages: messages.map(messageSummary) });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

//route for posting new message
router.post('/conversations/:id/messages', async (req, res) => {
  try {
    console.log('POST /social/conversations/:id/messages', {
      userId: req.user.userId,
      conversationId: req.params.id,
      hasContent: Boolean(req.body.content),
    });

    const content = String(req.body.content || '').trim();

    if (!content) {
      return res.status(400).json({ message: 'Message content is required.' });
    }

    const conversation = await ensureConversationParticipant(req.params.id, req.user.userId);

    if (!conversation) {
      return res.status(404).json({ message: 'Conversation not found.' });
    }

    if (!(await ensureDirectConversationNotBlocked(conversation, req.user.userId))) {
      return res.status(403).json({ message: 'This friend connection is blocked.' });
    }

    const message = await Message.create({
      conversationId: conversation._id,
      senderId: req.user.userId,
      content,
      readBy: [req.user.userId],
    });

    const sender = await User.findById(req.user.userId);
    await createAndSendNotifications({
      type: 'message',
      recipientIds: conversation.participants,
      actorId: req.user.userId,
      conversationId: conversation._id,
      messageId: message._id,
      title: sender?.name ? `New message from ${sender.name}` : 'New message',
      message: previewText(content),
    });

    await Conversation.findByIdAndUpdate(conversation._id, { $set: { updatedAt: new Date() } });
    res.status(201).json({ message: messageSummary(message) });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

export default router;
