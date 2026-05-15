import express from 'express';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import { User } from './models.js';

const router = express.Router();
const GOOGLE_CLIENT_ID = process.env.GOOGLE_WEB_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const client = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);

function removeEmptyValues(data) {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined && value !== null)
  );
}

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

  const { tokens } = await client.getToken(serverAuthCode);

  return {
    googleAccessToken: tokens.access_token,
    googleRefreshToken: tokens.refresh_token,
    googleTokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
    idToken: tokens.id_token,
  };
    }

    router.post('/google', async (req, res) => {
  const {
    idToken,
    accessToken,
    serverAuthCode,
    profile: requestProfile = {},
  } = req.body;

  try {
    const exchanged = await exchangeServerAuthCode(serverAuthCode);
    const effectiveIdToken = idToken || exchanged.idToken;
    const effectiveAccessToken = exchanged.googleAccessToken || accessToken;
    const googleTokenExpiry =
      exchanged.googleTokenExpiry || (await getAccessTokenExpiry(effectiveAccessToken));

    let googleProfile;

    if (effectiveIdToken) {
      googleProfile = await getProfileFromIdToken(effectiveIdToken);
    } else if (effectiveAccessToken) {
      googleProfile = await getProfileFromAccessToken(effectiveAccessToken);
    } else {
      googleProfile = {
        googleId: requestProfile.googleId,
        email: requestProfile.email,
        name: requestProfile.name,
        profilePicture: requestProfile.profilePicture,
      };
    }

    if (!googleProfile.googleId || !googleProfile.email) {
      return res.status(400).json({ message: 'Google profile data is required.' });
    }

    const userUpdate = removeEmptyValues({
      googleId: googleProfile.googleId,
      email: googleProfile.email,
      name: googleProfile.name || googleProfile.email,
      profilePicture: googleProfile.profilePicture,
      homeArea: requestProfile.homeArea,
      homeLat: requestProfile.homeLat,
      homeLng: requestProfile.homeLng,
      googleAccessToken: effectiveAccessToken,
      googleRefreshToken: exchanged.googleRefreshToken,
      googleTokenExpiry,
    });

    const user = await User.findOneAndUpdate(
      { googleId: googleProfile.googleId },
      { $set: userUpdate },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    );

    const token = jwt.sign(
      { userId: user._id, email: user.email },
      process.env.JWT_SECRET || 'lesgo-dev-secret',
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

    res.json({ token, user });
  } catch (error) {
console.error('Google auth failed:', error);
    res.status(401).json({ message: error.message || 'Invalid Google token' });
  }
});

export default router;
