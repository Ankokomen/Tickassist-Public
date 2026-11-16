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

A caller can withhold their number. MAX then shows "anonymous" where the
number would be: that line appearing is the call, reported with no number
(phone None, withheld True) but with its skill and case number as usual.

MAX is not always there to be read: its tab goes to the background, its
window is minimized, a read comes back empty. What it showed is remembered
meanwhile, so when it is back the difference is what happened while it was
away. A number that is new then counts only while MAX shows a call in
progress - one that came and went is just another row of the history.

Platform-independent and unit-testable anywhere: no Windows calls in here.
"""

import re
import time
from collections import Counter

from .phones import WITHHELD_RE, find_phones, format_phone, one_case
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


# What a withheld caller is filed under, where a number would be.
WITHHELD = "withheld"

# How long a window that can't be read is remembered.
AWAY_SECONDS = 30 * 60

# What MAX draws only while a call is in progress: its call controls, each on
# a line of its own.
_LIVE = re.compile(r"^(hold|mute|incoming)$", re.IGNORECASE)

# A window whose title changed still shows the same page when at least this
# share of what it showed is still there (MAX retitles itself around a call).
SAME_PAGE = 0.5


def call_in_progress(lines):
    return any(_LIVE.match(ln) for ln in lines)


def same_page(before, now):
    """Whether two readings of a window (their lines) are of one page."""
    if not before:
        return False
    return len(set(before) & set(now)) >= SAME_PAGE * len(set(before))


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
        self._gone = {}          # source key -> when it stopped being readable
        self.last_ambiguous = None
        self.last_call = None

    def set_ignore(self, ignore):
        self.ignore = set(ignore)

    def set_rules(self, rules):
        self.rules = rules

    def _record_call(self, num, kind, context, hit, case=None):
        self.last_call = {
            "phone": format_phone(num) if num else "", "withheld": not num,
            "source": kind, "at": self.clock(),
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
        shown = format_phone(w["num"]) if w["num"] else ""
        last = self.last_call if self.last_call and self.last_call.get("phone") == shown else None
        if last is None:
            self._record_call(w["num"], kind, recent, hit, case)
        else:
            if hit:
                last["contact_type"], last["matched"] = hit[0], hit[1][:120]
            if case:
                last["case_number"] = case
        if w["type"] and w["case"]:
            del self._awaiting[key]
        return {"phone": w["num"], "withheld": not w["num"], "source": kind,
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
            returning = self._gone.pop(key, None) is not None
            text = src.get("text") or ""
            numbers = [n for n in find_phones(f"{title}\n{text}")
                       if n not in self.ignore]
            counts = Counter(split_lines(text))
            prev = self._seen.get(key)
            self._seen[key] = (title, set(numbers), counts)

            if kind == "window" and (prev is None or (prev[0] != title and not same_page(prev[2], counts))):
                # First look at this window, or it now shows a different page
                # (another title and mostly other text): whatever is on it is
                # the baseline. MAX may retitle itself as the call is
                # answered, just as the case panel loads - so a call still
                # waiting for its case number takes one if the new page shows
                # exactly one.
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
            if returning and not call_in_progress(counts):
                continue             # it came and went while MAX could not be read
            if not new:
                # No new number - but "anonymous" where one would be is a call
                # too, from someone who withheld theirs.
                if (any(WITHHELD_RE.match(ln) for ln in fresh)
                        and now - self._recent.get(WITHHELD, 0) >= DEDUPE_SECONDS):
                    self._recent[WITHHELD] = now
                    hit, case, context = self._details(None, [ln for _, ln in recent])
                    self._record_call(None, kind, context, hit, case)
                    if hit and case:
                        self._awaiting.pop(key, None)
                    else:
                        self._awaiting[key] = {"num": None, "at": now, "type": bool(hit), "case": bool(case)}
                    events.append({"phone": None, "withheld": True, "source": kind,
                                   "contact_type": hit[0] if hit else None,
                                   "matched": hit[1] if hit else None, "case_number": case})
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

        # A dismissed toast is forgotten at once, so the next one is new
        # again. A window that is not there to be read (closed, minimized, its
        # tab in the background) is remembered for a while: see the top.
        for key in list(self._seen):
            if key in present:
                continue
            self._fresh.pop(key, None)
            self._awaiting.pop(key, None)
            gone = self._gone.setdefault(key, now)
            if key.startswith("toast:") or now - gone > AWAY_SECONDS:
                del self._seen[key]
                self._gone.pop(key, None)
        for num, at in list(self._recent.items()):
            if now - at > DEDUPE_SECONDS:
                del self._recent[num]
        return events

    def note_external(self, num):
        """A call arrived by another route (num None: its number withheld);
        suppress an echo from the screen."""
        self._recent[num or WITHHELD] = self.clock()
        if not num:
            self._record_call(None, "address-bar", [], None)
