import { describe, it, expect, vi } from 'vitest';

let nextResponse = '';
vi.mock('../src/agent/llm.js', () => ({
  completeOnce: vi.fn(async () => nextResponse),
}));

const { assessFitBatch, extractChecklist } = await import('../src/prompts/classifiers.js');

describe('assessFitBatch', () => {
  it('parses a well-formed batch response', async () => {
    nextResponse = '[{"opp_id":"1","fit_score":85,"fit_rationale":"good","eligibility_verdict":"eligible","eligibility_reason":"501c3 listed"}]';
    const out = await assessFitBatch({ mission: 'x' }, [{ opp_id: '1', title: 'Grant' }]);
    expect(out).toEqual([{ opp_id: '1', fit_score: 85, fit_rationale: 'good', eligibility_verdict: 'eligible', eligibility_reason: '501c3 listed' }]);
  });

  it('degrades to an empty array on malformed JSON — never throws', async () => {
    nextResponse = 'not json at all, sorry';
    const out = await assessFitBatch({ mission: 'x' }, [{ opp_id: '1', title: 'Grant' }]);
    expect(out).toEqual([]);
  });

  it('returns [] immediately for an empty opp list (no LLM call needed)', async () => {
    const out = await assessFitBatch({ mission: 'x' }, []);
    expect(out).toEqual([]);
  });
});

describe('extractChecklist', () => {
  it('parses items and always injects sam_uei for federal notices', async () => {
    nextResponse = '[{"id":"narrative","label":"Project narrative","kind":"document","detail":"max 10 pages"}]';
    const out = await extractChecklist({ title: 'Test Notice', synopsis: 'text' });
    expect(out.find((i) => i.id === 'narrative')).toBeTruthy();
    expect(out.find((i) => i.id === 'sam_uei')).toBeTruthy();
  });

  it('does not duplicate sam_uei when the model already included it', async () => {
    nextResponse = '[{"id":"sam_uei","label":"SAM/UEI","kind":"registration"}]';
    const out = await extractChecklist({ title: 'Test Notice', synopsis: 'text' });
    expect(out.filter((i) => i.id === 'sam_uei')).toHaveLength(1);
  });

  it('degrades to an empty array on malformed JSON', async () => {
    nextResponse = 'garbage';
    const out = await extractChecklist({ title: 'Test Notice', synopsis: 'text' });
    expect(out).toEqual([]);
  });
});
