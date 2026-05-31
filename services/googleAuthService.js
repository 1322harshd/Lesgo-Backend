import { OAuth2Client } from 'google-auth-library';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_WEB_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const oauthClient = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);

export async function getFreshGoogleAccessToken(user) {
  if (
    user.googleAccessToken &&
    user.googleTokenExpiry &&
    new Date(user.googleTokenExpiry).getTime() > Date.now() + 60 * 1000
  ) {
    return user.googleAccessToken;
  }

  if (!user.googleRefreshToken) {
    return user.googleAccessToken;
  }

  oauthClient.setCredentials({ refresh_token: user.googleRefreshToken });
  const { credentials } = await oauthClient.refreshAccessToken();

  if (credentials.access_token) {
    user.googleAccessToken = credentials.access_token;
  }

  if (credentials.expiry_date) {
    user.googleTokenExpiry = new Date(credentials.expiry_date);
  }

  await user.save();

  return user.googleAccessToken;
}
