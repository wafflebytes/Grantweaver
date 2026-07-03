import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => { process.env.APP_BASE_URL = 'https://grantweaver.up.railway.app'; });

const { parseOrgToken } = await import('../src/surfaces/unfurl.js');

describe('parseOrgToken', () => {
  it('extracts the token from a matching /org/{token} URL', () => {
    expect(parseOrgToken('https://grantweaver.up.railway.app/org/abc123')).toBe('abc123');
    expect(parseOrgToken('https://grantweaver.up.railway.app/org/abc123/')).toBe('abc123');
  });

  it('returns null for a foreign domain — we only unfurl our own (docs/22 §7)', () => {
    expect(parseOrgToken('https://grants.gov/org/abc123')).toBeNull();
  });

  it('returns null for an unknown path on our own domain', () => {
    expect(parseOrgToken('https://grantweaver.up.railway.app/privacy.html')).toBeNull();
  });

  it('returns null for a malformed URL without throwing', () => {
    expect(parseOrgToken('not a url')).toBeNull();
  });
});
