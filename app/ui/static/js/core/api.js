/* Talking to the local TickAssist server. Every request goes through here, so
   an error always arrives as an Error whose message is the server's own. */

async function failure(res, fallback) {
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  return new Error((data && data.error) || `${fallback} (${res.status})`);
}

export async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) {
    const msg = (data && data.error) || `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

// POST raw bytes (a photo, an uploaded file); answers JSON.
export async function apiUpload(path, body, contentType) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": contentType }, body });
  if (!res.ok) throw await failure(res, "Upload failed");
  return res.json().catch(() => ({}));
}

// GET a binary resource as a Blob.
export async function apiBlob(path, notFound) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(notFound || `Request failed (${res.status})`);
  return res.blob();
}

// /api/health straight from the server, never from a cache: used while a
// restart is under way, when the answer changes from one second to the next.
export async function health() {
  const res = await fetch("/api/health", { cache: "no-store" });
  return { ok: res.ok, info: await res.json().catch(() => ({})) };
}

// After asking the server to restart: poll /api/health until isBack(health)
// says the new copy is serving, then reload the page. Gives up after 45 s.
export function reloadWhenBack(isBack, { firstDelay = 2500, onGiveUp } = {}) {
  const started = Date.now();
  const wait = async () => {
    try {
      if (isBack(await health())) { location.reload(); return; }
    } catch (e) { /* still restarting */ }
    if (Date.now() - started < 45000) setTimeout(wait, 1000);
    else if (onGiveUp) onGiveUp();
  };
  setTimeout(wait, firstDelay);
}
