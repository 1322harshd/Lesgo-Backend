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

  profilePicture: String,
  contactNumber: String,

  homeArea: String,
  homeLat: Number,
  homeLng: Number,

  googleAccessToken: String,

  googleRefreshToken: String,

  googleTokenExpiry: Date
});

export const User = model('User', UserSchema);
