"""Turning successive screen snapshots into "this is the new caller" events.

Why "a number that has just appeared" and not "any number on screen": MAX
shows other numbers too - contact history, the dialled line, skill numbers.
So a window is first read as a baseline, and only a number that shows up
afterwards counts as an incoming caller. If several new numbers appear at once
(a page load, a tab switch) it is ambiguous and nothing is filled; Settings
shows what was skipped so a stray number can be added to the ignore list. A
toast is new by definition, so its number counts immediately.

Text that appears together with the number - MAX's skill, such as "FI-Dealer
Support" - is matched against the caller-type rules to choose Contact Type.
If MAX draws the skill a moment after the number, a follow-up event types the
call when it lands.

Platform-independent and unit-testable anywhere: no Windows calls in here.
"""

import time
from collections import Counter

from .phones import find_phones, format_phone, one_case
from .rules import DEFAULT_RULES, classify, lines_for_call, parse_rules, split_lines

# The same number arriving from two routes (toast + window, or a screen pop
# as well) within this window is one call, not two.
DEDUPE_SECONDS = 45

# MAX may draw the skill ("FI-Dealer Support") a moment before or after the
# number. Text that appeared within this window either side of the number is
# read as belonging to that call.
CONTEXT_SECONDS = 8

# A D365 case number shown with the call - e.g. "Inbound Case Reference:
# CAS0490097" in the Call Triage panel MAX pops. That panel can load when the
# call is answered rather than when it rings, so it is looked for longer than
# the skill; the CAS + 7 digits shape is distinctive enough to allow that.
CASE_SECONDS = 120


