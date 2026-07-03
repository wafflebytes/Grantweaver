export async function createDraftCanvas(client, { title, markdown, channelId, userId }) {
  const safeMarkdown = sanitizeCanvasMarkdown(markdown);
  const created = await client.apiCall('canvases.create', {
    title,
    document_content: { type: 'markdown', markdown: safeMarkdown },
  });
  const canvasId = created.canvas_id;

  // canvases.access.set's channel_ids only accepts real channels (C…) — under
  // agent_view every conversation is a DM (D…), which the API rejects
  // (invalid_arguments), so grant access to the user directly in that case.
  const isChannel = /^[C]/.test(channelId ?? '');
  await client.apiCall('canvases.access.set', {
    canvas_id: canvasId,
    access_level: 'write',
    ...(isChannel ? { channel_ids: [channelId] } : { user_ids: [userId] }),
  }).catch((e) => console.warn('[canvas:access]', e?.data?.error ?? e.message));

  const team = await client.team.info();
  const canvasUrl = `https://app.slack.com/docs/${team.team.id}/${canvasId}`;
  return { canvasId, canvasUrl };
}

/** Canvas markdown is stricter than GitHub-flavored — normalize the common gaps. */
export function sanitizeCanvasMarkdown(md) {
  return String(md)
    .replace(/^(#{4,})\s/gm, '### ')      // canvases: max 3 heading levels
    .trim();
}
