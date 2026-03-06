from __future__ import annotations

import logging

from linkedin_api import Linkedin

from app import db
from app.linkedin_client import get_my_urn

logger = logging.getLogger(__name__)


def get_recent_connections(client: Linkedin) -> list[dict]:
    """
    Fetch ~100 most recent connections via Voyager API.
    Sorted by recency — only care about new ones since last run.
    """
    my_urn = get_my_urn(client)
    logger.info(f"Fetching connections for URN: {my_urn}")
    connections = client.get_profile_connections(urn_id=my_urn)
    logger.info(f"get_profile_connections returned {len(connections)} items")
    if connections:
        logger.info(f"First connection keys: {list(connections[0].keys())}")
    return connections


def find_new_connections(connections: list[dict]) -> list[dict]:
    """Diff fetched connections against known URNs in Supabase."""
    known_urns = db.get_all_urns()
    new = []
    for c in connections:
        urn = c.get("entityUrn", "")
        if urn and urn not in known_urns:
            mini = c.get("miniProfile", c)
            new.append({
                "linkedin_urn": urn,
                "public_identifier": mini.get("publicIdentifier", ""),
                "first_name": mini.get("firstName", ""),
                "last_name": mini.get("lastName", ""),
                "headline": mini.get("occupation", mini.get("headline", "")),
            })
    return new
