import { describe, it, expect } from 'vitest';
import { deriveStatePatch, sanitizeStatePatch, stateKey, summarizeForState } from '../src/agent/state.js';

describe('agent state helpers', () => {
  it('uses a blank thread key for agent-view DMs', () => {
    expect(stateKey({ surface: 'dm', teamId: 'T1', channelId: 'D1', threadTs: '123' })).toEqual({ teamId: 'T1', channelId: 'D1', threadTs: '' });
    expect(stateKey({ surface: 'channel', teamId: 'T1', channelId: 'C1', threadTs: '123' })).toEqual({ teamId: 'T1', channelId: 'C1', threadTs: '123' });
  });

  it('removes forbidden raw-content keys from nested source metadata', () => {
    const patch = sanitizeStatePatch({ sources: [{ permalink: 'https://x', snippet: 'do not keep', nested: { text: 'nope' } }] });
    expect(patch.sources[0].permalink).toBe('https://x');
    expect(patch.sources[0].snippet).toBeUndefined();
    expect(patch.sources[0].nested.text).toBeUndefined();
  });

  it('derives pointer-only sources and artifact metadata from tool results', () => {
    const patch = deriveStatePatch({
      ctx: { surface: 'dm', userId: 'U1', userText: 'draft the LOI', messageTs: '1.2' },
      previousState: null,
      finalText: 'Queued.',
      toolNames: ['search_workspace', 'create_draft_canvas'],
      toolResults: [{ results: [{ channel_id: 'C1', message_ts: '2.3', permalink: 'https://slack/archives/C1/p23', snippet: 'raw' }] }, { queued: true }],
    });
    expect(patch.goal).toBe('Draft or revise grant materials');
    expect(patch.sources[0]).toEqual({ channel_id: 'C1', message_ts: '2.3', permalink: 'https://slack/archives/C1/p23', label: 'evidence pointer' });
    expect(patch.artifacts[0].summary).toBe('Posted confirmation card');
  });

  it('keeps summaries bounded', () => {
    expect(summarizeForState({ previous: 'x'.repeat(2000) })).toHaveLength(1500);
  });
});

