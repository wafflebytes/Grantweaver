// Stateless HMAC magic links (docs/22 §6) — no sessions, no accounts. Anyone
// holding the URL for the token's 7-day window can view the org's read-only
// evidence-index page (WS-P6); Class-A guard still applies to what the page
// renders (org-approved theme labels/counts, never message content).
import { createHmac, timingSafeEqual } from 'node:crypto';

const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;

function sign(teamId, expiry) {
  const secret = process.env.WEB_LINK_SECRET;
  if (!secret) throw new Error('WEB_LINK_SECRET is not set');
  return createHmac('sha256', secret).update(`${teamId}.${expiry}`).digest('base64url');
}

export function mintOrgToken(teamId, ttlSeconds = SEVEN_DAYS_SECONDS) {
  const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = sign(teamId, expiry);
  return Buffer.from(`${teamId}.${expiry}.${sig}`, 'utf8').toString('base64url');
}

export function orgLinkUrl(teamId) {
  const base = process.env.APP_BASE_URL ?? '';
  return `${base}/org/${mintOrgToken(teamId)}`;
}

/** Returns { teamId } on a valid, unexpired token, or null. Never throws. */
export function verifyOrgToken(token) {
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const [teamId, expiryStr, sig] = decoded.split('.');
    if (!teamId || !expiryStr || !sig) return null;
    const expiry = Number(expiryStr);
    if (!Number.isFinite(expiry) || expiry < Math.floor(Date.now() / 1000)) return null;
    const expected = sign(teamId, expiry);
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return { teamId };
  } catch {
    return null;
  }
}
