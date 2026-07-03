// TEMPORARY STUB (T2.1) — lets create_draft_canvas exercise the full agent
// loop (citation counting, pipeline stage flip, draftReadyBlocks) before the
// real Canvas API integration lands in T3.1. Returns a fake but stable URL
// shape so downstream rendering/tests don't need to change when T3.1 replaces
// this file.
export async function createDraftCanvas(_client, { title, channelId }) {
  const canvasId = `stub-${channelId}-${Date.now()}`;
  return { canvasId, canvasUrl: `https://app.slack.com/canvas-stub/${canvasId}` };
}

/** Canvas markdown is stricter than GitHub-flavored — normalize the common gaps. */
export function sanitizeCanvasMarkdown(md) {
  return String(md)
    .replace(/^(#{4,})\s/gm, '### ')      // canvases: max 3 heading levels
    .trim();
}
