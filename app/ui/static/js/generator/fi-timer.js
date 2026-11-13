/* ---- generator: First Impressions handle timer ---------------------------- */

import { $ } from "../core/dom.js";
import { callType, FIRST_IMPRESSIONS } from "./calltype.js";
import { isFormDirty } from "./fields.js";

// First Impressions calls are meant to stay short, so on that rotation the
// preview header shows how long the note in hand has been in progress. The
// count starts at the first entry into any field, or at an explicit
// double-click of the timestamp (which marks the start of a call before
// anything is typed); it holds at 00:00 while the note is empty, and resets
// whenever the form does (save, clear, stop-editing). From 10 minutes the
// readout takes on a faint glow, ramping steadily to full phosphor at 15 -
// a continuous build, never a blink (see .fi-timer in styles.css). The clock
// keeps running across a rotation toggle and is merely hidden on
// Troubleshooting, so flipping the toggle mid-note cannot cheat it.
const FI_GLOW_START_MS = 10 * 60 * 1000;
const FI_GLOW_FULL_MS = 15 * 60 * 1000;
const FI_PULSE_MS = 17 * 60 * 1000; // full phosphor starts gently breathing

export let fiTimerStart = null;  // epoch ms the note began, or null while idle
export let fiTimerArmed = false; // dbl-click start: keeps counting while still empty

export function renderFiTimer() {
  const el = $("fi-timer");
  if (!el) return;
  el.classList.toggle("hidden", callType !== FIRST_IMPRESSIONS);
  const secs = fiTimerStart ? Math.max(0, Math.floor((Date.now() - fiTimerStart) / 1000)) : 0;
  el.textContent =
    `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
  const glow = Math.min(1, Math.max(0,
    (secs * 1000 - FI_GLOW_START_MS) / (FI_GLOW_FULL_MS - FI_GLOW_START_MS)));
  el.style.setProperty("--fi-glow", glow.toFixed(3));
  el.classList.toggle("pulse", fiTimerStart !== null && secs * 1000 >= FI_PULSE_MS);
}

export function startFiTimer(armed = false) {
  if (armed) fiTimerArmed = true;
  if (fiTimerStart !== null) return;
  if (!armed && !isFormDirty()) return;
  fiTimerStart = Date.now();
  renderFiTimer();
}

export function resetFiTimer() {
  fiTimerStart = null;
  fiTimerArmed = false;
  renderFiTimer();
}

// Ride along with every field edit: begin counting once the note holds
// anything, and fall back to 00:00 if the user erases the little they typed
// (unless the start was armed explicitly via the timestamp double-click).
// Deferred a tick because sibling input handlers (autoGenerateTitle) may
// still be about to change fields this dirtiness check depends on.
export function fiTimerOnInput() {
  setTimeout(() => {
    if (isFormDirty()) startFiTimer(false);
    else if (!fiTimerArmed) resetFiTimer();
  }, 0);
}

export function restoreFiTimer(start, armed) {
  fiTimerStart = start;
  fiTimerArmed = armed;
  renderFiTimer();
}

// The timer ticks once a second; renderFiTimer is cheap and hides itself
// off-rotation, so the interval just always runs.
export function startFiTimerClock() {
  renderFiTimer();
  setInterval(renderFiTimer, 1000);
}
