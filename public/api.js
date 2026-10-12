/**
 * `trace` (real-mode debug only) receives the HTTP status and the first 300 characters of the
 * response. Without it the request and parsing are exactly as before.
 */
export async function api(path, body, extra = {}, trace) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json;
  if (trace) {
    const text = await res.text().catch(() => '');
    trace.status = res.status;
    trace.text = text.slice(0, 300);
    try { json = JSON.parse(text); } catch { json = {}; }
  } else {
    json = await res.json().catch(() => ({}));
  }
  if (!res.ok) {
    const err = new Error(json.message || 'Something went wrong. Try again.');
    err.status = res.status;
    err.code = json.error;
    err.body = json;
    throw err;
  }
  return json;
}
