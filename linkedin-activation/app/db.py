from __future__ import annotations

from typing import Optional

from supabase import create_client, Client

from app.config import SUPABASE_URL, SUPABASE_KEY, require_env_vars

TABLE = "linkedin_connections"

_client: Optional[Client] = None


def get_db() -> Client:
    global _client
    if _client is None:
        require_env_vars("SUPABASE_URL", "SUPABASE_KEY")
        _client = create_client(SUPABASE_URL, SUPABASE_KEY)
    return _client


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------

def get_all_urns() -> set[str]:
    resp = get_db().table(TABLE).select("linkedin_urn").execute()
    return {r["linkedin_urn"] for r in resp.data}


def get_connection(connection_id: str) -> dict:
    resp = get_db().table(TABLE).select("*").eq("id", connection_id).single().execute()
    return resp.data


def get_connections(status: Optional[str] = None, limit: int = 50) -> list[dict]:
    q = get_db().table(TABLE).select("*").order("detected_at", desc=True).limit(limit)
    if status:
        q = q.eq("status", status)
    return q.execute().data


def get_connections_by_statuses(statuses: list[str], limit: int = 50) -> list[dict]:
    q = get_db().table(TABLE).select("*").order("detected_at", desc=True).limit(limit)
    if statuses:
        q = q.in_("status", statuses)
    return q.execute().data


def get_last_run_timestamp() -> Optional[str]:
    resp = (
        get_db()
        .table(TABLE)
        .select("detected_at")
        .order("detected_at", desc=True)
        .limit(1)
        .execute()
    )
    if resp.data:
        return resp.data[0]["detected_at"]
    return None


def get_total_count() -> int:
    resp = get_db().table(TABLE).select("id", count="exact").execute()
    return resp.count or 0


def get_sent_count() -> int:
    resp = get_db().table(TABLE).select("id", count="exact").eq("status", "sent").execute()
    return resp.count or 0


# ---------------------------------------------------------------------------
# Writes
# ---------------------------------------------------------------------------

def insert_connection(conn: dict) -> dict:
    data = {
        "linkedin_urn": conn["linkedin_urn"],
        "public_identifier": conn.get("public_identifier"),
        "first_name": conn.get("first_name"),
        "last_name": conn.get("last_name"),
        "headline": conn.get("headline"),
        "status": "new",
        "last_error": None,
    }
    resp = get_db().table(TABLE).insert(data).execute()
    return resp.data[0]


def upsert_connection(conn: dict) -> dict:
    """Insert or return existing connection (safe against duplicates)."""
    data = {
        "linkedin_urn": conn["linkedin_urn"],
        "public_identifier": conn.get("public_identifier"),
        "first_name": conn.get("first_name"),
        "last_name": conn.get("last_name"),
        "headline": conn.get("headline"),
        "status": "new",
        "last_error": None,
    }
    resp = (
        get_db()
        .table(TABLE)
        .upsert(data, on_conflict="linkedin_urn", ignore_duplicates=True)
        .execute()
    )
    if resp.data:
        return resp.data[0]
    # Already existed — fetch it
    existing = (
        get_db()
        .table(TABLE)
        .select("*")
        .eq("linkedin_urn", conn["linkedin_urn"])
        .single()
        .execute()
    )
    return existing.data


def set_attio_id(connection_id: str, attio_id: str):
    get_db().table(TABLE).update({"attio_record_id": attio_id}).eq("id", connection_id).execute()


def set_enrichment(connection_id: str, enrichment: dict):
    profile = enrichment.get("profile", {})
    recent_posts = enrichment.get("recent_posts", [])
    update = {
        "summary": profile.get("summary", ""),
        "location": profile.get("locationName", ""),
        "industry": profile.get("industryName", ""),
        "experience": profile.get("experience", []),
        "recent_posts": recent_posts,
        "last_error": None,
    }
    get_db().table(TABLE).update(update).eq("id", connection_id).execute()


