import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => { process.env.WEB_LINK_SECRET = 'test-secret-do-not-use-in-prod'; });

const { mintOrgToken, verifyOrgToken } = await import('../src/services/weblink.js');

describe('magic-link tokens', () => {
  it('round-trips a freshly minted token', () => {
    const token = mintOrgToken('T123');
    expect(verifyOrgToken(token)).toEqual({ teamId: 'T123' });
  });

  it('rejects an expired token', () => {
    const token = mintOrgToken('T123', -10); // already expired
    expect(verifyOrgToken(token)).toBeNull();
  });

  it('rejects a tampered token', () => {
    const token = mintOrgToken('T123');
    const tampered = token.slice(0, -2) + 'zz';
    expect(verifyOrgToken(tampered)).toBeNull();
  });

  it('rejects garbage input without throwing', () => {
    expect(verifyOrgToken('not-a-real-token')).toBeNull();
    expect(verifyOrgToken('')).toBeNull();
  });
});
