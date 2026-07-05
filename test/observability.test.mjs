import { describe, it, expect } from 'vitest';
import { classifyError, estimateCostUsd, sanitizeErrorMessage } from '../src/services/observability.js';

describe('observability helpers', () => {
  it('leaves unknown model costs null unless pricing is configured', () => {
    expect(estimateCostUsd('minimax-2.7', 1000, 1000)).toBeNull();
  });

  it('classifies common error families', () => {
    expect(classifyError(new Error('request timeout'))).toBe('timeout');
    expect(classifyError({ data: { error: 'channel_not_found' } })).toBe('slack_api_error');
  });

  it('sanitizes Slack archive URLs and user mentions', () => {
    expect(sanitizeErrorMessage(new Error('bad https://x.slack.com/archives/C1/p123 from <@U1>'))).toContain('[slack-link]');
    expect(sanitizeErrorMessage(new Error('bad https://x.slack.com/archives/C1/p123 from <@U1>'))).toContain('<@user>');
  });
});

