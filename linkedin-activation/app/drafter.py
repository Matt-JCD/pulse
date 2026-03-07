from __future__ import annotations

import logging

import anthropic
from supabase import Client

from app import db
from app.config import ANTHROPIC_API_KEY
from app.state_machine import transition_status

logger = logging.getLogger(__name__)

SYSTEM = """You are drafting LinkedIn connection messages as Matt Doughty, CEO of Prefactor.
Australian-based (English background), direct, no-bullshit, hates corporate speak.
Builds AI agent platforms with Claude Code. Runs podcast "Agents After Dark" about
enterprise AI agents and MCP (Model Context Protocol).

Your job: write a hyper-personalised opening message that makes this person want to reply.
You have their full profile, work history, and recent LinkedIn posts.

PRIORITY ORDER for what to reference:
1. Their recent posts about AI, AI agents, MCP, Claude, LLMs, or automation — quote or
   reference a specific insight they shared. This is gold.
2. A specific company initiative or product they're building — show you understand what
   their company actually does, not just their job title.
3. Something specific from their About section or work experience that connects to
   what Matt cares about (AI agents, enterprise automation, founder life).
4. If none of the above exist, find ANY specific detail that shows you actually read
   their profile — a unique career move, an interesting company, a niche expertise.

NEVER fall back to generic "great to connect" messages. If there's truly nothing
specific to reference, say something provocative about their industry + AI."""


def draft_message(enrichment: dict, api_key: str) -> str:
    """Draft a personalised LinkedIn message using Claude."""
    client = anthropic.Anthropic(api_key=api_key)
    profile = enrichment["profile"]
    posts = enrichment.get("recent_posts", [])

    context_parts = [
        f"Name: {profile.get('firstName', '')} {profile.get('lastName', '')}",
        f"Headline: {profile.get('headline', '')}",
        f"Location: {profile.get('locationName', '')}",
        f"Industry: {profile.get('industryName', '')}",
    ]

    if profile.get("summary"):
        context_parts.append(f"About: {profile['summary'][:800]}")

    for exp in (profile.get("experience") or [])[:3]:
        title = exp.get("title", "")
        company = exp.get("companyName", "")
        desc = exp.get("description", "")
        line = f"Role: {title} at {company}"
        if desc:
            line += f" — {desc[:200]}"
        context_parts.append(line)

    if posts:
        context_parts.append("\n--- RECENT LINKEDIN POSTS ---")
        for i, p in enumerate(posts[:5], 1):
            text = p.get("commentary", p.get("text", ""))[:400]
            if text:
                context_parts.append(f"Post {i}: {text}")

    resp = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=400,
        system=SYSTEM,
        messages=[
            {
                "role": "user",
                "content": f"""Draft a LinkedIn message for this new connection.

PROFILE:
{chr(10).join(context_parts)}

Rules:
- Max 200 characters (this is HARD limit — count carefully)
- Reference ONE specific thing: a post they wrote, their company's product, or a concrete detail
- If they've posted about AI/agents/MCP/LLMs, ALWAYS reference that post specifically
- No "I saw your post" or "I noticed" — just dive straight into the substance
- No pitch. No Prefactor mention unless directly relevant to their work
- Tone: direct, warm, curious. Like a text from a friend who happens to be a founder
- End with a specific question or a sharp observation, never "let me know if..."
- Output ONLY the message text, nothing else. No quotes, no explanation.
""",
            }
        ],
    )
    text = resp.content[0].text.strip().replace("\n", " ")
    text = " ".join(text.split())
    return text[:200]


# ---------------------------------------------------------------------------
# Outreach drafting (linkedin_outreach table)
# ---------------------------------------------------------------------------

OUTREACH_SYSTEM = """Persona: Matt Doughty (CEO, Prefactor.Ai).
Voice: Direct, minimalist, peer-to-peer. UK/Sydney founder.
Task: Write a post-connection LinkedIn message (< 200 characters).

Rules for Authenticity:

1. The Hook: Start with "Hi {{first_name}}," followed immediately by a specific
   technical or business observation about THEIR company or work.

2. No Setup: Never use "I noticed," "Given your role," or "With your background."
   Just dive in.

3. The Assertion: Use "must be" or "must get" to highlight a friction point they
   likely face (e.g., "Those governance gates must be a nightmare to clear").
   It should feel like a peer-to-peer insight.

4. No Fluff: Remove "I'd love to know" or "I'm curious."

5. Mandatory Signature: Always end the message with a simple "Matt".
   No "Cheers" or "Best."

6. Constraint: Strictly under 200 characters.

PRIORITY for what to reference:
1. Their recent posts about AI, agents, MCP, LLMs, or automation — reference a
   specific insight or stat they shared.
2. A specific company initiative, product, or known challenge at their company.
3. Something from their About section or experience that connects to AI agents,
   enterprise automation, or founder life.
4. If nothing specific exists, say something provocative about their industry + AI.

Output ONLY the message text, nothing else. No quotes, no explanation."""


