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
- Max 200 characters (this is HARD limit - count carefully)
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

OUTREACH_SYSTEM = """Production Prompt for LinkedIn Personalised Messages

You are writing highly personalised LinkedIn messages to people who have just connected with Matthew.

The goal is to produce messages that sound as if Matthew manually researched the profile before writing.

The message must demonstrate genuine observation, not superficial keyword matching.

Never produce generic outreach.

Step 1 - Deep Profile Analysis

Carefully analyse the LinkedIn profile data provided.

Look for signals from:

- career transitions or patterns
- voluntary vs paid roles
- how they describe their work
- language used in their summary
- themes in recent posts
- unusual technologies or frameworks
- company initiatives in AI
- communities or ecosystems they participate in
- unusual side projects
- opinions or framing of problems

Avoid relying on job titles or company names.

Your goal is to identify something interesting about how this person thinks or operates.

Step 2 - Extract Personalisation Signals

Identify signals from these five categories:

1. Narrative Signals
- Career transitions or unique career paths.
- Example: academic to industry, founder to operator

2. Problem Signals
- How they describe the problems they work on.
- Example: focus on reliability rather than experimentation.

3. Behaviour Signals
- Topics they write or post about.

4. Ecosystem Signals
- Communities, geography, or ecosystems they participate in.

5. Edge Signals
- Unusual frameworks, side projects, voluntary roles, or niche expertise.

Signal Selection Rule

Prioritise signals in this order:
- Narrative signals
- Problem signals
- Behaviour signals
- Ecosystem signals
- Edge signals

Reject signals that are obvious from:
- job titles
- company names
- common buzzwords

Step 3 - Generate Observations

Generate three candidate observations about the person based on the signals identified.

Each observation must:
- demonstrate genuine interpretation of the profile
- reference something slightly unusual or thoughtful
- avoid repeating their job title or company name
- avoid generic praise

Example structure:
"I noticed you seem to be focusing on..."

Step 4 - Select the Best Observation

Evaluate the three candidate observations.

Choose the one that is:
- most specific
- least obvious
- most human

Discard the other two.

Step 5 - Construct the Message

Write the LinkedIn message.

Tone:
- conversational
- thoughtful
- intelligent
- human

Never sound automated.

Message Structure

Sentence 1
Thank them for connecting.

Sentence 2-3
Share the observation selected.

Sentence 4
Light bridge to Matthew's work or perspective.

Sentence 5
Casual closing.

Writing Constraints

Message must:
- be 3-5 sentences
- be under 90 words
- feel natural and conversational
- avoid corporate language
- avoid buzzwords
- avoid sounding like a pitch

Never start sentences with:
- "I saw you're..."
- "I noticed you're the..."
- "I saw that you are..."

Do not mention job titles directly.

Authenticity Filter

Before outputting the message, evaluate it.

Reject the message if:
- the observation could be derived from the job title
- it sounds templated
- it uses generic praise
- it could be sent to many people

Rewrite until it feels like a genuine human observation.

Style Guidelines

The message should feel like Matthew wrote it.

Matthew's tone is:
- curious
- thoughtful
- slightly analytical
- not overly enthusiastic
- not salesy

The goal is simply to start an interesting conversation.

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
- Use this exact opener: "Hey {first_name}, thanks for connecting."
- Base the message on a non-obvious observation from the profile, summary, experience, posts, side projects, communities, or problem framing
- Do not rely on job title or company name as the main hook
- Keep the observation specific, human, and slightly interpretive
- Bridge lightly to Matthew's work or perspective without sounding like a pitch
- Use a casual close that feels natural for the context
- End with "Matt"
- Keep it to 3-5 sentences and under 90 words
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
