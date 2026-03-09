from __future__ import annotations

import logging

from openai import OpenAI
from supabase import Client

from app import db
from app.config import OPENAI_API_KEY
from app.state_machine import transition_status

logger = logging.getLogger(__name__)
OPENAI_MODEL = "gpt-4.1"

SYSTEM = """You are drafting LinkedIn connection messages as Matt Doughty, CEO of Prefactor.
Australian-based (English background), direct, no-bullshit, hates corporate speak.
Builds AI agent platforms with Claude Code. Runs podcast "Agents After Dark" about
enterprise AI agents and MCP (Model Context Protocol).

Your job: write a hyper-personalised opening message that makes this person want to reply.
You have their full profile, work history, and recent LinkedIn posts.

PRIORITY ORDER for what to reference:
1. Their recent posts about AI, AI agents, MCP, Claude, LLMs, or automation - quote or
   reference a specific insight they shared. This is gold.
2. A specific company initiative or product they're building - show you understand what
   their company actually does, not just their job title.
3. Something specific from their About section or work experience that connects to
   what Matt cares about (AI agents, enterprise automation, founder life).
4. If none of the above exist, find ANY specific detail that shows you actually read
   their profile - a unique career move, an interesting company, a niche expertise.

NEVER fall back to generic "great to connect" messages. If there's truly nothing
specific to reference, say something provocative about their industry + AI."""


def draft_message(enrichment: dict, api_key: str) -> str:
    """Draft a personalised LinkedIn message using OpenAI."""
    client = OpenAI(api_key=api_key)
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
            line += f" - {desc[:200]}"
        context_parts.append(line)

    if posts:
        context_parts.append("\n--- RECENT LINKEDIN POSTS ---")
        for i, p in enumerate(posts[:5], 1):
            text = p.get("commentary", p.get("text", ""))[:400]
            if text:
                context_parts.append(f"Post {i}: {text}")

    user_prompt = f"""Draft a LinkedIn message for this new connection.

PROFILE:
{chr(10).join(context_parts)}

Rules:
- Reference ONE specific thing: a post they wrote, their company's product, or a concrete detail
- If they've posted about AI/agents/MCP/LLMs, ALWAYS reference that post specifically
- No "I saw your post" or "I noticed" - just dive straight into the substance
- No pitch. No Prefactor mention unless directly relevant to their work
- Tone: direct, warm, curious. Like a text from a friend who happens to be a founder
- End with a specific question or a sharp observation, never "let me know if..."
- Output ONLY the message text, nothing else. No quotes, no explanation.
"""
    resp = client.chat.completions.create(
        model=OPENAI_MODEL,
        max_tokens=600,
        messages=[
            {"role": "developer", "content": SYSTEM},
            {"role": "user", "content": user_prompt},
        ],
    )
    text = (resp.choices[0].message.content or "").strip().replace("\n", " ")
    text = " ".join(text.split())
    return text


# ---------------------------------------------------------------------------
# Outreach drafting (linkedin_outreach table)
# ---------------------------------------------------------------------------

