// Real mode only: a local debug report for wallet failures, shown when the page address has ?debug=1.
// It records where a failure happened and the SHAPE of what the wallet returned (types, lengths,
// key names), never the dcRequest, never credential values, never personal data. Nothing here is
// sent to the server.

export const PHASES = {
  before: 'before navigator.credentials.get',
  during: 'during navigator.credentials.get',
  after: 'after navigator.credentials.get',
  confirm: 'during the confirm fetch',
};

export const debugEnabled = (search = globalThis.location?.search ?? '') => new URLSearchParams(search).get('debug') === '1';

/** A fresh trace for one real-mode attempt. Hybrid and mock never create one. */
export function newTrace() {
  return { phase: PHASES.before, credential: null, confirm: null };
}

/** Marks the start of the confirm fetch. Returns the object api() fills with status and text. */
export function markConfirm(trace) {
  if (!trace) return undefined;
  trace.phase = PHASES.confirm;
  trace.confirm = {};
  return trace.confirm;
}

const ctorName = (v) => {
  try { return v?.constructor?.name ?? null; } catch { return null; }
};

/** Types, lengths and key names only. Values are never copied. */
export function describeCredential(credential) {
  const out = { typeofCredential: typeof credential, credentialConstructor: ctorName(credential) };
  if (credential === null || credential === undefined) return out;
  let data;
  try { data = credential.data; } catch { return { ...out, typeofData: 'unreadable' }; }
  out.typeofData = data === null ? 'null' : typeof data;
  out.dataConstructor = ctorName(data);
  if (typeof data === 'string') out.dataLength = data.length;
  else if (data instanceof ArrayBuffer) out.dataLength = data.byteLength;
  else if (ArrayBuffer.isView(data) || Array.isArray(data)) out.dataLength = data.length;
  if (data && typeof data === 'object' && !ArrayBuffer.isView(data) && !(data instanceof ArrayBuffer)) {
    out.dataKeys = Object.keys(data);
    if (out.dataLength === undefined) out.dataLength = out.dataKeys.length;
  }
  return out;
}

/** The details shown in the panel and in the console, as a plain object. */
export function buildDetails(err, trace, result) {
  const d = {
    phase: trace?.phase ?? 'unknown',
    errorName: err ? err.name || 'Error' : null,
    errorMessage: err ? String(err.message ?? '') : null,
    stackFirstLine: err?.stack ? String(err.stack).split('\n')[0] : null,
    credential: trace?.credential ?? null,
    confirm: trace?.confirm && 'status' in trace.confirm ? { status: trace.confirm.status, response: trace.confirm.text } : null,
  };
  // The browser's own error, when the page wrapped it in a friendlier message.
  const cause = err?.cause;
  if (cause) {
    d.browserErrorName = cause.name || 'Error';
    d.browserErrorMessage = String(cause.message ?? '');
    d.browserStackFirstLine = cause.stack ? String(cause.stack).split('\n')[0] : null;
  }
  if (!err && result) d.outcome = `${result.outcome} (${result.reason})`;
  return d;
}

export function formatDetails(d) {
  const lines = ['Real wallet debug. Shown only on this device; nothing here was sent to the server.'];
  if (d.errorName) {
    lines.push(`error: ${d.errorName}${d.errorMessage ? `: ${d.errorMessage}` : ''}`);
    lines.push(`stack: ${d.stackFirstLine ?? '(none)'}`);
  }
  if (d.browserErrorName) {
    lines.push(`browser error: ${d.browserErrorName}${d.browserErrorMessage ? `: ${d.browserErrorMessage}` : ' (no message)'}`);
    lines.push(`browser stack: ${d.browserStackFirstLine ?? '(none)'}`);
  }
  if (d.outcome) lines.push(`outcome: ${d.outcome}`);
  lines.push(`phase: ${d.phase}`);
  if (d.credential) {
    const c = d.credential;
    lines.push(`credential: typeof ${c.typeofCredential}, constructor ${c.credentialConstructor ?? '(none)'}`);
    if (c.typeofData !== undefined) {
      lines.push(`credential.data: typeof ${c.typeofData}, constructor ${c.dataConstructor ?? '(none)'}, length ${c.dataLength ?? '(n/a)'}${c.dataKeys ? `, keys [${c.dataKeys.join(', ')}]` : ''}`);
    }
  } else {
    lines.push('credential: (the wallet did not return one)');
  }
  lines.push(d.confirm ? `confirm: HTTP ${d.confirm.status}, response: ${d.confirm.response || '(empty)'}` : 'confirm: (not called, or no HTTP response)');
  return lines.join('\n');
}

/**
 * After a real-mode failure: with ?debug=1, show the report in a <pre> right under the status
 * line and console.error the same details. Returns true when the panel was shown.
 */
export function reportRealFailure(err, trace, { result, statusEl, search, log = console } = {}) {
  if (!debugEnabled(search)) return false;
  const details = buildDetails(err, trace, result);
  log.error('[wallet debug]', details);
  if (!statusEl) return true;
  let pre = statusEl.ownerDocument.getElementById('wallet-debug');
  if (!pre) {
    pre = statusEl.ownerDocument.createElement('pre');
    pre.id = 'wallet-debug';
    pre.className = 'wallet-debug';
    statusEl.insertAdjacentElement('afterend', pre);
  }
  pre.textContent = formatDetails(details);
  return true;
}
