import express from 'express';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import { User } from './models.js';

const router = express.Router();
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

router.post('/google', async (req, res) => {
  const { idToken } = req.body;
  try {
    // 1. Verify idToken with Google
    const ticket = await client.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const { email, name, picture, sub: googleId } = ticket.getPayload();

    // 2. Find or create user
    let user = await User.findOne({ email });
    if (!user) {
      user = await User.create({
        email,
        name,
        profilePicture: picture,
        googleId,
      });
    }

    // 3. Create JWT
    const token = jwt.sign(
      { userId: user._id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    // 4. Send JWT and user info
    res.json({ token, user });
  } catch (error) {
    res.status(401).json({ message: 'Invalid Google token' });
  }
});

export default router;