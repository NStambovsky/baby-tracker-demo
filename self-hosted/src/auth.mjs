import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'baby_tracker_session';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export function verifyPassword(password, env = process.env) {
  const expected = env.APP_PASSWORD || '';
  if (!expected || expected === 'change-me-before-deploy') return false;
  return safeEqual(String(password || ''), expected);
}

export function createSessionCookie(env = process.env) {
  const secret = requireSecret(env);
  const payload = Buffer.from(JSON.stringify({
    id: randomBytes(12).toString('hex'),
    exp: Date.now() + MAX_AGE_SECONDS * 1000
  })).toString('base64url');
  const signature = sign(payload, secret);
  const secure = env.NODE_ENV === 'production' ? '; Secure' : '';

  return `${COOKIE_NAME}=${payload}.${signature}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_SECONDS}${secure}`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

export function isAuthenticated(cookieHeader = '', env = process.env) {
  const secret = requireSecret(env);
  const cookies = parseCookies(cookieHeader);
  const value = cookies[COOKIE_NAME];
  if (!value || !value.includes('.')) return false;

  const [payload, signature] = value.split('.');
  if (!safeEqual(sign(payload, secret), signature)) return false;

  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number(session.exp) > Date.now();
  } catch {
    return false;
  }
}

function requireSecret(env) {
  const secret = env.SESSION_SECRET || '';
  if (!secret || secret === 'replace-with-a-long-random-string') {
    throw new Error('Set SESSION_SECRET before starting the app');
  }
  return secret;
}

function sign(value, secret) {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function parseCookies(header) {
  return Object.fromEntries(
    String(header || '')
      .split(';')
      .map((part) => part.trim().split('='))
      .filter(([key, value]) => key && value)
  );
}
