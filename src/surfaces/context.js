import { db } from '../services/db.js';

export function normalizeAppContext(payload = {}) {
  const context = payload.app_context ?? payload.context ?? {};
  const entities = context?.entities ?? payload.entities ?? [];
  return { context, entities: Array.isArray(entities) ? entities : [] };
}

export function extractActiveContext(input = {}) {
  const { context = {}, entities = [] } = normalizeAppContext(input);
  const all = [...entities, ...(Array.isArray(context.entities) ? context.entities : [])];
  const findId = (pred) => {
    const entity = all.find(pred);
    return entity?.channel_id ?? entity?.channelId ?? entity?.id ?? entity?.entity_id ?? null;
  };
  return {
    raw: context,
    entities: all,
    contextChannelId: findId((e) => /channel/.test(String(e.type ?? e.entity_type ?? '').toLowerCase()) || e.channel_id || e.channelId),
    contextCanvasId: findId((e) => /canvas|file|doc/.test(String(e.type ?? e.entity_type ?? '').toLowerCase())),
    contextListId: findId((e) => /list/.test(String(e.type ?? e.entity_type ?? '').toLowerCase())),
  };
}

export async function resolveActiveContext({ teamId, userId, eventContext }) {
  const fresh = eventContext ? extractActiveContext(eventContext) : null;
  if (teamId && userId && eventContext) {
    await db.upsertActiveContext(teamId, userId, { context: fresh.raw ?? {}, entities: fresh.entities ?? [] });
  }
  if (fresh?.contextChannelId || fresh?.contextCanvasId || fresh?.contextListId || fresh?.entities?.length) return fresh;
  const stored = teamId && userId ? await db.getActiveContext(teamId, userId) : null;
  return stored ? extractActiveContext({ context: stored.context, entities: stored.entities }) : extractActiveContext({});
}

export function registerContext(app) {
  app.event('app_context_changed', async ({ event, context }) => {
    const teamId = event.team ?? context.teamId;
    const userId = event.user;
    if (!teamId || !userId) return;
    const active = normalizeAppContext(event);
    await db.upsertActiveContext(teamId, userId, active);
  });
}

