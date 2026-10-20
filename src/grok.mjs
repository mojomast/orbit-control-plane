import { normalizeGrokPayload } from './approvals.mjs';
import { scrub } from './redact.mjs';

const READS = new Set(['agents', 'history', 'sessions', 'activity', 'describe', 'prefs']);

function isRead(body) {
  if (READS.has(body?.action)) return true;
  if (body?.action === 'groups' && ['list', 'state'].includes(body.op)) return true;
  return false;
}

function cacheKey(body) {
  if (body.action === 'agents') return 'roster';
  if (body.action === 'groups' && body.op === 'list') return 'groups';
  if (body.action === 'groups' && body.op === 'state') return `group:${body.group}`;
  if (body.action === 'activity') return `activity:${body.profile || ''}:${body.agent || ''}`;
  if (body.action === 'history') return `history:${body.profile || ''}:${body.agent || body.session || ''}`;
  if (body.action === 'describe') return `describe:${body.profile || ''}`;
  return null;
}

export async function handleGrok({ store, hub, body, actor, secrets, demo }) {
  const cleanBody = scrub(body, secrets);
  if (hub.connected) {
    try {
      const data = normalizeGrokPayload(scrub(await hub.rpc({ action: 'grokbots', body: cleanBody }, 25_000), secrets));
      const key = cacheKey(cleanBody);
      if (key && data) store.saveGrok({ [key]: data });
      return { data, cached: false, connector: true };
    } catch (error) {
      if (!isRead(cleanBody) || error.status === 504) {
        if (error.status !== 503) throw error;
      }
    }
  }
  if (isRead(cleanBody)) {
    const key = cacheKey(cleanBody);
    const cached = key ? store.readGrok(key) : null;
    if (cached?.data) return { data: cached.data, cached: true, connector: hub.connected, updatedAt: cached.updatedAt };
    const bundle = store.readGrok('bundle');
    if (bundle?.data) {
      const picked = pickBundle(bundle.data, cleanBody);
      if (picked) return { data: picked, cached: true, connector: hub.connected, updatedAt: bundle.updatedAt };
    }
  }
  const intent = store.enqueueIntent('grok.action', { body: cleanBody, actor }, actor);
  if (demo) rememberDemoSend(store, cleanBody);
  return { queued: true, intentId: intent.id, connector: hub.connected, data: null };
}

function pickBundle(bundle, body) {
  if (body.action === 'agents') return bundle.roster || null;
  if (body.action === 'groups' && body.op === 'list') return bundle.groups || null;
  if (body.action === 'groups' && body.op === 'state') return bundle.conversations?.[`group:${body.group}`] || null;
  if (body.action === 'history') return bundle.conversations?.[`history:${body.profile}:${body.agent || body.session || ''}`] || null;
  if (body.action === 'activity') return bundle.activity || null;
  if (body.action === 'describe') return bundle.describe || null;
  return null;
}

function rememberDemoSend(store, body) {
  if (body.action !== 'groups' || body.op !== 'post') return;
  const key = `group:${body.group}`;
  const existing = store.readGrok(key) || store.readGrok('bundle');
  const room = existing?.data?.room || existing?.data?.conversations?.[key]?.room;
  if (!room || !Array.isArray(room.messages)) return;
  room.messages.push({ id: `local-${Date.now()}`, speaker: 'owner', text: body.text, at: Date.now() });
  store.saveGrok({ [key]: existing.data.room ? existing.data : { group: body.group, room } });
}
