"""Shorthand macros: \\trigger followed by space, Enter or Tab expands in a field."""


def normalize_trigger(trigger):
    """Triggers are stored without the leading backslash."""
    return (trigger or "").lstrip("\\").strip()


def validate(trigger, expansion):
    """(trigger, expansion) ready to store, or ValueError."""
    trigger = normalize_trigger(trigger)
    expansion = expansion if expansion is not None else ""
    if not trigger:
        raise ValueError("Trigger cannot be empty.")
    if not trigger.isalnum():
        raise ValueError("Trigger may only contain letters and numbers.")
    if not expansion.strip():
        raise ValueError("Expansion cannot be empty.")
    return trigger, expansion
