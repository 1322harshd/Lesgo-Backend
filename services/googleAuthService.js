import { OAuth2Client } from 'google-auth-library';
import {
  getUserPrivateField,
} from './userPrivacyService.js';
import { setEncryptedField } from './dataEncryptionService.js';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_WEB_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const oauthClient = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);

export async function getFreshGoogleAccessToken(user) {
  const accessToken = getUserPrivateField(user, 'googleAccessToken');
  const refreshToken = getUserPrivateField(user, 'googleRefreshToken');

  if (
    accessToken &&
    user.googleTokenExpiry &&
    new Date(user.googleTokenExpiry).getTime() > Date.now() + 60 * 1000
  ) {
    return accessToken;
  }

  if (!refreshToken) {
    return accessToken;
  }

  oauthClient.setCredentials({ refresh_token: refreshToken });
  const { credentials } = await oauthClient.refreshAccessToken();

  if (refreshToken && !user.googleRefreshTokenEncrypted) {
    setEncryptedField(user, 'googleRefreshToken', refreshToken);
  }

  if (credentials.access_token) {
    setEncryptedField(user, 'googleAccessToken', credentials.access_token);
  }

  if (credentials.expiry_date) {
    user.googleTokenExpiry = new Date(credentials.expiry_date);
  }

  await user.save();

  return getUserPrivateField(user, 'googleAccessToken');
}