def set_draft(connection_id: str, message: str, status: Optional[str] = None):
    update = {"draft_message": message, "last_error": None}
    if status:
        update["status"] = status
    get_db().table(TABLE).update(update).eq("id", connection_id).execute()


def set_slack_ts(connection_id: str, ts: str, channel: Optional[str] = None, status: Optional[str] = None):
    update = {"slack_message_ts": ts, "last_error": None}
    if channel:
        update["slack_channel"] = channel
    if status:
        update["status"] = status
    get_db().table(TABLE).update(update).eq("id", connection_id).execute()


def set_status(connection_id: str, status: str):
    get_db().table(TABLE).update({"status": status}).eq("id", connection_id).execute()


def set_error(connection_id: str, status: str, message: str):
    last_error = message[:1000] if message else None
    get_db().table(TABLE).update({"status": status, "last_error": last_error}).eq("id", connection_id).execute()


# ---------------------------------------------------------------------------
# linkedin_outreach table
# ---------------------------------------------------------------------------

OUTREACH_TABLE = "linkedin_outreach"


def upsert_outreach_connection(data: dict) -> dict:
    """Insert new outreach row or return existing (ignore duplicates by profile URL)."""
    resp = (
        get_db()
        .table(OUTREACH_TABLE)
        .upsert(data, on_conflict="linkedin_profile_url", ignore_duplicates=True)
        .execute()
    )
    if resp.data:
        return resp.data[0]
    # Already existed — fetch it
    existing = (
        get_db()
        .table(OUTREACH_TABLE)
        .select("*")
        .eq("linkedin_profile_url", data["linkedin_profile_url"])
        .single()
        .execute()
    )
    return existing.data


def get_outreach(outreach_id: str) -> Optional[dict]:
    """Fetch a single outreach row by ID."""
    resp = (
        get_db()
        .table(OUTREACH_TABLE)
        .select("*")
        .eq("id", outreach_id)
        .single()
        .execute()
    )
    return resp.data


def get_outreach_by_profile_url(profile_url: str) -> Optional[dict]:
    """Fetch a single outreach row by LinkedIn profile URL."""
    resp = (
        get_db()
        .table(OUTREACH_TABLE)
        .select("*")
        .eq("linkedin_profile_url", profile_url)
        .limit(1)
        .execute()
    )
    if resp.data:
        return resp.data[0]
    return None


def get_outreach_by_full_name(full_name: str, status: str | None = None, limit: int = 10) -> list[dict]:
    """Fetch outreach rows by full name, optionally filtered by status."""
    q = (
        get_db()
        .table(OUTREACH_TABLE)
        .select("*")
        .eq("full_name", full_name)
        .limit(limit)
    )
    if status:
        q = q.eq("status", status)
    return q.execute().data


def get_outreach_by_container_id(container_id: str) -> Optional[dict]:
    """Find an outreach row by its pb_send_container_id."""
    resp = (
        get_db()
        .table(OUTREACH_TABLE)
        .select("*")
        .eq("pb_send_container_id", container_id)
        .limit(1)
        .execute()
    )
    if resp.data:
        return resp.data[0]
    return None


def get_outreach_by_status(status: str, limit: int = 100) -> list[dict]:
    """Fetch outreach rows by status, ordered by first_seen_at."""
    return (
        get_db()
        .table(OUTREACH_TABLE)
        .select("*")
        .eq("status", status)
        .order("first_seen_at", desc=False)
        .limit(limit)
        .execute()
    ).data


def get_approved_outreach(limit: int = 50) -> list[dict]:
    """Fetch approved outreach rows, oldest first (FIFO)."""
    return (
        get_db()
        .table(OUTREACH_TABLE)
        .select("*")
        .eq("status", "approved")
        .order("updated_at", desc=False)
        .limit(limit)
        .execute()
    ).data


def get_sent_today_count() -> int:
    """Count outreach rows with status 'sent' whose sent_at is today (UTC)."""
    from datetime import datetime, timezone

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    resp = (
        get_db()
        .table(OUTREACH_TABLE)
        .select("id", count="exact")
        .eq("status", "sent")
        .gte("sent_at", f"{today}T00:00:00Z")
        .execute()
    )
    return resp.count or 0


