import { describe, it, expect } from 'vitest';
import { grantCard, evidenceCard, helpBlocks, buildFeedbackBlocks } from '../src/surfaces/blocks.js';

const allButtons = (blocks) => JSON.stringify(blocks).match(/"type":"button"/g)?.length ?? 0;
const allLabels = (blocks) => JSON.stringify(blocks).match(/accessibility_label/g)?.length ?? 0;

describe('blocks', () => {
  it('all buttons carry accessibility labels', () => {
    for (const b of [
      grantCard({ opp_id: '1', title: 'T', url: 'https://x' }),
      evidenceCard({ channel_id: 'C', snippet: 's', tag: 'story', message_ts: '1' }),
    ]) {
      expect(allLabels(b)).toBeGreaterThanOrEqual(allButtons(b));
    }
  });

  it('helpBlocks and buildFeedbackBlocks render without throwing', () => {
    expect(helpBlocks().length).toBeGreaterThan(0);
    expect(buildFeedbackBlocks().length).toBeGreaterThan(0);
  });
});
