from __future__ import annotations

from datetime import datetime, timezone
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


def set_draft(connection_id: str, message: str):
    get_db().table(TABLE).update({"draft_message": message, "status": "drafted"}).eq("id", connection_id).execute()


def set_slack_ts(connection_id: str, ts: str):
    get_db().table(TABLE).update({"slack_message_ts": ts}).eq("id", connection_id).execute()


def set_status(connection_id: str, status: str):
    get_db().table(TABLE).update({"status": status}).eq("id", connection_id).execute()
