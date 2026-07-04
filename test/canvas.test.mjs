import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/services/db.js', () => ({
  db: {
    setCanvasId: vi.fn(async () => {}),
    logActivity: vi.fn(async () => {}),
    listActivity: vi.fn(async () => [{ at: new Date('2026-07-01T00:00:00Z'), summary: 'Added to pipeline' }]),
  },
}));

const { sanitizeCanvasMarkdown, ensureOppCanvas, editSections, appendActivity, skeletonMarkdown } = await import('../src/services/canvas.js');
const { db } = await import('../src/services/db.js');

function fakeClient({ sectionId = 'SEC1' } = {}) {
  const calls = [];
  return {
    calls,
    apiCall: vi.fn(async (method, args) => {
      calls.push([method, args]);
      if (method === 'canvases.create') return { canvas_id: 'F1' };
      if (method === 'canvases.access.set') return { ok: true };
      if (method === 'canvases.sections.lookup') return { sections: [{ id: sectionId }] };
      if (method === 'canvases.edit') return { ok: true };
      return { ok: true };
    }),
    team: { info: vi.fn(async () => ({ team: { domain: 'riverbend', id: 'T1' } })) },
  };
}

describe('sanitizeCanvasMarkdown', () => {
  it('collapses heading levels deeper than 3 to h3', () => {
    const out = sanitizeCanvasMarkdown('#### Too deep\n##### Even deeper\n### Fine');
    expect(out).toContain('### Too deep');
    expect(out).toContain('### Even deeper');
    expect(out).toContain('### Fine');
    expect(out).not.toMatch(/^#{4,}/m);
  });

  it('preserves ordinary spacing and links', () => {
    const md = '# Title\n\nSome text with a [source](https://x.slack.com/archives/C1/p1) link.';
    const out = sanitizeCanvasMarkdown(md);
    expect(out).toContain('Some text with a [source](https://x.slack.com/archives/C1/p1) link.');
  });

  it('trims leading/trailing whitespace', () => {
    expect(sanitizeCanvasMarkdown('\n\n  # Title  \n\n')).toBe('# Title');
  });

  it('strips a leading H1 unconditionally — Slack renders the canvas title as its own H1', () => {
    const md = '# Letter of Intent: OJJDP\n\nDear Program Officer,...';
    const out = sanitizeCanvasMarkdown(md);
    expect(out).not.toMatch(/^#\s+Letter of Intent/);
    expect(out.startsWith('Dear Program Officer')).toBe(true);
  });

  it('strips a leading H1 even when its wording differs from the title (live-observed case)', () => {
    const md = '# Letter of Intent — Riverside Foundation LOI — Youth Mentorship\n\n**Funder:** Riverside Foundation...';
    const out = sanitizeCanvasMarkdown(md);
    expect(out.startsWith('**Funder:**')).toBe(true);
  });
});

describe('skeletonMarkdown', () => {
  it('creates exactly the 5 contract H2 sections, in order', () => {
    const md = skeletonMarkdown({ opp_id: '1', title: 'Test Grant', agency: 'ACYF', close_date: '2026-08-01', award_ceiling: 50000 });
    const headings = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual(['Overview', 'Requirements', 'Draft', 'Evidence', 'Activity']);
    expect(md).toContain('ACYF');
    expect(md).toContain('Not started');
  });
});

describe('ensureOppCanvas', () => {
  it('creates a new canvas once and sets canvas_id WITHOUT bumping stage', async () => {
    const client = fakeClient();
    const { canvasId, canvasUrl } = await ensureOppCanvas(client, 'T1', { opp_id: '1', title: 'Test Grant' });
    expect(canvasId).toBe('F1');
    expect(canvasUrl).toContain('F1');
    expect(db.setCanvasId).toHaveBeenCalledWith('T1', '1', 'F1');
    expect(client.calls.some(([m]) => m === 'canvases.create')).toBe(true);
  });

  it('returns the SAME canvas on a second call — never creates a second document', async () => {
    const client = fakeClient();
    const result = await ensureOppCanvas(client, 'T1', { opp_id: '1', title: 'Test Grant', canvas_id: 'EXISTING' });
    expect(result.canvasId).toBe('EXISTING');
    expect(client.calls.some(([m]) => m === 'canvases.create')).toBe(false);
  });
});

describe('editSections', () => {
  it('batches multiple section replacements into ONE canvases.edit call', async () => {
    const client = fakeClient();
    const ok = await editSections(client, 'F1', { Draft: 'new draft body', Evidence: '- [a](url)' });
    expect(ok).toBe(true);
    const editCalls = client.calls.filter(([m]) => m === 'canvases.edit');
    expect(editCalls).toHaveLength(1);
    expect(editCalls[0][1].changes).toHaveLength(2);
  });

  it('skips headings that fail to resolve a section id rather than throwing', async () => {
    const client = { apiCall: vi.fn(async (method) => {
      if (method === 'canvases.sections.lookup') return { sections: [] };
      return { ok: true };
    }) };
    const ok = await editSections(client, 'F1', { Draft: 'x' });
    expect(ok).toBe(false);
  });
});

describe('appendActivity', () => {
  it('replaces the Activity section from the DB activity trail', async () => {
    const client = fakeClient();
    await appendActivity(client, 'F1', 'T1', '1');
    const editCall = client.calls.find(([m]) => m === 'canvases.edit');
    expect(editCall[1].changes[0].document_content.markdown).toContain('Added to pipeline');
  });
});