OUTREACH_SYSTEM = """LinkedIn First Message Generation Prompt

Context

Write a LinkedIn message from Matthew Doughty, a founder working with regulated enterprises at the intersection of AI innovation and governance.

The message is sent immediately after a LinkedIn connection is accepted.

The tone must reflect peer-to-peer communication between senior professionals in the same industry. It must not sound like sales outreach, networking, or casual conversation.

Matthew regularly speaks with organisations across the sector and has broad visibility into industry patterns. The message should subtly signal that perspective.

Writing Style Requirements

The writing must follow these rules:

Use clear, precise language

Remove all unnecessary words

Avoid filler or conversational padding

Avoid casual tone

Avoid relaxed or chatty phrasing

Avoid rhetorical flourish

Write in a concise executive style.

Do not use contractions.

Examples:

Do not write:
"I've been seeing..."
Write:
"I have been seeing..."

Do not write:
"Things get messy..."
Write:
"Ownership becomes complicated."

Hard Language Restrictions

Do not use phrases such as:

if you are open to it

if it is helpful

if it is useful

compare notes

swap thoughts

pick your brain

quick chat

would love to

happy to share

just thought I would reach out

Do not ask permission for a conversation.

Do not pitch a product.

Do not sound like a salesperson.

Input Data

You will receive:

Name

Job title

Company

Industry

Country

Signals from the person's profile (posts, talks, articles, company announcements, events attended)

Use these signals to personalise the message.

Message Structure

Write two or three short paragraphs only.

Paragraph 1

Greeting and specific reference to the recipient.

Reference something concrete such as:

a talk they gave

a post they wrote

company news

their role within the organisation

Demonstrate clearly that their profile was reviewed.

Paragraph 2

Provide one sharp industry observation relevant to the recipient's role or sector.

The observation must describe a real operational tension, for example:

ownership conflicts between governance, risk and delivery

AI experimentation versus production deployment

fragmented authority across data, security and product teams

regulatory pressure conflicting with innovation

organisational alignment required for production deployment

Then signal that Matthew already sees this issue across multiple organisations.

Use phrasing such as:

This issue appears repeatedly in discussions with banks and insurers.

Several institutions are addressing this transition.

This pattern appears across multiple regulated organisations.

Do not exaggerate.

Paragraph 3

End with a direct competence-assumption question.

The question must assume the recipient has already encountered the issue.

Examples:

How did this unfold inside your organisation?

How did your team address this when it emerged?

What did this look like internally?

Final Instruction

The message must read as communication between two experienced professionals in the same industry.
It must convey clarity, brevity, and authority without sounding promotional or informal.

Output Format

Only output the final message.

Do not include reasoning steps."""


def generate_outreach_draft(outreach_row: dict) -> str:
    """Generate a personalised welcome message using enriched profile data."""
    client = OpenAI(api_key=OPENAI_API_KEY)
    full_name = outreach_row.get("full_name") or "Unknown"
    first_name = outreach_row.get("first_name") or full_name.split(" ")[0]
    headline = outreach_row.get("headline") or "N/A"

    research = outreach_row.get("research") or {}
    profile = research.get("profile") or {}
    posts = research.get("recent_posts") or []

    context_parts = [
        f"Name: {full_name}",
        f"FirstName: {first_name}",
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
            line += f" - {desc[:200]}"
        context_parts.append(line)

    if posts:
        context_parts.append("\n--- RECENT LINKEDIN POSTS ---")
        for i, p in enumerate(posts[:5], 1):
            text = p.get("commentary") or p.get("text") or p.get("content", "")
            text = text[:400]
            if text:
                context_parts.append(f"Post {i}: {text}")

    user_prompt = f"""Write a post-connection LinkedIn message for this person.

PROFILE:
{chr(10).join(context_parts)}

Rules:
- Use this exact opener: "Hey {first_name} - thank you for connecting."
- Use the profile signals to reference something concrete from the person, such as a talk, post, article, company move, event, or specific operational focus
- Write in two or three short paragraphs only
- Keep the tone concise, precise, and peer-to-peer between senior professionals
- Include one sharp industry observation about a real operational tension relevant to the person
- Signal that Matthew sees this pattern across multiple regulated organisations
- End with a direct competence-assumption question
- End the message with "Matt"
- Do not use contractions
- Do not ask permission for a conversation
- Do not pitch a product
- Output only the final message
"""
    resp = client.chat.completions.create(
        model=OPENAI_MODEL,
        max_tokens=600,
        messages=[
            {"role": "developer", "content": OUTREACH_SYSTEM},
            {"role": "user", "content": user_prompt},
        ],
    )
    text = (resp.choices[0].message.content or "").strip().replace("\n", " ")
    text = " ".join(text.split())
    return text


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
        logger.info(
            "[outreach:enrich] Stored enrichment for %s (posts: %d)",
            row.get("full_name"),
            len(research.get("recent_posts", [])),
        )
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
        logger.warning("Skipping draft for %s - status is %s", outreach_id, row["status"])
        return

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
