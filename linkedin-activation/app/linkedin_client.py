from __future__ import annotations

from typing import Optional
from requests.cookies import RequestsCookieJar
from linkedin_api import Linkedin

_client: Optional[Linkedin] = None


def get_client(email: str = "", password: str = "", li_at: str = "", jsessionid: str = "") -> Linkedin:
    """
    Reuse same session across detection, enrichment, and sending.
    Prefers li_at + JSESSIONID cookies over email/password to avoid CHALLENGE on server IPs.
    """
    global _client
    if _client is None:
        if li_at and jsessionid:
            jar = RequestsCookieJar()
            jar.set("li_at", li_at, domain=".linkedin.com", path="/")
            jar.set("JSESSIONID", jsessionid, domain=".linkedin.com", path="/")
            _client = Linkedin("", "", cookies=jar)
        elif email and password:
            _client = Linkedin(email, password)
        else:
            raise RuntimeError("No LinkedIn credentials: set LI_AT+LI_JSESSIONID or LI_EMAIL+LI_PASSWORD")
    return _client


def get_my_urn(client: Linkedin) -> str:
    """Get the authenticated user's URN dynamically."""
    profile = client.get_user_profile()
    mini = profile.get("miniProfile", profile)
    return mini.get("entityUrn", mini.get("objectUrn", ""))
