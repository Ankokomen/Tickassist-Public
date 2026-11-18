/* Formatting dates, counts and sizes for display. */

// SQLite stores created_at as UTC ("YYYY-MM-DD HH:MM:SS"); show local time.
export function localDateTime(ts) {
  if (!ts) return "";
  const iso = ts.includes("T") ? ts : ts.replace(" ", "T");
  const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
  if (isNaN(d)) return ts;
  return d.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

// The same for a time the server already gave as this PC's local time.
export function localStamp(ts) {
  if (!ts) return "";
  const d = new Date(String(ts).replace(" ", "T"));
  if (isNaN(d)) return ts;
  return d.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

export function humanAge(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return "moments";
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

// "YYYY-MM-DD" -> true for Saturday / Sunday, parsed as a local date.
export function isWeekend(iso) {
  const p = (iso || "").split("-");
  if (p.length !== 3) return false;
  const day = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])).getDay();
  return day === 0 || day === 6;
}

// "YYYY-MM-DD" -> "Aug 3", parsed as a local date (no UTC shift).
export function fmtDayLabel(iso) {
  const p = (iso || "").split("-");
  if (p.length !== 3) return iso || "";
  const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  return isNaN(d) ? iso : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }

export function fmtBytes(n) {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function clip(s, n = 70) { return s.length > n ? s.slice(0, n - 1) + "\u2026" : s; }
