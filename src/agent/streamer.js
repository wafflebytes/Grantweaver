// Both streamers expose { append, stop, task } — runAgentTurn stays
// surface-blind. task() is progress texture: real task_update chunks in
// threads (live-verified shape — flat, not nested), a plain
// italic line in the DM (agent_view sayStream has no task-chunk concept).
let taskSeq = 0;

export function makeDmStreamer({ sayStream, setStatus }) {
  const s = sayStream();
  return {
    append: (p) => s.append(p),
    stop: (p) => s.stop(p),
    // DM streamer has no task-chunk concept, so per-tool-call progress can't
    // be a real in-place task line the way the thread streamer gets one.
    // It used to fake it by appending a permanent "_label…_" line to the
    // transcript on every call — with a multi-tool-call turn (e.g. two
    // search_workspace calls) that reads as the SAME status stuck on screen
    // forever, not as progress (live-reported: 5 stacked "Searching your
    // workspace…" lines in one reply). Slack's native ephemeral loading
    // status (setStatus, already used for the "Weaving…" placeholder) is
    // the actual dynamic-status primitive — route real per-tool labels
    // through it instead so they update in place and clear on their own.
    task: (label, status = 'in_progress', id = null) => {
      if (status === 'in_progress' && setStatus) setStatus({ status: `${label}…` }).catch(() => {});
      return Promise.resolve(id);
    },
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
      // Once the stream carries task_update chunks, plain markdown must ALSO
      // arrive as a chunk — mixing the top-level markdown_text param with
      // chunk appends on one stream fails live with streaming_mode_mismatch.
      await client.apiCall('chat.appendStream', {
        channel, ts, chunks: [{ type: 'markdown_text', text: markdown_text }],
      });
    },
    async task(label, status = 'in_progress', id = `t${taskSeq++}`) {
      const { ts } = await ensure();
      // Live-verified shape: task_update chunks are flat, not
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
