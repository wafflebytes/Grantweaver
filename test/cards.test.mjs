import { describe, it, expect } from 'vitest';
import {
  grantCardV2, forecastCard, pipelineCard, draftCard, evidenceCardV2,
  deadlineCard, confirmCard, scanSummaryCard, updateRequestCard, shareCard,
} from '../src/surfaces/cards.js';

// Minimal structural validation: every card is a non-empty array of blocks,
// every block has a `type`, and every card carries at least
// one action.
function assertValidBlocks(blocks) {
  expect(Array.isArray(blocks)).toBe(true);
  expect(blocks.length).toBeGreaterThan(0);
  for (const b of blocks) {
    expect(typeof b.type).toBe('string');
    if (b.type === 'actions') expect(b.elements.length).toBeGreaterThan(0);
  }
}

const opp = { opp_id: '123', title: 'Youth Mentoring Grant', agency: 'HHS', close_date: '2026-12-01', award_ceiling: 50000, stage: 'reviewing', checklist: [{ id: 'a', label: 'Narrative', done: true }, { id: 'b', label: 'Budget', done: false }] };

describe('cards.js builders', () => {
  it('grantCardV2 renders with a primary action and no eligibility badge when unknown', () => {
    const blocks = grantCardV2(opp);
    assertValidBlocks(blocks);
    expect(JSON.stringify(blocks)).not.toContain('Eligible');
  });

  it('grantCardV2 renders the eligibility badge when a fit verdict exists', () => {
    const blocks = grantCardV2(opp, { fit: { fit_score: 80, fit_rationale: 'strong match', eligibility_verdict: 'eligible', eligibility_reason: '501(c)(3)s may apply' } });
    assertValidBlocks(blocks);
    expect(JSON.stringify(blocks)).toContain('Eligible');
    expect(JSON.stringify(blocks)).toContain('Fit 80/100');
  });

  it('forecastCard has Watch as the primary action', () => {
    const blocks = forecastCard(opp);
    assertValidBlocks(blocks);
    const actions = blocks.find((b) => b.type === 'actions');
    expect(actions.elements[0].action_id).toBe('gw:grant:watch');
  });

  it('pipelineCard renders owner/checklist line and a stage select', () => {
    const blocks = pipelineCard(opp);
    assertValidBlocks(blocks);
    expect(JSON.stringify(blocks)).toContain('Checklist 1/2');
    const actions = blocks.find((b) => b.type === 'actions');
    expect(actions.elements.some((e) => e.type === 'static_select')).toBe(true);
  });

  it('draftCard links the canvas and shows citation/checklist counts', () => {
    const blocks = draftCard({ opp, canvasUrl: 'https://example.slack.com/docs/T1/F1', citations: 3, checklistDone: 1, checklistTotal: 2 });
    assertValidBlocks(blocks);
    expect(JSON.stringify(blocks)).toContain('3 cited sources');
  });

  it('evidenceCardV2 offers a link-to-opportunity select only when pipeline items are given', () => {
    const ev = { channel_id: 'C1', message_ts: '1.1', tag: 'story', date: '2026-01-01', snippet: 'great outcome', author: 'Maya', permalink: 'https://x' };
    const noPipeline = evidenceCardV2(ev);
    const withPipeline = evidenceCardV2(ev, { pipeline: [opp] });
    assertValidBlocks(noPipeline);
    assertValidBlocks(withPipeline);
    const hasSelect = (blocks) => blocks.some((b) => b.type === 'actions' && b.elements.some((e) => e.action_id === 'gw:ev:link'));
    expect(hasSelect(noPipeline)).toBe(false);
    expect(hasSelect(withPipeline)).toBe(true);
  });

  it('deadlineCard escalates the badge as days shrink', () => {
    expect(JSON.stringify(deadlineCard(opp, 2))).toContain('🔴');
    expect(JSON.stringify(deadlineCard(opp, 30))).toContain('🟢');
  });

  it('confirmCard carries the intent id through all three action values', () => {
    const blocks = confirmCard({ id: 42, kind: 'draft' }, { summary: 'test', etaSeconds: 10 });
    assertValidBlocks(blocks);
    const actions = blocks.find((b) => b.type === 'actions');
    for (const el of actions.elements) expect(JSON.parse(el.value)).toEqual({ i: 42 });
  });

  it('scanSummaryCard and updateRequestCard and shareCard all render valid blocks', () => {
    assertValidBlocks(scanSummaryCard({ index: [{ theme: 'attendance', channel_id: 'C1', hits: 3 }], webUrl: 'https://x/org/tok' }));
    assertValidBlocks(updateRequestCard(opp));
    assertValidBlocks(shareCard({ title: opp.title, agency: opp.agency, url: 'https://grants.gov/x', sharedBy: 'U1' }));
  });
});
