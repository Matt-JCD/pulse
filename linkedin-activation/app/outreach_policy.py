from __future__ import annotations

import re
import unicodedata

BLOCKED_HEADLINE_PATTERNS = [
    r"\bsales\b",
    r"\bsales consulting\b",
    r"\bsales consultant\b",
    r"\bsolutions engineering\b",
    r"\bsolution engineering\b",
    r"\bsolutions engineer\b",
    r"\bsolution engineer\b",
    r"\bsolutions consultant\b",
    r"\bsolution consultant\b",
    r"\bcustomer success\b",
    r"\bcustomer-success\b",
    r"\bpre[- ]sales\b",
]

MAX_PB_MESSAGE_LENGTH = 280


def filter_outreach_candidate(headline: str | None) -> tuple[bool, str | None]:
    """Return whether a profile should be excluded from outreach based on headline."""
    normalized = _normalize_match_text(headline)
    if not normalized:
        return False, None

    for pattern in BLOCKED_HEADLINE_PATTERNS:
        if re.search(pattern, normalized):
            return True, pattern
    return False, None


def sanitize_message_for_pb(message: str) -> str:
    """
    Normalize outgoing PB send text so the browser typing step gets simpler input.
    - ASCII-only
    - single spaces
    - conservative length cap
    """
    replacements = {
        "\u2018": "'",
        "\u2019": "'",
        "\u201c": '"',
        "\u201d": '"',
        "\u2013": "-",
        "\u2014": "-",
        "\u00a0": " ",
    }
    for source, target in replacements.items():
        message = message.replace(source, target)

    ascii_text = (
        unicodedata.normalize("NFKD", message)
        .encode("ascii", "ignore")
        .decode("ascii")
    )
    ascii_text = " ".join(ascii_text.split()).strip()
    if len(ascii_text) <= MAX_PB_MESSAGE_LENGTH:
        return ascii_text

    trimmed = ascii_text[: MAX_PB_MESSAGE_LENGTH].rstrip(" ,.;:-")
    last_break = max(trimmed.rfind(". "), trimmed.rfind("? "), trimmed.rfind("! "), trimmed.rfind(" "))
    if last_break >= 160:
        trimmed = trimmed[:last_break].rstrip(" ,.;:-")
    return trimmed


def _normalize_match_text(value: str | None) -> str:
    if not value:
        return ""
    value = unicodedata.normalize("NFKD", value)
    value = value.encode("ascii", "ignore").decode("ascii")
    value = value.lower()
    value = re.sub(r"[^a-z0-9+/#& -]+", " ", value)
    return " ".join(value.split())
