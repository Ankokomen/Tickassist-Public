"""Server-side LLM proxy for the "AI Polish" feature.

Runs server-side so the API key never reaches the browser and CORS is a
non-issue. Uses only urllib from the standard library. Two providers are
supported: Google Gemini (the original tool's provider) and Anthropic Claude.
"""

import json
import re
import urllib.request
import urllib.error

# The instructions AI Polish follows. Carried over from the original generator
# so the behaviour matches what users already expect. This part can be edited
# in Settings > AI Polish (it is stored as polish_prompt; empty = this text).
DEFAULT_PROMPT = """You are an elite technical support engineer formatting service resolutions. You write with absolute clarity, using direct help-desk language. Do not invent details.

CRITICAL CONSTRAINTS:
1. You MUST write a SINGLE, concise resolution sentence. It must flow naturally in a professional, active voice and smoothly combine: Specific Corrective Action/Troubleshooting + Root Cause/Symptom + Current Technical State. Do NOT use robotic meta-language like "immediate technical symptom" or "underlying cause".
2. Format your response strictly based on the actual workflow events. If the RESOLUTION STATUS is "Awaiting Information" or "Escalated for Troubleshooting", describe the current status based strictly on the active notes (e.g., pending parts or remaining errors). Only state "Escalated" if the workflow explicitly says it was transferred to another tier.
3. Do NOT invent details or hardware modifications not listed in active fields.
4. Clean up, fix typos, correct grammar, and capitalize properly for both the "problem" and "contact" fields.
5. The "workflow" field MUST consist of properly formatted, capitalized bullet points starting with "* ". Every single bullet point MUST be on its own separate line (separated by an explicit newline character). Do not bunch them together on a single line.
6. The "next_steps" field lists what still needs to happen. Clean it up; when it contains multiple actions, format it as capitalized bullet points starting with "* ", each on its own separate line. If no next steps were provided, return an empty string.
7. NEVER REMOVE OR SHORTEN INFORMATION. Keep EVERY troubleshooting step, every next step, and every detail the technician wrote: each input step becomes at least one output bullet. Do not delete, merge, summarize, condense or reorder steps. Keep all numbers, versions, error codes, part numbers, serial numbers and names exactly as written. You only fix spelling, grammar, capitalization and bullet formatting.
8. The "resolution" is a single, professional resolution sentence mapping the action to the current outcome. Follow this syntax structure: "[Specific technical fix or troubleshooting action performed] to resolve [Symptom], resulting in [Current State / Pending Actions]."
"""

# Always added after the editable instructions: the answer format the program
# reads. Not editable, so a changed prompt can never break the parsing.
JSON_CONTRACT = """Respond ONLY with a JSON object using these exact keys:
- "title": Clean title following "Device Type - Problem - Serial".
- "problem": Cleaned up, professionalized statement of the issue.
- "contact": Standardized contact name (properly capitalized).
- "workflow": Bullet points, each strictly on its own separate line.
- "next_steps": Cleaned-up upcoming actions as bullet points on separate lines, or an empty string if none.
- "resolution": The single resolution sentence, written as the instructions above describe.
"""


def system_prompt(settings):
    """The editable instructions (or the default) plus the fixed answer format."""
    custom = ((settings or {}).get("polish_prompt") or "").strip()
    return (custom or DEFAULT_PROMPT.strip()) + "\n\n" + JSON_CONTRACT


RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "problem": {"type": "string"},
        "contact": {"type": "string"},
        "workflow": {"type": "string"},
        "next_steps": {"type": "string"},
        "resolution": {"type": "string"},
    },
    "required": ["problem", "contact", "workflow", "next_steps", "resolution"],
}

DEFAULT_MODELS = {
    "gemini": "gemini-2.5-flash",
    "anthropic": "claude-haiku-4-5-20251001",
}

REQUEST_TIMEOUT = 60  # seconds


class LLMError(Exception):
    """User-facing error raised when a polish request cannot be completed."""


STRICT_REMINDER = ("Your previous answer left out steps or details the technician wrote. "
                   "Answer again and keep EVERY troubleshooting step and next step - one output "
                   "bullet (or more) per input step, nothing removed, merged or shortened.")


def _user_payload(data, extra=None):
    payload = {
        "problem": data.get("problem", ""),
        "workflow": data.get("workflow", ""),
        "next_steps": data.get("next_steps", ""),
        "status": data.get("status", ""),
        "outcome": data.get("outcome", ""),
        "errors": data.get("errors", ""),
        "device": data.get("device", ""),
        "serial": data.get("serial", ""),
        "contact": data.get("contact", ""),
    }
    if extra:
        payload["reminder"] = extra
    return json.dumps(payload)


def _http_post_json(url, body, headers):
    raw = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=raw, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        detail = ""
        try:
            detail = err.read().decode("utf-8")
        except Exception:
            pass
        raise LLMError(f"Provider returned HTTP {err.code}. {_short(detail)}")
    except urllib.error.URLError as err:
        raise LLMError(f"Could not reach the provider: {err.reason}")


def _short(text, limit=300):
    text = (text or "").strip().replace("\n", " ")
    return text[:limit]


