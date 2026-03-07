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
