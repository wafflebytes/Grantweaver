import { describe, it, expect } from 'vitest';
import { extractActiveContext, normalizeAppContext } from '../src/surfaces/context.js';

describe('active Slack context helpers', () => {
  it('preserves entity order and extracts channel/canvas/list ids', () => {
    const active = extractActiveContext({
      context: {},
      entities: [
        { type: 'channel_id', channel_id: 'C123' },
        { type: 'canvas', id: 'F456' },
        { type: 'list', id: 'L789' },
      ],
    });
    expect(active.entities.map((e) => e.id ?? e.channel_id)).toEqual(['C123', 'F456', 'L789']);
    expect(active.contextChannelId).toBe('C123');
    expect(active.contextCanvasId).toBe('F456');
    expect(active.contextListId).toBe('L789');
  });

  it('normalizes empty context without deleting the record shape', () => {
    expect(normalizeAppContext({})).toEqual({ context: {}, entities: [] });
  });
});

