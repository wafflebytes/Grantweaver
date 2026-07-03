// Both streamers expose { append, stop, task } — runAgentTurn stays
// surface-blind. task() is progress texture: real task_update chunks in
// threads (docs/12 §5 — live-verified shape, flat not nested), a plain
// italic line in the DM (agent_view sayStream has no task-chunk concept).
let taskSeq = 0;

export function makeDmStreamer({ sayStream }) {
  const s = sayStream();
  return {
    append: (p) => s.append(p),
    stop: (p) => s.stop(p),
    // DM streamer has no task-chunk concept — only the "started" line reads
    // as texture; a second "complete" call would just be visual noise.
    task: (label, status = 'in_progress', id = null) =>
      status === 'in_progress' ? s.append({ markdown_text: `_${label}…_\n` }).then(() => id) : Promise.resolve(id),
  };
}

export function makeThreadStreamer({ client, channel, thread_ts, userId, teamId }) {
  let started = null; // { ts } from chat.startStream
  const ensure = async () => {
    if (started) return started;
    started = await client.apiCall('chat.startStream', {
      channel, thread_ts,
      recipient_user_id: userId, recipient_team_id: teamId,
      task_display_mode: 'timeline',
    });
    return started;
  };
  return {
    async append({ markdown_text }) {
      const { ts } = await ensure();
      await client.apiCall('chat.appendStream', { channel, ts, markdown_text });
    },
    async task(label, status = 'in_progress', id = `t${taskSeq++}`) {
      const { ts } = await ensure();
      // Live-verified shape (docs/12 §5): task_update chunks are flat, not
      // nested — id/title/status live at the top level of the chunk object.
      // Passing the same id back updates that task's status line instead of
      // adding a new one. Best-effort: task texture must never fail a turn.
      await client.apiCall('chat.appendStream', {
        channel, ts, chunks: [{ type: 'task_update', id, title: label, status }],
      }).catch(() => {});
      return id;
    },
    async stop({ blocks } = {}) {
      if (!started) { // model produced no text (tools-only turn) — post something
        await client.chat.postMessage({ channel, thread_ts, text: 'Done 🧶', ...(blocks ? { blocks } : {}) });
        return;
      }
      await client.apiCall('chat.stopStream', { channel, ts: started.ts, ...(blocks ? { blocks } : {}) });
    },
  };
}