class CallDetector:
    """Turns successive screen snapshots into "this is the new caller" events.

    Platform-independent: feed it snapshots and it returns the numbers to use.
    A snapshot is a list of sources: {"k": "window"|"toast", "id", "title",
    "text"}.
    """

    def __init__(self, ignore=(), clock=time.time, rules=None):
        self.ignore = set(ignore)
        self.clock = clock
        self.rules = parse_rules(DEFAULT_RULES) if rules is None else rules
        self._seen = {}          # source key -> (title, set(numbers), Counter(lines))
        self._fresh = {}         # source key -> [(time, line)] recently appeared
        # source key -> {"num", "at", "type": bool, "case": bool}: a call still
        # missing its skill (for CONTEXT_SECONDS) or case number (CASE_SECONDS).
        self._awaiting = {}
        self._recent = {}        # number -> time it was last reported
        self.last_ambiguous = None
        self.last_call = None

    def set_ignore(self, ignore):
        self.ignore = set(ignore)

    def set_rules(self, rules):
        self.rules = rules

    def _record_call(self, num, kind, context, hit, case=None):
        self.last_call = {
            "phone": format_phone(num), "source": kind, "at": self.clock(),
            "contact_type": hit[0] if hit else None,
            "matched": hit[1][:120] if hit else None,
            "case_number": case,
            # What arrived with the call, for writing a rule when none matched.
            "context": [ln[:80] for ln in context if not find_phones(ln)][:8],
        }

    def _details(self, num, lines, want_type=True, want_case=True):
        """(type hit, case number, lines used) for the call from `num`. The
        caller's own row is read before text naming no number, and text about
        another call is not read at all (see lines_for_call)."""
        own, neutral = lines_for_call(lines, num, self.ignore)
        hit = (classify(self.rules, own) or classify(self.rules, neutral)) if want_type else None
        case = one_case(own + neutral) if want_case else None
        return hit, case, own + neutral

    def _late_details(self, key, kind, lines, recent, now, whole=False):
        """A call already reported may get its skill or case number drawn a
        moment later. Returns the update event, if this scan brought one."""
        w = self._awaiting.get(key)
        if not w:
            return None
        type_open = not w["type"] and now - w["at"] <= CONTEXT_SECONDS
        case_open = not w["case"] and now - w["at"] <= CASE_SECONDS
        if not type_open and not case_open:
            del self._awaiting[key]
            return None
        # A whole re-read page is only trusted for the distinctive case number.
        want_type, want_case = type_open and not whole, case_open
        hit, case = None, None
        if lines:
            hit, case, _ = self._details(w["num"], lines, want_type, want_case)
        if not hit and not case:
            return None
        w["type"] = w["type"] or bool(hit)
        w["case"] = w["case"] or bool(case)
        last = self.last_call if self.last_call and self.last_call.get("phone") == format_phone(w["num"]) else None
        if last is None:
            self._record_call(w["num"], kind, recent, hit, case)
        else:
            if hit:
                last["contact_type"], last["matched"] = hit[0], hit[1][:120]
            if case:
                last["case_number"] = case
        if w["type"] and w["case"]:
            del self._awaiting[key]
        return {"phone": w["num"], "source": kind,
                "contact_type": hit[0] if hit else None,
                "matched": hit[1] if hit else None,
                "case_number": case, "update": True}

    def feed(self, sources):
        now = self.clock()
        events = []
        present = set()
        for src in sources or []:
            kind = src.get("k") or "window"
            key = f"{kind}:{src.get('id')}"
            title = src.get("title") or ""
            present.add(key)
            text = src.get("text") or ""
            numbers = [n for n in find_phones(f"{title}\n{text}")
                       if n not in self.ignore]
            counts = Counter(split_lines(text))
            prev = self._seen.get(key)
            self._seen[key] = (title, set(numbers), counts)

            if kind == "window" and (prev is None or prev[0] != title):
                # First look at this window, or it now shows a different page
                # (title changed): whatever is on it is the baseline. MAX may
                # retitle itself as the call is answered, just as the case
                # panel loads - so a call still waiting for its case number
                # takes one if the new page shows exactly one.
                self._fresh[key] = []
                if prev is not None:
                    ev = self._late_details(key, kind, list(counts), [], now, whole=True)
                    if ev:
                        events.append(ev)
                continue

            # Lines that were not there last scan (a toast is all new). Counted,
            # so a second "FI-Dealer Support" next to one already in the
            # history still registers as new.
            fresh = list((counts - prev[2]).elements()) if prev else list(counts.elements())
            recent = [(t, ln) for t, ln in self._fresh.get(key, [])
                      if now - t <= CONTEXT_SECONDS]
            recent.extend((now, ln) for ln in fresh)
            self._fresh[key] = recent

            # A call already reported without a type: the skill may be drawn
            # just after the number, so keep looking for a few seconds.
            ev = self._late_details(key, kind, fresh, [ln for _, ln in recent], now)
            if ev:
                events.append(ev)

            new = [n for n in numbers if prev is None or n not in prev[1]]
            if not new:
                continue
            if len(new) > 1:
                self.last_ambiguous = {"numbers": [format_phone(n) for n in new],
                                       "source": kind, "at": now}
                continue
            num = new[0]
            if now - self._recent.get(num, 0) < DEDUPE_SECONDS:
                continue
            self._recent[num] = now
            hit, case, context = self._details(num, [ln for _, ln in recent])
            self._record_call(num, kind, context, hit, case)
            if hit and case:
                self._awaiting.pop(key, None)
            else:
                self._awaiting[key] = {"num": num, "at": now,
                                       "type": bool(hit), "case": bool(case)}
            events.append({"phone": num, "source": kind,
                           "contact_type": hit[0] if hit else None,
                           "matched": hit[1] if hit else None,
                           "case_number": case})

        # Forget closed windows / dismissed toasts so a repeat caller later
        # in the shift is detected again rather than suppressed as "seen".
        for key in list(self._seen):
            if key not in present:
                del self._seen[key]
                self._fresh.pop(key, None)
                self._awaiting.pop(key, None)
        for num, at in list(self._recent.items()):
            if now - at > DEDUPE_SECONDS:
                del self._recent[num]
        return events

    def note_external(self, num):
        """A number arrived by another route; suppress an echo from the screen."""
        self._recent[num] = self.clock()
