/**
 * Push notification sending. Android (FCM) is always available and free.
 * iOS (APNs) is fully implemented but gated behind APNS_ENABLED (default off)
 * because it requires a paid Apple Developer account + APNs auth key -
 * see README "Notifications" section. When disabled, iOS tokens are simply
 * skipped (no APNs SDK is even imported), so the Android path and builds are
 * unaffected.
 */

import { getDB } from '../config/database';

export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface PushResult {
  attempted: number;
  sent: number;
  failed: number;
  skippedIosDisabled: number;
}

let firebaseApp: any = null;

function getFirebaseApp(): any {
  if (firebaseApp) return firebaseApp;

  const projectId = process.env.FCM_PROJECT_ID;
  const clientEmail = process.env.FCM_CLIENT_EMAIL;
  const privateKey = process.env.FCM_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    console.warn('⚠️ FCM credentials not configured (FCM_PROJECT_ID/FCM_CLIENT_EMAIL/FCM_PRIVATE_KEY) - Android push will be skipped');
    return null;
  }

  // Lazy require so the dependency is only touched when actually configured.
  const admin = require('firebase-admin');
  firebaseApp = admin.apps?.length
    ? admin.app()
    : admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          privateKey: privateKey.replace(/\\n/g, '\n'),
        }),
      });

  return firebaseApp;
}

async function sendAndroid(tokens: string[], message: PushMessage): Promise<{ sent: number; failed: number; invalidTokens: string[] }> {
  if (tokens.length === 0) return { sent: 0, failed: 0, invalidTokens: [] };

  const app = getFirebaseApp();
  if (!app) return { sent: 0, failed: tokens.length, invalidTokens: [] };

  const admin = require('firebase-admin');
  const messaging = admin.messaging(app);
  const invalidTokens: string[] = [];
  let sent = 0;
  let failed = 0;

  const response = await messaging.sendEachForMulticast({
    tokens,
    notification: { title: message.title, body: message.body },
    data: message.data || {},
  });

  response.responses.forEach((r: any, i: number) => {
    if (r.success) {
      sent++;
    } else {
      failed++;
      const code = r.error?.code || '';
      if (code.includes('registration-token-not-registered') || code.includes('invalid-argument')) {
        invalidTokens.push(tokens[i]);
      }
    }
  });

  return { sent, failed, invalidTokens };
}

let apnsProviderJwt: { token: string; issuedAt: number } | null = null;

function getApnsProviderToken(): string {
  // APNs provider tokens are valid up to 1 hour; refresh a bit early.
  if (apnsProviderJwt && Date.now() - apnsProviderJwt.issuedAt < 55 * 60 * 1000) {
    return apnsProviderJwt.token;
  }

  const jwt = require('jsonwebtoken');
  const fs = require('fs');
  const key = fs.readFileSync(process.env.APNS_KEY_PATH as string, 'utf8');

  const token = jwt.sign({}, key, {
    algorithm: 'ES256',
    issuer: process.env.APNS_TEAM_ID,
    keyid: process.env.APNS_KEY_ID,
    expiresIn: '55m',
  });

  apnsProviderJwt = { token, issuedAt: Date.now() };
  return token;
}

/**
 * Sends a single APNs push over HTTP/2 using Node's built-in `http2` module
 * and a JWT provider token (Apple's modern token-based auth) instead of a
 * third-party APNs SDK (the `apn` npm package is unmaintained and drags in a
 * broken legacy sub-dependency). Only ever reached when APNS_ENABLED=true.
 */
function sendOneIos(host: string, deviceToken: string, message: PushMessage): Promise<boolean> {
  return new Promise((resolve) => {
    const http2 = require('http2');
    const client = http2.connect(host);
    client.on('error', () => resolve(false));

    const payload = JSON.stringify({
      aps: { alert: { title: message.title, body: message.body }, sound: 'default' },
      ...(message.data || {}),
    });

    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      authorization: `bearer ${getApnsProviderToken()}`,
      'apns-topic': process.env.APNS_BUNDLE_ID,
      'apns-push-type': 'alert',
      'content-type': 'application/json',
    });

    let status = 0;
    req.on('response', (headers: Record<string, any>) => {
      status = headers[':status'];
    });
    req.on('end', () => {
      client.close();
      resolve(status === 200);
    });
    req.on('error', () => {
      client.close();
      resolve(false);
    });

    req.write(payload);
    req.end();
  });
}

async function sendIos(tokens: string[], message: PushMessage): Promise<{ sent: number; failed: number }> {
  const enabled = process.env.APNS_ENABLED === 'true';
  if (!enabled || tokens.length === 0) {
    return { sent: 0, failed: 0 };
  }

  const host = process.env.APNS_PRODUCTION === 'true'
    ? 'https://api.push.apple.com'
    : 'https://api.sandbox.push.apple.com';

  const results = await Promise.all(tokens.map((token) => sendOneIos(host, token, message)));
  const sent = results.filter(Boolean).length;
  return { sent, failed: results.length - sent };
}

/**
 * Sends a push message to every active device token for a user (or a list of
 * users) within an event. Always fail-open: a missing/misconfigured provider
 * degrades to "0 sent" rather than throwing, so callers (e.g. an access
 * change or announcement) never fail because push isn't set up.
 */
export async function sendPushToUsers(eventId: number, userIds: number[], message: PushMessage): Promise<PushResult> {
  const db = getDB();
  const result: PushResult = { attempted: 0, sent: 0, failed: 0, skippedIosDisabled: 0 };

  if (userIds.length === 0) return result;

  const tokensResult = await db.query(
    `SELECT token, platform FROM device_tokens WHERE event_id = $1 AND user_id = ANY($2::int[]) AND is_active = true`,
    [eventId, userIds]
  );

  const androidTokens = tokensResult.rows.filter(r => r.platform === 'android').map(r => r.token);
  const iosTokens = tokensResult.rows.filter(r => r.platform === 'ios').map(r => r.token);

  result.attempted = androidTokens.length + iosTokens.length;
  if (iosTokens.length > 0 && process.env.APNS_ENABLED !== 'true') {
    result.skippedIosDisabled = iosTokens.length;
  }

  try {
    const androidResult = await sendAndroid(androidTokens, message);
    result.sent += androidResult.sent;
    result.failed += androidResult.failed;

    if (androidResult.invalidTokens.length > 0) {
      await db.query(
        `UPDATE device_tokens SET is_active = false WHERE token = ANY($1::text[])`,
        [androidResult.invalidTokens]
      );
    }
  } catch (error) {
    console.error('FCM send error (fail-open):', error);
    result.failed += androidTokens.length;
  }

  try {
    const iosResult = await sendIos(iosTokens, message);
    result.sent += iosResult.sent;
    result.failed += iosResult.failed;
  } catch (error) {
    console.error('APNs send error (fail-open):', error);
    result.failed += iosTokens.length;
  }

  return result;
}