def get_unsynced_outreach(
    status_filter: str | None = None, limit: int | None = None
) -> list[dict]:
    """Fetch outreach rows where attio_synced_at IS NULL."""
    q = (
        get_db()
        .table(OUTREACH_TABLE)
        .select("*")
        .is_("attio_synced_at", "null")
        .order("updated_at", desc=False)
    )
    if status_filter:
        q = q.eq("status", status_filter)
    if limit:
        q = q.limit(limit)
    return q.execute().data


def get_outreach_status_counts() -> dict[str, int]:
    """Return count of outreach rows per status."""
    resp = get_db().table(OUTREACH_TABLE).select("status").execute()
    counts: dict[str, int] = {}
    for row in resp.data:
        s = row["status"]
        counts[s] = counts.get(s, 0) + 1
    return counts


def get_recent_failures(limit: int = 10) -> list[dict]:
    """Fetch the most recent send_failed outreach rows."""
    return (
        get_db()
        .table(OUTREACH_TABLE)
        .select("id, full_name, linkedin_profile_url, last_error, retry_count, updated_at")
        .eq("status", "send_failed")
        .order("updated_at", desc=True)
        .limit(limit)
        .execute()
    ).data


def get_outreach_sent_since(sent_after_iso: str, limit: int = 500) -> list[dict]:
    """Fetch outreach rows sent at or after the given UTC ISO timestamp."""
    return (
        get_db()
        .table(OUTREACH_TABLE)
        .select("id, full_name, linkedin_profile_url, approved_message, draft_message, sent_at, pb_send_container_id")
        .eq("status", "sent")
        .gte("sent_at", sent_after_iso)
        .order("sent_at", desc=False)
        .limit(limit)
        .execute()
    ).data


def get_outreach_attio_stats() -> dict:
    """Return counts for synced vs unsynced outreach rows and last sync time."""
    all_rows = get_db().table(OUTREACH_TABLE).select("attio_synced_at").execute()
    synced = 0
    unsynced = 0
    last_sync = None
    for row in all_rows.data:
        if row["attio_synced_at"]:
            synced += 1
            if last_sync is None or row["attio_synced_at"] > last_sync:
                last_sync = row["attio_synced_at"]
        else:
            unsynced += 1
    return {"synced": synced, "unsynced": unsynced, "last_sync": last_sync}


def update_outreach(outreach_id: str, updates: dict) -> dict:
    """Update an outreach row and return the updated row."""
    resp = (
        get_db()
        .table(OUTREACH_TABLE)
        .update(updates)
        .eq("id", outreach_id)
        .execute()
    )
    return resp.data[0]


def delete_all_outreach() -> int:
    """Delete all rows from linkedin_outreach and return the count deleted."""
    existing = (
        get_db()
        .table(OUTREACH_TABLE)
        .select("id", count="exact")
        .execute()
    )
    count = existing.count or 0
    get_db().table(OUTREACH_TABLE).delete().neq("id", "00000000-0000-0000-0000-000000000000").execute()
    return count


def queue_direct_send(payload: dict) -> dict:
    public_identifier = payload["public_identifier"].strip()
    linkedin_urn = payload.get("linkedin_urn") or f"pending:{public_identifier}"
    data = {
        "linkedin_urn": linkedin_urn,
        "public_identifier": public_identifier,
        "first_name": payload.get("first_name", ""),
        "last_name": payload.get("last_name", ""),
        "headline": payload.get("headline", ""),
        "summary": payload.get("summary", ""),
        "location": payload.get("location", ""),
        "industry": payload.get("industry", ""),
        "experience": payload.get("experience", []),
        "recent_posts": payload.get("recent_posts", []),
        "draft_message": payload["draft_message"],
        "status": "pending_send",
        "last_error": None,
    }
    resp = (
        get_db()
        .table(TABLE)
        .upsert(data, on_conflict="linkedin_urn")
        .execute()
    )
    return resp.data[0]
