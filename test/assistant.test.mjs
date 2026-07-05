import { describe, it, expect } from 'vitest';
import { buildSuggestedPrompts } from '../src/assistant.js';

describe('buildSuggestedPrompts', () => {
  it('returns the setup-flavored set when no org exists', () => {
    const prompts = buildSuggestedPrompts({ org: null, pipeline: [] });
    expect(prompts).toHaveLength(4);
    expect(prompts[0].title).toBe('Set up my organization');
  });

  it('returns the default four for an org with an empty pipeline', () => {
    const prompts = buildSuggestedPrompts({ org: { mission: 'x' }, pipeline: [] });
    expect(prompts.map((p) => p.title)).toEqual(['Find matching grants', 'Gather impact evidence', "What's due soon?", 'Draft an LOI']);
  });

  it('swaps in the active-draft prompt when a drafting opportunity exists', () => {
    const prompts = buildSuggestedPrompts({ org: { mission: 'x' }, pipeline: [{ stage: 'drafting' }] });
    expect(prompts.map((p) => p.title)).toContain('What changed in my drafts?');
    expect(prompts.map((p) => p.title)).not.toContain('Draft an LOI');
  });

  it('leads with the deadline-week prompt when something closes within 7 days', () => {
    const soon = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const prompts = buildSuggestedPrompts({ org: { mission: 'x' }, pipeline: [{ stage: 'reviewing', close_date: soon }] });
    expect(prompts[0].title).toBe("What's due this week?");
  });

  it('caps at 4 prompts even with both extras active', () => {
    const soon = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const prompts = buildSuggestedPrompts({ org: { mission: 'x' }, pipeline: [{ stage: 'drafting', close_date: soon }] });
    expect(prompts).toHaveLength(4);
  });

  it('prioritizes current-channel prompt when active Slack context is known', () => {
    const prompts = buildSuggestedPrompts({ org: { mission: 'x' }, pipeline: [], activeContext: { contextChannelId: 'C123' } });
    expect(prompts[0].title).toBe('Use current channel');
    expect(prompts).toHaveLength(4);
  });
});
