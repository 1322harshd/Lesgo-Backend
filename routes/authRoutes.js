import express from 'express';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import { User } from '../models/appModels.js';

const router = express.Router();
const GOOGLE_CLIENT_ID = process.env.GOOGLE_WEB_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const JWT_SECRET = process.env.JWT_SECRET || 'lesgo-dev-secret';

//create a single OAuth2Client instance to reuse for all Google token verifications and exchanges
const client = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);

// utility function to remove undefined or null values from an object
function removeEmptyValues(data) {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined && value !== null)
  );
}

// generate a unique friend code in the format "LES-XXXXXX"
async function generateFriendCode() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = `LES-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const existingUser = await User.exists({ friendCode: code });

    if (!existingUser) {
      return code;
    }
  }

  throw new Error('Could not generate a unique friend code.');
}

// fetch the user's Google profile using the access token
async function getProfileFromAccessToken(accessToken) {
  const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Google userinfo failed with status ${response.status}`);
  }

  const profile = await response.json();

  return {
    googleId: profile.sub,
    email: profile.email,
    name: profile.name,
    profilePicture: profile.picture,
  };
}

// fetch the expiry time of the access token from Google's tokeninfo endpoint
async function getAccessTokenExpiry(accessToken) {
  if (!accessToken) {
    return undefined;
  }

  const response = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`
  );

  if (!response.ok) {
    return undefined;
  }

  const tokenInfo = await response.json();
  const expiresInSeconds = Number(tokenInfo.expires_in);

  if (!Number.isFinite(expiresInSeconds)) {
    return undefined;
  }

  return new Date(Date.now() + expiresInSeconds * 1000);
}

// verify the ID token and extract the user's Google profile information
async function getProfileFromIdToken(idToken) {
  if (!GOOGLE_CLIENT_ID) {
    throw new Error('GOOGLE_WEB_CLIENT_ID is required to verify Google ID tokens.');
  }

  const ticket = await client.verifyIdToken({
    idToken,
    audience: GOOGLE_CLIENT_ID,
  });

  const { email, name, picture, sub: googleId } = ticket.getPayload();

  return {
    googleId,
    email,
    name,
    profilePicture: picture,
  };
}

async function exchangeServerAuthCode(serverAuthCode) {
  if (!serverAuthCode || !GOOGLE_CLIENT_SECRET) {
    return {};
  }

  try {
    const { tokens } = await client.getToken(serverAuthCode);

    return {
      googleAccessToken: tokens.access_token,
      googleRefreshToken: tokens.refresh_token,
      googleTokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
      idToken: tokens.id_token,
    };
  } catch (error) {
    console.warn('Google auth code exchange failed; continuing with app access token:', {
      message: error.message,
      code: error.code,
      status: error.status,
      googleError: error.response?.data?.error,
    });

    return {};
  }
}

async function resolveGoogleProfile({ idToken, accessToken }) {
  let idTokenError;

  if (idToken) {
    try {
      return await getProfileFromIdToken(idToken);
    } catch (error) {
      idTokenError = error;
    }
  }

  if (accessToken) {
    return getProfileFromAccessToken(accessToken);
  }

  throw idTokenError || new Error('Google token is required.');
}

//authenticate or register a user using Google tokens
router.post('/google', async (req, res) => {
  const {
    authMode = 'login',
    idToken,
    accessToken,
    serverAuthCode,
    profile: requestProfile = {},
  } = req.body;
  const isSignup = authMode === 'signup';

  try {
    const exchanged = isSignup ? await exchangeServerAuthCode(serverAuthCode) : {};
    const effectiveIdToken = idToken || exchanged.idToken;
    const effectiveAccessToken = exchanged.googleAccessToken || accessToken;
    const googleTokenExpiry =
      isSignup
        ? exchanged.googleTokenExpiry || (await getAccessTokenExpiry(effectiveAccessToken))
        : undefined;

    const googleProfile = await resolveGoogleProfile({
      idToken: effectiveIdToken,
      accessToken: effectiveAccessToken,
    });

    if (!googleProfile.googleId || !googleProfile.email) {
      return res.status(400).json({ message: 'Google profile data is required.' });
    }

    const existingUser = await User.findOne({
      $or: [{ googleId: googleProfile.googleId }, { email: googleProfile.email }],
    });

    if (!isSignup && !existingUser) {
      return res.status(404).json({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'No account found. Please sign up first.',
      });
    }

    const userUpdate = removeEmptyValues({
      googleId: googleProfile.googleId,
      email: googleProfile.email,
      name: googleProfile.name || googleProfile.email,
      profilePicture: googleProfile.profilePicture,
      homeArea: requestProfile.homeArea,
      homeLat: requestProfile.homeLat,
      homeLng: requestProfile.homeLng,
      googleAccessToken: isSignup ? effectiveAccessToken : undefined,
      googleRefreshToken: isSignup ? exchanged.googleRefreshToken : undefined,
      googleTokenExpiry: isSignup ? googleTokenExpiry : undefined,
    });

    const user = existingUser
      ? await User.findByIdAndUpdate(
          existingUser._id,
          {
            $set: {
              ...userUpdate,
              friendCode: existingUser.friendCode || await generateFriendCode(),
            },
          },
          { new: true, runValidators: true }
        )
      : await User.create({
          ...userUpdate,
          friendCode: await generateFriendCode(),
        });

    const token = jwt.sign(
      { userId: user._id, email: user.email },
      JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    console.log('Saved Google user:', {
      id: user._id,
      googleId: user.googleId,
      email: user.email,
      hasAccessToken: Boolean(user.googleAccessToken),
      hasRefreshToken: Boolean(user.googleRefreshToken),
      googleTokenExpiry: user.googleTokenExpiry,
    });

    res.json({
      token,
      user,
      authStatus: existingUser ? (isSignup ? 'signed_in_existing' : 'signed_in') : 'created',
    });
  } catch (error) {
    console.error('Google auth failed:', error);
    res.status(401).json({ message: error.message || 'Invalid Google token' });
  }
});

export default router;
