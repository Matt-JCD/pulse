"""
Enrichment Data Transformer
============================
Converts raw PhantomBuster Profile Scraper and Activity Extractor CSV output
into the structured format that the drafter expects.

Why this exists:
- The drafter (generate_outreach_draft) reads research["profile"] and
  research["recent_posts"] with specific field names (firstName, headline,
  experience[], summary, etc.)
- PB uses completely different field names (linkedinHeadline, linkedinJobTitle,
  linkedinDescription, etc.)
- This module bridges the gap: PB output → drafter-compatible format

The output matches the drafter's expected format so it works without changes.
"""

from __future__ import annotations

import csv
import io
import logging
import re
from collections import Counter

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Profile Scraper → structured profile dict
# ---------------------------------------------------------------------------

def parse_profile_output(csv_text: str) -> dict:
    """
    Parse Profile Scraper CSV output into a drafter-compatible profile dict.

    PB Profile Scraper returns a CSV with one row per profile. We parse the
    first row and map PB field names to the format generate_outreach_draft
    expects.

    Returns a dict shaped like:
        {
            "firstName": "Sarah",
            "lastName": "Chen",
            "headline": "CISO @ Edwards Lifesciences",
            "locationName": "Irvine, CA",
            "industryName": "Medical Devices",
            "summary": "About section text...",
            "experience": [
                {"title": "CISO", "companyName": "Edwards Lifesciences",
                 "description": "...", "dateRange": "Aug 2022 - Present",
                 "location": "Irvine, CA"},
                ...
            ],
            "education": [
                {"schoolName": "Georgia Tech", "degree": "MS Cybersecurity",
                 "fieldOfStudy": ""},
                ...
            ],
            "skills": ["Cybersecurity", "AI Governance", ...],
            "followerCount": 10171,
            "connectionCount": 10216,
            "company": {
                "name": "Edwards Lifesciences",
                "description": "...",
                "industry": "Medical Devices",
                "size": "10,001+ employees",
                "website": "https://...",
                "tagline": "...",
                "followerCount": 12345,
                "headquarter": "US",
                "founded": "1958",
                "specialities": "...",
            },
        }
    """
    rows = _parse_csv(csv_text)
    if not rows:
        log.warning("Profile Scraper returned empty CSV")
        return {}

    row = rows[0]

    # Build experience list — PB gives current + 1 previous role
    experience = []
    if row.get("linkedinJobTitle"):
        experience.append({
            "title": row["linkedinJobTitle"],
            "companyName": row.get("companyName", ""),
            "description": row.get("linkedinJobDescription", ""),
            "dateRange": row.get("linkedinJobDateRange", ""),
            "location": row.get("linkedinJobLocation", ""),
        })
    if row.get("linkedinPreviousJobTitle"):
        experience.append({
            "title": row["linkedinPreviousJobTitle"],
            "companyName": row.get("previousCompanyName", ""),
            "description": row.get("linkedinPreviousJobDescription", ""),
            "dateRange": row.get("linkedinPreviousJobDateRange", ""),
            "location": row.get("linkedinPreviousJobLocation", ""),
        })

    # Build education list — PB gives current + 1 previous school
    education = []
    if row.get("linkedinSchoolName"):
        education.append({
            "schoolName": row["linkedinSchoolName"],
            "degree": row.get("linkedinSchoolDegree", ""),
            "fieldOfStudy": "",
        })
    if row.get("linkedinPreviousSchoolName"):
        education.append({
            "schoolName": row["linkedinPreviousSchoolName"],
            "degree": row.get("linkedinPreviousSchoolDegree", ""),
            "fieldOfStudy": "",
        })

    # Skills — PB returns comma-separated string
    skills_raw = row.get("linkedinSkillsLabel", "")
    skills = [s.strip() for s in skills_raw.split(",") if s.strip()]

    # Company data — useful context for the drafter
    company = {}
    if row.get("linkedinCompanyName"):
        company = {
            "name": row.get("linkedinCompanyName", ""),
            "description": row.get("linkedinCompanyDescription", ""),
            "industry": row.get("linkedinCompanyIndustry", ""),
            "size": row.get("linkedinCompanySize", ""),
            "website": row.get("linkedinCompanyWebsite", ""),
            "tagline": row.get("linkedinCompanyTagline", ""),
            "followerCount": _safe_int(row.get("linkedinCompanyFollowerCount")),
            "headquarter": row.get("linkedinCompanyHeadquarter", ""),
            "founded": row.get("linkedinCompanyFounded", ""),
            "specialities": row.get("linkedinCompanySpecialities", ""),
        }

    return {
        "firstName": row.get("firstName", ""),
        "lastName": row.get("lastName", ""),
        "headline": row.get("linkedinHeadline", ""),
        "locationName": row.get("location", ""),
        "industryName": row.get("companyIndustry", ""),
        "summary": row.get("linkedinDescription", ""),
        "experience": experience,
        "education": education,
        "skills": skills,
        "followerCount": _safe_int(row.get("linkedinFollowersCount")),
        "connectionCount": _safe_int(row.get("linkedinConnectionsCount")),
        "profileUrl": row.get("profileUrl") or row.get("linkedinProfileUrl", ""),
        "profileImageUrl": row.get("linkedinProfileImageUrl", ""),
        "company": company,
    }