def generate_outreach_draft(outreach_row: dict) -> str:
    """Generate a personalised welcome message using enriched profile data."""
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    full_name = outreach_row.get("full_name") or "Unknown"
    headline = outreach_row.get("headline") or "N/A"

    research = outreach_row.get("research") or {}
    profile = research.get("profile") or {}
    posts = research.get("recent_posts") or []

    context_parts = [
        f"Name: {full_name}",
        f"Headline: {headline}",
    ]

    if profile.get("geo", {}).get("full"):
        context_parts.append(f"Location: {profile['geo']['full']}")
    elif profile.get("locationName"):
        context_parts.append(f"Location: {profile['locationName']}")

    if profile.get("industryName"):
        context_parts.append(f"Industry: {profile['industryName']}")

    if profile.get("summary"):
        context_parts.append(f"About: {profile['summary'][:800]}")

    for exp in (profile.get("experience") or [])[:3]:
        title = exp.get("title", "")
        company = exp.get("companyName", "")
        desc = exp.get("description", "")
        line = f"Role: {title} at {company}"
        if desc:
            line += f" — {desc[:200]}"
        context_parts.append(line)

    if posts:
        context_parts.append("\n--- RECENT LINKEDIN POSTS ---")
        for i, p in enumerate(posts[:5], 1):
            text = p.get("commentary") or p.get("text") or p.get("content", "")
            text = text[:400]
            if text:
                context_parts.append(f"Post {i}: {text}")

    resp = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=400,
        system=OUTREACH_SYSTEM,
        messages=[
            {
                "role": "user",
                "content": f"""Write a post-connection LinkedIn message for this person.

PROFILE:
{chr(10).join(context_parts)}

Remember: "Hi {{first_name}}," + specific observation + "must be"/"must get" assertion + end with "Matt". Under 200 characters strictly.
""",
            }
        ],
    )
    text = resp.content[0].text.strip().replace("\n", " ")
    text = " ".join(text.split())
    return text[:200]


def enrich_and_store(supabase_client: Client, outreach_id: str, row: dict) -> dict:
    """Enrich a connection via LinkdAPI and store the result. Returns updated row."""
    from app.linkdapi import enrich_profile

    username = row.get("public_identifier")
    if not username:
        logger.warning("[outreach:enrich] No public_identifier for %s, skipping enrichment", outreach_id)
        return row

    logger.info("[outreach:enrich] Enriching %s (%s)", row.get("full_name"), username)
    research = enrich_profile(username)

    if research.get("profile"):
        db.update_outreach(outreach_id, {"research": research})
        row["research"] = research
        logger.info("[outreach:enrich] Stored enrichment for %s (posts: %d)",
                    row.get("full_name"), len(research.get("recent_posts", [])))
    else:
        logger.warning("[outreach:enrich] No profile data returned for %s", username)

    return row


def draft_and_update_outreach(supabase_client: Client, outreach_id: str) -> None:
    """Fetch row, enrich, generate draft, transition detected->drafted->awaiting_review, post Slack."""
    from app.slack_bot import post_outreach_approval

    row = (
        supabase_client.table("linkedin_outreach")
        .select("*")
        .eq("id", outreach_id)
        .single()
        .execute()
    ).data

    if row["status"] != "detected":
        logger.warning("Skipping draft for %s — status is %s", outreach_id, row["status"])
        return

    # Enrich via LinkdAPI if not already enriched
    if not row.get("research"):
        row = enrich_and_store(supabase_client, outreach_id, row)

    draft_text = generate_outreach_draft(row)
    logger.info("[outreach:draft] Draft generated for %s (%d chars)", row.get("full_name"), len(draft_text))
    db.update_outreach(outreach_id, {"draft_message": draft_text})

    transition_status(supabase_client, outreach_id, "drafted")
    transition_status(supabase_client, outreach_id, "awaiting_review")

    updated_row = (
        supabase_client.table("linkedin_outreach")
        .select("*")
        .eq("id", outreach_id)
        .single()
        .execute()
    ).data

    post_outreach_approval(supabase_client, updated_row)


def draft_all_detected(supabase_client: Client, limit: int = 100) -> int:
    """Draft messages for detected outreach rows up to the provided limit."""
    rows = db.get_outreach_by_status("detected", limit=limit)
    count = 0
    for row in rows:
        try:
            draft_and_update_outreach(supabase_client, row["id"])
            count += 1
        except Exception:
            logger.exception("Failed to draft outreach for %s", row.get("id"))
    return count
