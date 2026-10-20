const AUTO_KINDS = new Set(['acp.permission', 'permission.acp', 'cua.permission']);

function lower(value) {
  return String(value || '').trim().toLowerCase();
}

function autoSignals(event) {
  const data = event?.data && typeof event.data === 'object' ? event.data : {};
  const kind = lower(event?.kind);
  const type = lower(data.type || data.messageType);
  const status = lower(data.status || event?.status);
  const decided = lower(data.decidedBy || data.source || data.by);
  if (data.autoApproved === true || data.auto === true) return true;
  if (status === 'auto-approved' || status === 'auto_approved') return true;
  if (AUTO_KINDS.has(kind)) return true;
  if (decided === 'cua' || decided === 'sandbox') return true;
  if (data.mode === 'auto' && /permission|approval/.test(kind + type)) return true;
  return false;
}

export function classifyApproval(event) {
  const data = event?.data && typeof event.data === 'object' ? event.data : {};
  const kind = lower(event?.kind);
  const type = lower(data.type || data.messageType);
  const status = lower(data.status || event?.status);
  const auto = autoSignals(event);
  if (auto) return { disposition: 'auto_approved', needsHuman: false };
  const humanPending = data.needsHuman === true
    || status === 'pending'
    || kind === 'approval.pending'
    || kind === 'needs-input'
    || type === 'local-tool-permission'
    || type === 'local-tool'
    || (type === 'auto-review' && status !== 'denied' && status !== 'approved' && status !== 'resolved')
    || (type === 'auto-review-approval' && (status === 'pending' || status === ''));
  if (humanPending) return { disposition: 'needs_human', needsHuman: true };
  if (status === 'approved' || status === 'denied' || status === 'resolved') {
    return { disposition: 'resolved', needsHuman: false };
  }
  return { disposition: 'info', needsHuman: false };
}

export function normalizeApprovalEvent(event) {
  const classified = classifyApproval(event);
  const data = { ...(event?.data && typeof event.data === 'object' ? event.data : {}) };
  data.disposition = classified.disposition;
  data.needsHuman = classified.needsHuman;
  if (!classified.needsHuman && lower(data.status) === 'pending') {
    data.status = classified.disposition === 'auto_approved' ? 'auto-approved' : data.status;
    if (classified.disposition === 'auto_approved') data.status = 'auto-approved';
  }
  return {
    ...event,
    data,
    disposition: classified.disposition,
    needsHuman: classified.needsHuman,
  };
}

export function normalizeGrokPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const copy = structuredClone(payload);
  const visitCard = card => {
    if (!card || typeof card !== 'object') return card;
    const event = {
      kind: card.kind || card.type || 'approval',
      status: card.status,
      data: {
        ...card,
        type: card.type,
        status: card.status,
        autoApproved: card.autoApproved,
        source: card.source || card.decidedBy,
        decidedBy: card.decidedBy,
        needsHuman: card.needsHuman,
      },
    };
    const norm = normalizeApprovalEvent(event);
    return {
      ...card,
      status: norm.data.status || card.status,
      disposition: norm.disposition,
      needsHuman: norm.needsHuman,
      autoApproved: norm.disposition === 'auto_approved' || card.autoApproved === true,
    };
  };
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.cards)) node.cards = node.cards.map(visitCard);
    if (Array.isArray(node.items)) node.items = node.items.map(visitCard);
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') walk(value);
    }
  };
  walk(copy);
  return copy;
}
