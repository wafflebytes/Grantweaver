// TEMPORARY STUB (T1.3) — makes the assistant surface fully testable before
// the real agent engine (T2.1, docs/05 §1) replaces this file. Canned reply
// only; no LLM call, no tools.
import { buildFeedbackBlocks } from '../surfaces/blocks.js';

export async function runAgentTurn(ctx) {
  const reply = `Thanks for the message! 🧶 I'm still being woven together — the real grant-finding, evidence-gathering, and drafting brain lands soon. For now, here's an echo so you can see the panel working: _"${(ctx.userText ?? '').slice(0, 200)}"_`;

  const streamer = ctx.makeStreamer();
  for (const chunk of chunkMarkdown(reply, 400)) {
    await streamer.append({ markdown_text: chunk });
  }
  await streamer.stop({ blocks: buildFeedbackBlocks() });

  return { title: inferTitle(ctx.userText), toolCalls: 0 };
}

export function chunkMarkdown(text, size) {
  const out = []; let buf = '';
  for (const line of text.split('\n')) {
    if (buf && (buf + line).length > size) { out.push(buf); buf = ''; }
    buf += line + '\n';
  }
  if (buf.trim()) out.push(buf);
  return out.length ? out : [text];
}

export function inferTitle(text) {
  const t = (text ?? '').trim().replace(/\s+/g, ' ');
  return t.length > 48 ? `${t.slice(0, 45)}…` : t || 'Grantweaver chat';
}
