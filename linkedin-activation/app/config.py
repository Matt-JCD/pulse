import os
from dotenv import load_dotenv

load_dotenv()


def _require(key: str) -> str:
    val = os.getenv(key)
    if not val:
        raise RuntimeError(f"Missing required env var: {key}")
    return val


LI_EMAIL = os.getenv("LI_EMAIL", "")
LI_PASSWORD = os.getenv("LI_PASSWORD", "")
LI_AT = os.getenv("LI_AT", "")
LI_JSESSIONID = os.getenv("LI_JSESSIONID", "")
ANTHROPIC_API_KEY = _require("ANTHROPIC_API_KEY")
ATTIO_API_KEY = _require("ATTIO_API_KEY")
SLACK_BOT_TOKEN = _require("SLACK_BOT_TOKEN")
SLACK_SIGNING_SECRET = _require("SLACK_SIGNING_SECRET")
SLACK_CHANNEL = _require("SLACK_CHANNEL")
SUPABASE_URL = _require("SUPABASE_URL")
SUPABASE_KEY = _require("SUPABASE_KEY")