# ---------------------------------------------------------------------------
# Activity Extractor → structured activity dict
# ---------------------------------------------------------------------------

def parse_activity_output(csv_text: str) -> dict:
    """
    Parse Activity Extractor CSV output into a structured activity dict.

    PB Activity Extractor returns a CSV with one row per post/activity.
    We parse all rows and produce:
        {
            "recentPosts": [
                {
                    "postUrl": "https://...",
                    "text": "Post content...",
                    "type": "post",
                    "likeCount": 245,
                    "commentCount": 12,
                    "repostCount": 3,
                    "viewCount": 1500,
                    "date": "2026-03-11T07:36:42.484Z",
                    "action": "Post",
                    "author": "Matt Doughty",
                    "authorUrl": "https://...",
                    "isRepost": false,
                },
                ...
            ],
            "topThemes": ["AI agents", "hackathons", ...],
            "engagementLevel": "high",
        }
    """
    rows = _parse_csv(csv_text)
    if not rows:
        log.warning("Activity Extractor returned empty CSV")
        return {}

    posts = []
    for row in rows:
        action = row.get("action", "Post")
        is_repost = "repost" in action.lower()

        posts.append({
            "postUrl": row.get("postUrl", ""),
            "text": row.get("postContent", ""),
            "type": _normalize_post_type(row.get("type", "Text")),
            "likeCount": _safe_int(row.get("likeCount")),
            "commentCount": _safe_int(row.get("commentCount")),
            "repostCount": _safe_int(row.get("repostCount")),
            "viewCount": _safe_int(row.get("viewCount")),
            "date": row.get("postTimestamp", ""),
            "action": action,
            "author": row.get("author", ""),
            "authorUrl": row.get("authorUrl", ""),
            "isRepost": is_repost,
        })

    top_themes = derive_themes(posts)
    engagement = calculate_engagement_level(posts)

    return {
        "recentPosts": posts,
        "topThemes": top_themes,
        "engagementLevel": engagement,
    }


# ---------------------------------------------------------------------------
# Theme extraction
# ---------------------------------------------------------------------------

# Keywords we care about — grouped by theme
THEME_KEYWORDS: dict[str, list[str]] = {
    "AI agents": ["agent", "agentic", "agents"],
    "AI governance": ["governance", "guardrails", "compliance", "audit", "responsible ai"],
    "cybersecurity": ["cybersecurity", "security", "ciso", "infosec", "zero trust"],
    "LLMs": ["llm", "large language model", "gpt", "claude", "gemini", "anthropic", "openai"],
    "MCP": ["mcp", "model context protocol"],
    "startups": ["startup", "founder", "venture", "seed", "series a", "antler"],
    "hackathons": ["hackathon", "hack"],
    "enterprise AI": ["enterprise ai", "production ai", "poc to production"],
    "healthcare AI": ["healthcare", "medtech", "healthtech", "patient", "clinical"],
    "fintech": ["fintech", "financial services", "banking", "payments"],
    "data engineering": ["data engineering", "data pipeline", "etl", "data platform"],
    "cloud infrastructure": ["cloud", "aws", "azure", "gcp", "kubernetes", "devops"],
    "automation": ["automation", "workflow", "rpa", "orchestration"],
    "podcasting": ["podcast", "episode"],
}


def derive_themes(posts: list[dict], max_themes: int = 5) -> list[str]:
    """
    Extract top themes from post content using keyword matching.

    Why simple keyword matching instead of LLM-based extraction?
    - It runs on every enrichment, so it needs to be fast and free
    - The themes feed into the Slack approval card as context, not the LLM prompt
    - The LLM gets the full post text anyway, so it does its own deeper analysis
    """
    if not posts:
        return []

    theme_counts: Counter = Counter()

    for post in posts:
        text = (post.get("text") or "").lower()
        if not text:
            continue
        for theme, keywords in THEME_KEYWORDS.items():
            if any(kw in text for kw in keywords):
                theme_counts[theme] += 1

    # Return themes that appeared in at least 1 post, sorted by frequency
    return [theme for theme, _ in theme_counts.most_common(max_themes)]


