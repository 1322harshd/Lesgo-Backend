import express from 'express';
import mongoose from 'mongoose';
import { protect } from './authMiddleware.js';
import { Conversation, Friendship, Message, User } from './models.js';

const router = express.Router();

router.use(protect);

function toObjectId(id) {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return null;
  }

  return new mongoose.Types.ObjectId(id);
}

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

function friendshipSummary(friendship, currentUserId) {
  const requester = userSummary(friendship.requesterId);
  const receiver = userSummary(friendship.receiverId);
  const friend = requester?.id === currentUserId ? receiver : requester;

  return {
    id: friendship._id.toString(),
    status: friendship.status,
    createdAt: friendship.createdAt,
    requester,
    receiver,
    friend,
  };
}

function messageSummary(message) {
  return {
    id: message._id.toString(),
    conversationId: message.conversationId.toString(),
    senderId: message.senderId.toString(),
    content: message.content,
    readBy: message.readBy.map((id) => id.toString()),
    createdAt: message.createdAt,
  };
}

function conversationSummary(conversation) {
  return {
    id: conversation._id.toString(),
    type: conversation.type,
    participants: conversation.participants.map(userSummary).filter(Boolean),
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}

async function findFriendship(userId, otherUserId, status) {
  return Friendship.findOne({
    status,
    $or: [
      { requesterId: userId, receiverId: otherUserId },
      { requesterId: otherUserId, receiverId: userId },
    ],
  });
}

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
    res.status(201).json({ friendship: friendshipSummary(populatedFriendship, req.user.userId) });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

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

router.post('/friends/:id/accept', async (req, res) => {
  try {
    const friendship = await Friendship.findOneAndUpdate(
      {
        _id: req.params.id,
        receiverId: req.user.userId,
        status: 'pending',
      },
      { $set: { status: 'accepted' } },
      { new: true }
    ).populate(['requesterId', 'receiverId']);

    if (!friendship) {
      return res.status(404).json({ message: 'Friend request not found.' });
    }

    res.json({ friendship: friendshipSummary(friendship, req.user.userId) });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.post('/friends/:id/block', async (req, res) => {
  try {
    const currentUserId = toObjectId(req.user.userId);
    const friendship = await Friendship.findOneAndUpdate(
      {
        _id: req.params.id,
        $or: [{ requesterId: currentUserId }, { receiverId: currentUserId }],
      },
      { $set: { status: 'blocked' } },
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

router.get('/conversations', async (req, res) => {
  try {
    const conversations = await Conversation.find({
      participants: req.user.userId,
    })
      .populate('participants')
      .sort({ updatedAt: -1 });

    res.json({ conversations: conversations.map(conversationSummary) });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.post('/conversations/direct', async (req, res) => {
  try {
    const currentUserId = toObjectId(req.user.userId);
    const friendId = toObjectId(req.body.friendId);

    if (!friendId) {
      return res.status(400).json({ message: 'Friend ID is required.' });
    }

    const friendship = await findFriendship(currentUserId, friendId, 'accepted');

    if (!friendship) {
      return res.status(403).json({ message: 'You can only chat with accepted friends.' });
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

router.get('/conversations/:id/messages', async (req, res) => {
  try {
    const conversation = await ensureConversationParticipant(req.params.id, req.user.userId);

    if (!conversation) {
      return res.status(404).json({ message: 'Conversation not found.' });
    }

    const messages = await Message.find({ conversationId: conversation._id }).sort({ createdAt: 1 });
    res.json({ messages: messages.map(messageSummary) });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.post('/conversations/:id/messages', async (req, res) => {
  try {
    const content = String(req.body.content || '').trim();

    if (!content) {
      return res.status(400).json({ message: 'Message content is required.' });
    }

    const conversation = await ensureConversationParticipant(req.params.id, req.user.userId);

    if (!conversation) {
      return res.status(404).json({ message: 'Conversation not found.' });
    }

    const message = await Message.create({
      conversationId: conversation._id,
      senderId: req.user.userId,
      content,
      readBy: [req.user.userId],
    });

    await Conversation.findByIdAndUpdate(conversation._id, { $set: { updatedAt: new Date() } });
    res.status(201).json({ message: messageSummary(message) });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

export default router;
