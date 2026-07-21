export function configuredCorsOrigins(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    (env.CORS_ORIGINS || '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
  );
}

export function isCorsOriginAllowed(
  origin: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  // Native applications and server-to-server requests do not send Origin.
  if (!origin) return true;

  if (configuredCorsOrigins(env).has(origin)) return true;
  if (env.NODE_ENV === 'production') return false;

  try {
    const url = new URL(origin);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
    );
  } catch {
    return false;
  }
}
