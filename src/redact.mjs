const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const KEYISH = /\b(sk|xai|ghp|gho|ghs|github_pat|glpat|xox[abpr]|AKIA|AIza)[-_A-Za-z0-9]{8,}/g;

export function redact(value, secrets = []) {
  let text = String(value ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) text = text.split(secret).join('[redacted]');
  }
  return text
    .replace(BEARER, 'Bearer [redacted]')
    .replace(KEYISH, '[redacted]')
    .replace(/((?:api[_-]?key|token|secret|password|passwd|authorization|cookie)["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi, '$1[redacted]');
}

export function scrub(value, secrets = []) {
  if (value == null) return value;
  try {
    const text = redact(JSON.stringify(value), secrets);
    return JSON.parse(text);
  } catch {
    return value;
  }
}

export function createLogger(secrets = () => []) {
  return function log(...parts) {
    const line = parts.map(part => (typeof part === 'string' ? part : safeJson(part))).join(' ');
    console.log(redact(line, secrets()));
  };
}

function safeJson(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}
