from __future__ import annotations

from supabase import Client

TABLE = "linkedin_outreach"

VALID_TRANSITIONS: dict[str, list[str]] = {
    "detected": ["drafted"],
    "drafted": ["awaiting_review"],
    "awaiting_review": ["approved", "rejected"],
    "approved": ["send_queued"],
    "send_queued": ["sending", "sent", "send_failed"],
    "sending": ["sent", "send_failed"],
    "send_failed": ["approved"],
}


def validate_transition(current_status: str, new_status: str) -> bool:
    """Returns True if transition is valid, False otherwise."""
    allowed = VALID_TRANSITIONS.get(current_status, [])
    return new_status in allowed


def transition_status(supabase_client: Client, outreach_id: str, new_status: str) -> dict:
    """
    Validates transition, updates the row in linkedin_outreach, returns updated row.
    Raises ValueError if transition is invalid.
    """
    row = (
        supabase_client.table(TABLE)
        .select("status")
        .eq("id", outreach_id)
        .single()
        .execute()
    )
    current_status = row.data["status"]

    if not validate_transition(current_status, new_status):
        raise ValueError(
            f"Invalid transition: {current_status!r} -> {new_status!r}"
        )

    updated = (
        supabase_client.table(TABLE)
        .update({"status": new_status})
        .eq("id", outreach_id)
        .execute()
    )
    return updated.data[0]
