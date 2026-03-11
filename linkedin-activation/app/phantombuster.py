from __future__ import annotations

import hmac
import json
from datetime import datetime

import httpx

from app.config import (
    APP_BASE_URL,
    PHANTOMBUSTER_API_KEY,
    PB_CONNECTIONS_AGENT_ID,
    PB_MESSAGE_SENDER_AGENT_ID,
    PB_PROFILE_SCRAPER_ID,
    PB_ACTIVITY_EXTRACTOR_ID,
    PB_WEBHOOK_SECRET,
)

BASE_URL = "https://api.phantombuster.com/api/v2"
S3_BASE = "https://phantombuster.s3.amazonaws.com"


def _headers() -> dict[str, str]:
    return {
        "X-Phantombuster-Key-1": PHANTOMBUSTER_API_KEY,
        "Content-Type": "application/json",
    }


# ---------------------------------------------------------------------------
# Base request helpers
# ---------------------------------------------------------------------------

def launch_agent(agent_id: str, bonus_argument: dict | None = None) -> dict:
    """POST /agents/launch — bonusArgument must be a JSON string, not a dict."""
    body: dict = {"id": agent_id}
    if bonus_argument is not None:
        body["bonusArgument"] = json.dumps(bonus_argument)
    resp = httpx.post(f"{BASE_URL}/agents/launch", headers=_headers(), json=body)
    resp.raise_for_status()
    return resp.json()


def fetch_agent_info(agent_id: str) -> dict:
    """GET /agents/fetch — returns s3Folder and orgS3Folder for result downloads."""
    resp = httpx.get(f"{BASE_URL}/agents/fetch", headers=_headers(), params={"id": agent_id})
    resp.raise_for_status()
    return resp.json()


def fetch_agent_status(agent_id: str) -> dict:
    """GET /agents/fetch — returns full agent state including lastEndMessage."""
    resp = httpx.get(f"{BASE_URL}/agents/fetch", headers=_headers(), params={"id": agent_id})
    resp.raise_for_status()
    return resp.json()


def fetch_agent_output(agent_id: str) -> dict:
    """GET /agents/fetch-output — returns the agent's most recent result data."""
    resp = httpx.get(f"{BASE_URL}/agents/fetch-output", headers=_headers(), params={"id": agent_id})
    resp.raise_for_status()
    return resp.json()


def download_result_csv(s3_folder: str, org_s3_folder: str, file_name: str = "result.csv") -> str:
    """Download a result file from PhantomBuster's S3 bucket."""
    url = f"{S3_BASE}/{org_s3_folder}/{s3_folder}/{file_name}"
    resp = httpx.get(url)
    resp.raise_for_status()
    return resp.text


# ---------------------------------------------------------------------------
# Convenience launchers (validated field names / formats)
# ---------------------------------------------------------------------------

def launch_connections_export(date_after: str) -> dict:
    """
    Launch connections export agent.
    date_after MUST be MM-DD-YYYY format (e.g. "03-06-2026").
    Both fields are required: the boolean enables the filter, the string is the date.
    """
    return launch_agent(PB_CONNECTIONS_AGENT_ID, {
        "onlyRetrieveProfilesAfterDate": True,
        "dateAfter": date_after,
    })


def launch_profile_scraper(profile_url: str) -> dict:
    """Launch Profile Scraper phantom for a single LinkedIn profile."""
    return launch_agent(PB_PROFILE_SCRAPER_ID, {
        "spreadsheetUrl": profile_url,
        "numberOfProfilesPerLaunch": 1,
    })


def launch_activity_extractor(profile_url: str, num_activities: int = 10) -> dict:
    """Launch Activity Extractor phantom for a single LinkedIn profile."""
    return launch_agent(PB_ACTIVITY_EXTRACTOR_ID, {
        "spreadsheetUrl": profile_url,
        "numberOfProfilesPerLaunch": 1,
        "numberOfActivitiesPerProfile": num_activities,
    })


def launch_message_sender(profile_url: str, message: str) -> dict:
    """
    Launch message sender agent.
    PB uses "spreadsheetUrl" as the field name even for a single profile URL.
    """
    return launch_agent(PB_MESSAGE_SENDER_AGENT_ID, {
        "spreadsheetUrl": profile_url,
        "message": message,
    })


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def format_date_for_pb(dt: datetime) -> str:
    """Returns MM-DD-YYYY format string for PB's dateAfter field."""
    return dt.strftime("%m-%d-%Y")


def validate_webhook_secret(query_secret: str) -> bool:
    """Timing-safe comparison against PB_WEBHOOK_SECRET."""
    if not PB_WEBHOOK_SECRET:
        return False
    return hmac.compare_digest(query_secret, PB_WEBHOOK_SECRET)


def expected_webhook_url() -> str:
    """Return the expected PB callback URL for operator diagnostics."""
    if not APP_BASE_URL:
        return ""
    base_url = APP_BASE_URL.rstrip("/")
    if not PB_WEBHOOK_SECRET:
        return f"{base_url}/phantombuster/webhook"
    return f"{base_url}/phantombuster/webhook?secret={PB_WEBHOOK_SECRET}"
