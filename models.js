import mongoose from 'mongoose';
const { Schema, model } = mongoose;

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

  homeArea: String,
  homeLat: Number,
  homeLng: Number,

  googleAccessToken: String,

  googleRefreshToken: String,

  googleTokenExpiry: Date
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
  createdAt: {
    type: Date,
    default: Date.now
  }
});

FriendshipSchema.index({ requesterId: 1, receiverId: 1 }, { unique: true });
FriendshipSchema.index({ receiverId: 1, status: 1 });

const ConversationSchema = new Schema(
  {
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
    ref: 'User',
    required: true
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

export const User = model('User', UserSchema);
export const Friendship = model('Friendship', FriendshipSchema);
export const Conversation = model('Conversation', ConversationSchema);
export const Message = model('Message', MessageSchema);