# ---------------------------------------------------------------------------
# Engagement level
# ---------------------------------------------------------------------------

def calculate_engagement_level(posts: list[dict]) -> str:
    """
    Classify engagement as high/medium/low based on average likes+comments.

    Thresholds calibrated for LinkedIn B2B content:
    - High: 20+ avg engagement (strong thought leadership presence)
    - Medium: 5-19 avg engagement (active but not viral)
    - Low: <5 avg engagement (mostly lurking or sharing)
    """
    if not posts:
        return "low"

    total = sum(
        (p.get("likeCount") or 0) + (p.get("commentCount") or 0)
        for p in posts
    )
    avg = total / len(posts)

    if avg >= 20:
        return "high"
    elif avg >= 5:
        return "medium"
    else:
        return "low"


# ---------------------------------------------------------------------------
# Merge into final enrichment payload
# ---------------------------------------------------------------------------

def merge_enrichment(
    contact: dict,
    profile: dict,
    activity: dict,
) -> dict:
    """
    Merge contact info, profile data, and activity data into the enrichment
    payload stored in the DB's `research` column.

    The output has two top-level keys that generate_outreach_draft reads:
    - "profile": drafter-compatible profile dict (from parse_profile_output)
    - "recent_posts": list of post dicts (from parse_activity_output)

    Plus enrichment-only fields for the Slack approval card:
    - "enrichment_meta": themes, engagement level, education, company context
    """
    # Build the recent_posts list in the format the drafter expects
    # The drafter reads p.get("commentary") or p.get("text") or p.get("content")
    recent_posts = []
    for post in (activity.get("recentPosts") or []):
        recent_posts.append({
            "text": post.get("text", ""),
            "commentary": post.get("text", ""),  # drafter checks this first
            "postUrl": post.get("postUrl", ""),
            "type": post.get("type", ""),
            "likeCount": post.get("likeCount", 0),
            "commentCount": post.get("commentCount", 0),
            "repostCount": post.get("repostCount", 0),
            "viewCount": post.get("viewCount", 0),
            "date": post.get("date", ""),
            "action": post.get("action", ""),
            "author": post.get("author", ""),
            "isRepost": post.get("isRepost", False),
        })

    # Enrichment metadata for Slack card (not consumed by drafter)
    enrichment_meta = {
        "topThemes": activity.get("topThemes", []),
        "engagementLevel": activity.get("engagementLevel", "low"),
        "education": profile.get("education", []),
        "company": profile.get("company", {}),
        "followerCount": profile.get("followerCount", 0),
        "connectionCount": profile.get("connectionCount", 0),
        "skills": profile.get("skills", []),
        "source": "phantombuster",
    }

    return {
        "profile": profile,
        "recent_posts": recent_posts,
        "enrichment_meta": enrichment_meta,
    }


# ---------------------------------------------------------------------------
# Convenience: full enrichment from PB CSV outputs
# ---------------------------------------------------------------------------

def build_enrichment_from_pb(
    profile_csv: str | None,
    activity_csv: str | None,
) -> dict:
    """
    One-shot convenience function: takes raw CSV strings from both PB phantoms
    and returns the merged enrichment dict ready to store in the DB.

    Handles partial data — if either CSV is None/empty, we still produce
    enrichment from whatever we have.
    """
    profile = parse_profile_output(profile_csv) if profile_csv else {}
    activity = parse_activity_output(activity_csv) if activity_csv else {}

    contact = {
        "firstName": profile.get("firstName", ""),
        "lastName": profile.get("lastName", ""),
        "profileUrl": profile.get("profileUrl", ""),
    }

    return merge_enrichment(contact, profile, activity)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _parse_csv(csv_text: str) -> list[dict]:
    """Parse CSV text into a list of dicts. Returns empty list on failure."""
    if not csv_text or not csv_text.strip():
        return []
    try:
        reader = csv.DictReader(io.StringIO(csv_text))
        return list(reader)
    except Exception:
        log.exception("Failed to parse CSV")
        return []


def _safe_int(value) -> int:
    """Convert a value to int, returning 0 on failure."""
    if value is None or value == "":
        return 0
    try:
        return int(value)
    except (ValueError, TypeError):
        return 0


def _normalize_post_type(raw_type: str) -> str:
    """Normalize PB post type to lowercase standard types."""
    mapping = {
        "Image": "post",
        "Text": "post",
        "Article": "article",
        "Video (LinkedIn Source)": "video",
        "Video": "video",
        "Comment": "comment",
        "Reaction": "reaction",
    }
    return mapping.get(raw_type, raw_type.lower())