def _normalize_bullets(text):
    """Force every "* " bullet onto its own line.

    Some models (notably Gemini in structured-output mode) drop the newlines
    between bullets, collapsing them to "a* b* c". Re-split on the markers so
    each bullet lands on its own line regardless of provider behaviour. Text
    with no bullet markers is left untouched.
    """
    if not text or not text.strip():
        return ""
    s = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    if "*" not in s:
        return s  # plain prose / a single unmarked line - leave it be
    s = re.sub(r"\s*\*+\s*", "\n* ", s)      # each bullet -> newline + "* "
    s = re.sub(r"\n{2,}", "\n", s).strip("\n")
    return s


def _extract_json(text):
    """Pull the first JSON object out of a model response."""
    if not text:
        raise LLMError("The model returned an empty response.")
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end < start:
        raise LLMError("The model did not return JSON.")
    try:
        return json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        raise LLMError("Could not parse the model's JSON response.")


def polish(data, settings):
    provider = (settings.get("llm_provider") or "gemini").lower()
    api_key = (settings.get("llm_api_key") or "").strip()
    model = (settings.get("llm_model") or "").strip() or DEFAULT_MODELS.get(provider, "")

    if not api_key:
        raise LLMError("No API key configured. Add one on the Settings page.")
    system = system_prompt(settings)

    if provider == "anthropic":
        call = lambda extra=None: _polish_anthropic(data, api_key, model, extra, system)
    elif provider == "gemini":
        call = lambda extra=None: _polish_gemini(data, api_key, model, extra, system)
    else:
        raise LLMError(f"Unknown LLM provider: {provider}")

    cleaned = _clean(call())
    lost = _lost_fields(data, cleaned)
    if lost:   # one more try, told plainly what went wrong
        again = _clean(call(STRICT_REMINDER))
        if len(_lost_fields(data, again)) < len(lost):
            cleaned, lost = again, _lost_fields(data, again)
    # Whatever still drops information is not applied: the technician's own
    # text stays, and the page says so.
    cleaned["warnings"] = []
    for field, why in lost.items():
        cleaned[field] = _original(data, field)
        cleaned["warnings"].append({"field": field, "why": why})
    return cleaned


FIELD_KEYS = ("title", "problem", "contact", "workflow", "next_steps", "resolution")


def _text(value):
    """A model sometimes answers a text field with a list; make it text."""
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return "\n".join("* " + str(v).strip().lstrip("*- ").strip() for v in value if str(v).strip())
    return str(value)


def _clean(result):
    # Only the keys the frontend knows how to apply.
    cleaned = {k: _text(result.get(k, "")) for k in FIELD_KEYS}
    # Guarantee bullet fields are line-separated even if the model bunched them.
    cleaned["workflow"] = _normalize_bullets(cleaned["workflow"])
    cleaned["next_steps"] = _normalize_bullets(cleaned["next_steps"])
    return cleaned


def _original(data, field):
    return {"next_steps": data.get("next_steps", ""), "workflow": data.get("workflow", ""),
            "problem": data.get("problem", "")}.get(field, "")


def _units(text):
    """The separate steps in a piece of text: lines and "* " bullets."""
    parts = re.split(r"\n+|(?:(?<=\s)|^)\*+\s+", (text or "").replace("\r\n", "\n"))
    return [p for p in (x.strip() for x in parts) if p.strip(" *-\u2022\t")]


def _tokens(text):
    """Numbers, versions, error codes and the like: tokens holding a digit."""
    found = re.findall(r"[A-Za-z0-9_.\-/]*\d[A-Za-z0-9_.\-/]*", text or "")
    return {t.strip(".,;:-/").lower() for t in found if t.strip(".,;:-/")}


def _loss(original, polished, steps):
    """Why `polished` lost information from `original`, or None."""
    original, polished = (original or "").strip(), (polished or "").strip()
    if not original:
        return None
    if not polished:
        return "the rewrite came back empty"
    if steps and len(_units(polished)) < len(_units(original)):
        return "the rewrite had fewer steps"
    if len(polished) < 0.6 * len(original):
        return "the rewrite was much shorter"
    want = _tokens(original)
    if want:
        have = _tokens(polished)
        if sum(1 for t in want if t in have) < 0.8 * len(want):
            return "the rewrite dropped numbers or error codes"
    return None


def _lost_fields(data, cleaned):
    out = {}
    for field, steps in (("workflow", True), ("next_steps", True), ("problem", False)):
        why = _loss(data.get(field, ""), cleaned.get(field, ""), steps)
        if why:
            out[field] = why
    return out


def _polish_gemini(data, api_key, model, extra, system):
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{model}:generateContent?key={api_key}"
    )
    body = {
        "contents": [{"parts": [{"text": _user_payload(data, extra)}]}],
        "systemInstruction": {"parts": [{"text": system}]},
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": RESPONSE_SCHEMA,
        },
    }
    result = _http_post_json(url, body, {"Content-Type": "application/json"})
    try:
        text = result["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError, TypeError):
        raise LLMError("The model returned an unexpected response shape.")
    return _extract_json(text)


def _polish_anthropic(data, api_key, model, extra, system):
    url = "https://api.anthropic.com/v1/messages"
    body = {
        "model": model,
        "max_tokens": 4096,
        "system": system,
        "messages": [{"role": "user", "content": _user_payload(data, extra)}],
    }
    headers = {
        "Content-Type": "application/json",
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
    }
    result = _http_post_json(url, body, headers)
    try:
        text = result["content"][0]["text"]
    except (KeyError, IndexError, TypeError):
        raise LLMError("The model returned an unexpected response shape.")
    return _extract_json(text)
