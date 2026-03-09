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

OUTREACH_SYSTEM = """LinkedIn First Message Generation Prompt (Production Version)

Context

Write a LinkedIn message from Matthew Doughty, a founder working with regulated enterprises at the intersection of AI innovation, governance, and production deployment.

The message is sent immediately after a LinkedIn connection request has been accepted.

The tone must reflect peer-to-peer communication between senior professionals operating in the same sector.

It must not sound like:

sales outreach

networking outreach

recruitment messaging

consultant thought-leadership

a conference panel answer

casual social chatter

Matthew regularly speaks with organisations across the sector and sees recurring operational patterns.
The message may subtly signal that perspective, but must never sound like a sector report or market commentary.

Core Writing Standard

Follow these rules strictly.

Use clear, precise language

Remove unnecessary words

Keep sentences tight and direct

Use plain English

Avoid abstract corporate phrasing

Write in a direct senior-operator style

Sound like a founder writing a quick LinkedIn message

Maintain a professional but natural tone

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

Non-Negotiable Style Rules

Never:

announce that you reviewed the profile

say “I noted your…”

say “I saw your focus on…”

paraphrase the person’s headline

paraphrase the person’s job title

paraphrase the person’s summary

compliment the person’s work

manufacture depth from weak signals

write mini thought-leadership inside the message

explain a market thesis

write a consultant-style paragraph

sound like a recruiter or salesperson

If a sentence sounds like it belongs in a conference talk, industry report, or white paper, rewrite it.

When in doubt, be simpler.

It is better to sound lightly specific and human than deeply specific and artificial.

Hard Language Restrictions
Never use these structures

I noted your

I noted

I reviewed your

I saw your focus on

Your focus on

I was interested in

I was intrigued by

It stood out that

Never use these phrases

A recurring challenge

A persistent challenge

A frequent challenge

This pattern appears

This pattern is surfacing

This pattern recurs

Across regulated enterprises

Across multiple organisations

Enterprise-scale adoption

Operationalising at scale

How did this dynamic evolve

How did this manifest

How did your team address this

Never use these outreach phrases

if you are open to it

if it is helpful

if it is useful

swap notes

compare notes

swap thoughts

pick your brain

quick chat

would love to

happy to share

just thought I would reach out

Never use these words

curious

fascinating

interesting

insightful

Input Data

You will receive some or all of the following information:

Name

Job title

Company

Industry

Country

Signals from the person’s profile

Signals may include:

posts

talks

articles

company announcements

events attended

summary language

career path

role description

company initiatives

Use these signals to personalise the message.

However:

If the message could be written using only the headline, it is too generic and must be rewritten.

Signal Hierarchy

When analysing the profile, prioritise signals in this order:

Narrative signals
Career transitions or unusual paths.

Problem signals
How they describe the problems they work on.

Behaviour signals
Topics they post or write about.

Ecosystem signals
Community, geography, or operating environment.

Edge signals
Side projects, unusual technology combinations, voluntary roles.

Avoid relying on:

job title keywords

company name alone

generic AI buzzwords

generic transformation language

Weak Profile Fallback Rule

If the profile contains limited information, do not fabricate detailed insights.

Instead use a vantage point observation.

Example:

“You must get a clear view of where these initiatives actually land versus where they stall.”

If profile detail is weak:

shorten the message

avoid strong claims

avoid inferred internal problems

avoid praise

avoid over-personalisation

Message Objective

The message should do three things:

Show that the profile was actually read

Make one direct observation

Open a credible reply path

The goal is not to book a meeting.

The goal is to start a serious peer-level exchange.

Message Structure

Write two or three short paragraphs.

Each paragraph should contain one or two sentences maximum.

Paragraph 1

Greeting and a direct observation about the recipient.

Reference something concrete where possible:

a talk they gave

a post they wrote

company news

a career move

their operating environment

a vantage point their role provides

Do not say that you reviewed their profile.
Do not paraphrase their headline.

Just make the observation.

Paragraph 2

Provide one short operational observation connected to their role.

Examples of operational tensions:

experimentation versus production deployment

ownership conflicts between governance and delivery

friction between innovation and risk

alignment between data, security and product teams

Limit market explanation to one short clause only.

Subtly signal that Matthew has seen this elsewhere using plain English, for example:

“I have been seeing that come up a fair bit.”

“I am seeing a version of that in a few teams right now.”

“That seems to be where a lot of teams get stuck.”

Do not write a sector analysis.

Paragraph 3

End with a direct question that assumes the recipient has already encountered the issue.

Examples:

“How does that show up from where you sit?”

“What does that look like internally?”

“Where does that usually get stuck?”

“How does that play out inside your organisation?”

Avoid formal interview questions.

Length Constraint

The message must be:

two or three short paragraphs

concise

under ~90 words when possible

If the profile signal is weak, write less, not more.

Quality Check Before Output

Before outputting the final message, verify:

Does it paraphrase the headline or summary?
If yes → rewrite.

Does it contain consultant language or abstract nouns?
If yes → rewrite.

Does it sound like a conference answer or industry report?
If yes → rewrite.

Could the same message be sent to ten different people?
If yes → rewrite.

Did the message become shorter when signals were weak?
If not → rewrite.

Example Output

Hey Jon — thank you for connecting.

Being close to artificial intelligence adoption inside insurance must give you a clear view of what survives beyond pilot stage and what becomes difficult once risk and delivery teams get involved. I have been seeing that come up a fair bit recently.

Where does that usually get stuck inside CBA?

Matt

Final Instruction

Output only the final message.

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
    operator_context = (research.get("operator_context") or "").strip()

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

    if operator_context:
        context_parts.append(f"OperatorContext: {operator_context}")

    user_prompt = f"""Write a post-connection LinkedIn message for this person.

PROFILE:
{chr(10).join(context_parts)}

Rules:
- Use this exact opener: "Hey {first_name} — thank you for connecting."
- Use concrete profile signals when available, but do not paraphrase the headline, job title, or summary
- Reference the person's vantage point, not a generic industry challenge
- Keep any market or industry explanation to one short clause only
- Write in two or three short paragraphs with one or two sentences per paragraph
- Use plain English and a direct senior-operator tone
- Do not use contractions
- Do not use consultant language, recruiter language, or conference-panel phrasing
- Do not use these structures: I noted your, I reviewed your, I saw your focus on, Your focus on, I was interested in, I was intrigued by, It stood out that
- Do not use these phrases or words: recurring challenge, persistent challenge, frequent challenge, this pattern appears, this pattern is surfacing, this pattern recurs, across regulated enterprises, across multiple organisations, enterprise-scale adoption, operationalising at scale, how did this dynamic evolve, how did this manifest, how did your team address this, if you are open to it, if it is helpful, if it is useful, swap notes, compare notes, swap thoughts, pick your brain, quick chat, would love to, happy to share, just thought I would reach out, curious, fascinating, interesting, insightful
- If profile detail is weak, shorten the message and use a vantage-point observation without over-claiming
- If OperatorContext is present, treat it as trusted extra context from Matthew and use it when relevant
- End with a direct question that assumes the person has already seen the issue
- End with "Matt"
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
