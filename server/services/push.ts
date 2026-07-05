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

async function sendIos(tokens: string[], message: PushMessage): Promise<{ sent: number; failed: number }> {
  const enabled = process.env.APNS_ENABLED === 'true';
  if (!enabled || tokens.length === 0) {
    return { sent: 0, failed: 0 };
  }

  // Requires an Apple Developer Program membership ($99/yr) + APNs auth key.
  // Lazy-required so `apn` never needs to be installed/configured unless
  // APNS_ENABLED=true.
  const apn = require('apn');

  const options = {
    token: {
      key: process.env.APNS_KEY_PATH as string,
      keyId: process.env.APNS_KEY_ID as string,
      teamId: process.env.APNS_TEAM_ID as string,
    },
    production: process.env.APNS_PRODUCTION === 'true',
  };

  const provider = new apn.Provider(options);
  const note = new apn.Notification();
  note.alert = { title: message.title, body: message.body };
  note.payload = message.data || {};
  note.topic = process.env.APNS_BUNDLE_ID as string;

  const result = await provider.send(note, tokens);
  provider.shutdown();

  return { sent: result.sent.length, failed: result.failed.length };
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
