import mongoose from 'mongoose';
import { readEncryptedField } from '../services/dataEncryptionService.js';
const { Schema, model } = mongoose;

const ENCRYPTED_USER_FIELDS = [
  'contactNumber',
  'homeArea',
  'homeLat',
  'homeLng',
  'googleAccessToken',
  'googleRefreshToken',
];

function applyUserPrivacyTransform(document, returnedUser) {
  for (const field of ENCRYPTED_USER_FIELDS) {
    const value = readEncryptedField(document, field);

    if (value !== undefined && value !== null) {
      returnedUser[field] = value;
    }

    delete returnedUser[`${field}Encrypted`];
  }

  delete returnedUser.googleAccessToken;
  delete returnedUser.googleRefreshToken;

  return returnedUser;
}

const UserSchema = new Schema({
  googleId: {
    type: String,
    required: true,
    unique: true
  },

  name: {
    type: String,
    required: true
  },

  email: {
    type: String,
    required: true,
    unique: true
  },

  friendCode: {
    type: String,
    unique: true,
    sparse: true,
    trim: true,
    uppercase: true
  },

  profilePicture: String,
  contactNumber: String,
  contactNumberEncrypted: String,

  homeArea: String,
  homeAreaEncrypted: String,
  homeLat: Number,
  homeLatEncrypted: String,
  homeLng: Number,
  homeLngEncrypted: String,

  googleAccessToken: String,
  googleAccessTokenEncrypted: String,

  googleRefreshToken: String,
  googleRefreshTokenEncrypted: String,

  googleTokenExpiry: Date
});

UserSchema.set('toJSON', {
  transform: applyUserPrivacyTransform,
});

UserSchema.set('toObject', {
  transform: applyUserPrivacyTransform,
});

const FriendshipSchema = new Schema({
  requesterId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  receiverId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'accepted', 'blocked'],
    default: 'pending'
  },
  blockedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User'
  },
  blockedAt: {
    type: Date
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

FriendshipSchema.index({ requesterId: 1, receiverId: 1 }, { unique: true });
FriendshipSchema.index({ receiverId: 1, status: 1 });
FriendshipSchema.index({ blockedBy: 1, status: 1 });

const ConversationSchema = new Schema(
  {
    title: {
      type: String,
      trim: true
    },
    participants: [{
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    }],
    type: {
      type: String,
      enum: ['direct', 'group'],
      default: 'direct'
    }
  },
  { timestamps: true }
);

ConversationSchema.index({ participants: 1, type: 1 });

const MessageSchema = new Schema({
  conversationId: {
    type: Schema.Types.ObjectId,
    ref: 'Conversation',
    required: true
  },
  senderId: {
    type: Schema.Types.ObjectId,
    ref: 'User'
  },
  type: {
    type: String,
    enum: ['user', 'system'],
    default: 'user'
  },
  planId: {
    type: Schema.Types.ObjectId,
    ref: 'Plan'
  },
  content: {
    type: String,
    required: true,
    trim: true
  },
  readBy: [{
    type: Schema.Types.ObjectId,
    ref: 'User'
  }],
  createdAt: {
    type: Date,
    default: Date.now
  }
});

MessageSchema.index({ conversationId: 1, createdAt: 1 });

const PlanSchema = new Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true
    },
    creatorId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    participantIds: [{
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    }],
    invitedParticipantIds: [{
      type: Schema.Types.ObjectId,
      ref: 'User'
    }],
    acceptedParticipantIds: [{
      type: Schema.Types.ObjectId,
      ref: 'User'
    }],
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: 'Conversation'
    },
    place: {
      name: String,
      address: String,
      lat: Number,
      lng: Number,
      rating: Number,
      googleMapsUri: String
    },
    startsAt: {
      type: Date,
      required: true
    },
    endsAt: {
      type: Date,
      required: true
    },
    activityType: {
      type: String,
      default: 'food'
    },
    status: {
      type: String,
      enum: ['pending', 'confirmed', 'cancelled'],
      default: 'confirmed'
    },
    cancelledBy: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    },
    cancelledAt: {
      type: Date
    }
  },
  { timestamps: true }
);

PlanSchema.index({ participantIds: 1, startsAt: 1 });

const AgentConversationSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    title: {
      type: String,
      trim: true,
      default: 'AI planner'
    },
    status: {
      type: String,
      enum: ['active', 'completed'],
      default: 'active'
    },
    messages: [{
      role: {
        type: String,
        enum: ['user', 'assistant'],
        required: true
      },
      content: {
        type: String,
        required: true,
        trim: true
      },
      data: {
        type: Schema.Types.Mixed
      },
      createdAt: {
        type: Date,
        default: Date.now
      }
    }],
    agentState: {
      type: Schema.Types.Mixed,
      default: {}
    }
  },
  { timestamps: true }
);

AgentConversationSchema.index({ userId: 1, updatedAt: -1 });

const NotificationSchema = new Schema(
  {
    type: {
      type: String,
      required: true,
      enum: [
        'plan_invite',
        'plan_accepted',
        'plan_cancelled',
        'friend_request',
        'friend_request_accepted',
        'message',
      ]
    },
    recipientId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    actorId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    planId: {
      type: Schema.Types.ObjectId,
      ref: 'Plan'
    },
    friendshipId: {
      type: Schema.Types.ObjectId,
      ref: 'Friendship'
    },
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: 'Conversation'
    },
    messageId: {
      type: Schema.Types.ObjectId,
      ref: 'Message'
    },
    title: {
      type: String,
      required: true,
      trim: true
    },
    message: {
      type: String,
      required: true,
      trim: true
    },
    read: {
      type: Boolean,
      default: false
    }
  },
  { timestamps: true }
);

NotificationSchema.index({ recipientId: 1, read: 1, createdAt: -1 });
NotificationSchema.index({ planId: 1, type: 1 });
NotificationSchema.index({ friendshipId: 1, type: 1 });
NotificationSchema.index({ conversationId: 1, createdAt: -1 });

const FcmTokenSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    token: {
      type: String,
      trim: true
    },
    tokenEncrypted: {
      type: String
    },
    tokenHash: {
      type: String,
      unique: true,
      sparse: true,
      trim: true
    },
    platform: {
      type: String,
      enum: ['ios', 'android', 'web', 'unknown'],
      default: 'unknown'
    },
    deviceId: {
      type: String,
      trim: true
    },
    lastSeenAt: {
      type: Date,
      default: Date.now
    }
  },
  { timestamps: true }
);

FcmTokenSchema.index({ userId: 1, platform: 1 });
FcmTokenSchema.index({ lastSeenAt: 1 });

FcmTokenSchema.set('toJSON', {
  transform(_document, returnedToken) {
    delete returnedToken.token;
    delete returnedToken.tokenEncrypted;
    delete returnedToken.tokenHash;
    return returnedToken;
  },
});

export const User = model('User', UserSchema);
export const Friendship = model('Friendship', FriendshipSchema);
export const Conversation = model('Conversation', ConversationSchema);
export const Message = model('Message', MessageSchema);
export const Plan = model('Plan', PlanSchema);
export const AgentConversation = model('AgentConversation', AgentConversationSchema);
export const Notification = model('Notification', NotificationSchema);
export const FcmToken = model('FcmToken', FcmTokenSchema);
