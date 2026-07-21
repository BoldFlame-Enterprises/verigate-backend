import crypto, { KeyObject } from 'crypto';

export const QR_PROTOCOL_VERSION = 'verigate-qr-v2';
export const QR_CLOCK_SKEW_MS = 60_000;
export const QR_PRESENTATION_TTL_MS = 60_000;

export interface CredentialAssignment {
  area_id: number;
  area_name: string;
  access_level_id: number;
  access_level_name: string;
  access_priority: number;
  valid_from: string;
  valid_until: string;
}

export interface AuthorityCredentialPayload {
  version: typeof QR_PROTOCOL_VERSION;
  credential_id: string;
  credential_version: string;
  user_id: number;
  email: string;
  name: string;
  event_id: number;
  device_id: string;
  device_public_key: string;
  assignments: CredentialAssignment[];
  issued_at: number;
  expires_at: number;
}

export interface AuthorityCredential {
  payload: AuthorityCredentialPayload;
  authority_signature: string;
  authority_public_key: string;
}

export interface PresentationPayload {
  version: typeof QR_PROTOCOL_VERSION;
  credential: AuthorityCredential;
  issued_at: number;
  expires_at: number;
  nonce: string;
}

export interface QrPresentation {
  payload: PresentationPayload;
  device_signature: string;
}

let testKeyPair: { privateKey: KeyObject; publicKey: KeyObject } | null = null;

function authorityKeys(): { privateKey: KeyObject; publicKey: KeyObject } {
  const encoded = process.env.QR_AUTHORITY_PRIVATE_KEY_BASE64;
  if (encoded) {
    const privateKey = crypto.createPrivateKey({
      key: Buffer.from(encoded, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
    return { privateKey, publicKey: crypto.createPublicKey(privateKey) };
  }

  if (process.env.NODE_ENV === 'test') {
    if (!testKeyPair) {
      testKeyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    }
    return testKeyPair;
  }

  throw new Error('QR_AUTHORITY_PRIVATE_KEY_BASE64 is required');
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        result[key] = normalize((value as Record<string, unknown>)[key]);
        return result;
      }, {});
  }
  return value;
}

export function canonicalize(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function authorityPublicKeyBase64(): string {
  return authorityKeys().publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
}

export function credentialVersion(assignments: CredentialAssignment[]): string {
  return crypto.createHash('sha256').update(canonicalize(assignments)).digest('hex');
}

export function issueAuthorityCredential(
  payload: Omit<AuthorityCredentialPayload, 'version'>
): AuthorityCredential {
  const versioned: AuthorityCredentialPayload = { version: QR_PROTOCOL_VERSION, ...payload };
  const signature = crypto.sign(
    'sha256',
    Buffer.from(canonicalize(versioned)),
    authorityKeys().privateKey
  );
  return {
    payload: versioned,
    authority_signature: signature.toString('base64'),
    authority_public_key: authorityPublicKeyBase64(),
  };
}

export interface PresentationValidation {
  valid: boolean;
  reason?: string;
  presentation?: QrPresentation;
}

export function verifyPresentation(
  encoded: string,
  expectedEventId: number,
  now = Date.now()
): PresentationValidation {
  let presentation: QrPresentation;
  try {
    presentation = JSON.parse(encoded) as QrPresentation;
  } catch {
    return { valid: false, reason: 'Invalid QR code format' };
  }

  const payload = presentation?.payload;
  const credential = payload?.credential;
  if (
    !payload ||
    payload.version !== QR_PROTOCOL_VERSION ||
    !credential?.payload ||
    credential.payload.version !== QR_PROTOCOL_VERSION ||
    !credential.authority_signature ||
    !presentation.device_signature
  ) {
    return { valid: false, reason: 'Unsupported or incomplete QR credential' };
  }

  if (credential.payload.event_id !== expectedEventId) {
    return { valid: false, reason: 'QR credential belongs to a different event' };
  }

  if (
    credential.payload.issued_at > now + QR_CLOCK_SKEW_MS ||
    credential.payload.expires_at < now - QR_CLOCK_SKEW_MS
  ) {
    return { valid: false, reason: 'Credential expired or not yet valid' };
  }

  if (
    payload.issued_at > now + QR_CLOCK_SKEW_MS ||
    payload.expires_at < now - QR_CLOCK_SKEW_MS ||
    payload.expires_at - payload.issued_at > QR_PRESENTATION_TTL_MS
  ) {
    return { valid: false, reason: 'QR presentation expired or invalid' };
  }

  try {
    const authorityKey = crypto.createPublicKey({
      key: Buffer.from(credential.authority_public_key, 'base64'),
      format: 'der',
      type: 'spki',
    });
    const authorityValid = crypto.verify(
      'sha256',
      Buffer.from(canonicalize(credential.payload)),
      authorityKey,
      Buffer.from(credential.authority_signature, 'base64')
    );
    if (!authorityValid) return { valid: false, reason: 'Authority signature invalid' };

    const deviceKey = crypto.createPublicKey({
      key: Buffer.from(credential.payload.device_public_key, 'base64'),
      format: 'der',
      type: 'spki',
    });
    const deviceValid = crypto.verify(
      'sha256',
      Buffer.from(canonicalize(payload)),
      deviceKey,
      Buffer.from(presentation.device_signature, 'base64')
    );
    if (!deviceValid) return { valid: false, reason: 'Device presentation signature invalid' };
  } catch {
    return { valid: false, reason: 'Invalid QR signing key or signature' };
  }

  return { valid: true, presentation };
}

export function createTestDeviceKeyPair(): {
  privateKey: KeyObject;
  publicKeyBase64: string;
} {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    privateKey: pair.privateKey,
    publicKeyBase64: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
}

export function signTestPresentation(
  payload: PresentationPayload,
  privateKey: KeyObject
): QrPresentation {
  return {
    payload,
    device_signature: crypto
      .sign('sha256', Buffer.from(canonicalize(payload)), privateKey)
      .toString('base64'),
  };
}
