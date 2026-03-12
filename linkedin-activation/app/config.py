import os
from dotenv import load_dotenv

load_dotenv()


def _get(key: str, default: str = "") -> str:
    return os.getenv(key, default).strip()


def require_env_vars(*keys: str) -> None:
    missing = [key for key in keys if not _get(key)]
    if missing:
        raise RuntimeError(f"Missing required env var(s): {', '.join(missing)}")


OPENAI_API_KEY = _get("OPENAI_API_KEY")
ATTIO_API_KEY = _get("ATTIO_API_KEY")
SLACK_BOT_TOKEN = _get("SLACK_BOT_TOKEN")
SLACK_SIGNING_SECRET = _get("SLACK_SIGNING_SECRET")
SUPABASE_URL = _get("SUPABASE_URL")
SUPABASE_KEY = _get("SUPABASE_KEY")

# Outreach pipeline (PhantomBuster + send limits)
PHANTOMBUSTER_API_KEY = _get("PHANTOMBUSTER_API_KEY")
PB_CONNECTIONS_AGENT_ID = _get("PB_CONNECTIONS_AGENT_ID")
PB_MESSAGE_SENDER_AGENT_ID = _get("PB_MESSAGE_SENDER_AGENT_ID")
PB_PROFILE_SCRAPER_ID = _get("PB_PROFILE_SCRAPER_ID")
PB_ACTIVITY_EXTRACTOR_ID = _get("PB_ACTIVITY_EXTRACTOR_ID")
PB_WEBHOOK_SECRET = _get("PB_WEBHOOK_SECRET")
DAILY_SEND_LIMIT = int(_get("DAILY_SEND_LIMIT") or "50")
SEND_BATCH_LIMIT = int(_get("SEND_BATCH_LIMIT") or "5")
SEND_LAUNCH_PAUSE_SECONDS = int(_get("SEND_LAUNCH_PAUSE_SECONDS") or "360")
DRAFT_DAILY_LIMIT = int(_get("DRAFT_DAILY_LIMIT") or "50")
DRAFT_BATCH_LIMIT = int(_get("DRAFT_BATCH_LIMIT") or "5")
OUTREACH_SLACK_CHANNEL = _get("OUTREACH_SLACK_CHANNEL")
ADMIN_API_KEY = _get("ADMIN_API_KEY")
APP_BASE_URL = _get("APP_BASE_URL")
