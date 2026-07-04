import { describe, it, expect } from 'vitest';
import { harvestDropReason } from '../src/surfaces/proactive.js';

const base = { subtype: undefined, botId: undefined, channelId: 'C1', watchedChannels: ['C1'], recentHarvestCount: 0, text: 'We served 42 kids this month and attendance improved a lot, according to our tracker.' };

describe('harvestDropReason (guard chain)', () => {
  it('proceeds on a real evidence-shaped message', () => {
    expect(harvestDropReason(base)).toBeNull();
  });
  it('drops bot/subtype messages', () => {
    expect(harvestDropReason({ ...base, botId: 'B1' })).toBe('subtype_or_bot');
    expect(harvestDropReason({ ...base, subtype: 'message_changed' })).toBe('subtype_or_bot');
  });
  it('drops messages outside watched channels', () => {
    expect(harvestDropReason({ ...base, channelId: 'C2' })).toBe('not_watched');
  });
  it('throttles after 2 harvests in the same channel same day', () => {
    expect(harvestDropReason({ ...base, recentHarvestCount: 2 })).toBe('throttled');
  });
  it('drops non-evidence-shaped chatter', () => {
    expect(harvestDropReason({ ...base, text: 'anyone free for a call at 3pm?' })).toBe('not_evidence_shaped');
  });
  it('drops short messages', () => {
    expect(harvestDropReason({ ...base, text: 'thanks so much!' })).toBe('too_short');
  });
  it('drops messages with neither a number nor a quote', () => {
    expect(harvestDropReason({ ...base, text: 'Our program improved outcomes and increased engagement across the board this season' })).toBe('no_number_or_quote');
  });
});
