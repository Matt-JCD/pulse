"""
PhantomBuster Chain Orchestrator
================================
Runs Profile Scraper + Activity Extractor in parallel for a given LinkedIn
profile URL, polls each phantom until completion, and returns combined output.

Why polling instead of webhooks?
- Enrichment happens inline during the draft job — we need results before
  we can call the LLM, so synchronous polling is simpler than coordinating
  two async webhook callbacks.
- Webhooks are still used for connection detection and send results, where
  the caller doesn't need to wait.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass

from app.phantombuster import (
    fetch_agent_status,
    launch_profile_scraper,
    launch_activity_extractor,
    download_result_csv,
)
from app.enrichment import build_enrichment_from_pb

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
DEFAULT_TIMEOUT_S = 300   # 5 minutes max per phantom
POLL_INTERVAL_S = 10      # Check every 10 seconds


# ---------------------------------------------------------------------------
# Data classes for type safety
# ---------------------------------------------------------------------------
@dataclass
class EnrichmentResult:
    """Combined output from Profile Scraper + Activity Extractor."""
    research: dict       # Merged enrichment dict ready for DB storage
    profile_ok: bool     # True if profile scraper succeeded
    activity_ok: bool    # True if activity extractor succeeded
    errors: list[str]    # Any error messages from failed phantoms


# ---------------------------------------------------------------------------
# Polling
# ---------------------------------------------------------------------------

def _poll_until_complete(
    agent_id: str,
    launch_time: float,
    timeout: int = DEFAULT_TIMEOUT_S,
    interval: int = POLL_INTERVAL_S,
) -> dict:
    """
    Poll a PhantomBuster agent until the *current* run finishes.

    How it works:
    - We compare `lastEndTimestamp` against `launch_time` to ensure we're
      seeing results from the run we just launched — not stale data from
      a previous run.
    - PB's `lastEndTimestamp` is a Unix timestamp (seconds). We only
      consider the run done when this is newer than our launch time AND
      `runningContainers` is 0.

    Why this matters:
    - Without this check, the poller can see stale `lastEndType: "finished"`
      from a previous run before the new container spins up, and return
      immediately with the wrong person's data.

    Returns the full agent status dict (contains s3Folder and orgS3Folder
    needed to download result CSV).
    """
    start = time.time()
    # Skip the first check — give PB a moment to register the launch
    time.sleep(5)

    while True:
        elapsed = time.time() - start
        if elapsed > timeout:
            raise TimeoutError(
                f"PhantomBuster agent {agent_id} did not complete within {timeout}s"
            )

        status = fetch_agent_status(agent_id)

        running = status.get("runningContainers", 0)
        end_type = status.get("lastEndType", "")
        end_ts = status.get("lastEndTimestamp", 0)

        # Only consider done if the end timestamp is from AFTER we launched
        is_current_run = end_ts and end_ts > launch_time

        if running == 0 and end_type and is_current_run:
            log.info(
                "PB agent %s completed: %s (%.1fs)",
                agent_id, end_type, elapsed,
            )
            return status

        log.debug(
            "PB agent %s still running (%.0fs elapsed, containers=%d, endTs=%s, launchTime=%.0f)",
            agent_id, elapsed, running, end_ts, launch_time,
        )
        time.sleep(interval)


def _download_csv(status: dict) -> str:
    """
    Download the result.csv from S3 using the agent's s3Folder and orgS3Folder.

    PB stores all phantom results as CSV files on their S3 bucket. The path
    is: s3://phantombuster/{orgS3Folder}/{s3Folder}/result.csv
    """
    s3_folder = status.get("s3Folder", "")
    org_s3_folder = status.get("orgS3Folder", "")
    if not s3_folder or not org_s3_folder:
        raise ValueError("Agent status missing s3Folder or orgS3Folder")
    return download_result_csv(s3_folder, org_s3_folder)


# ---------------------------------------------------------------------------
# Parallel enrichment
# ---------------------------------------------------------------------------

def _run_profile_scraper(profile_url: str, timeout: int) -> tuple[str | None, str | None]:
    """
    Launch Profile Scraper and wait for results.
    Returns (csv_text, error_message). csv_text is None on failure.
    """
    try:
        from app.config import PB_PROFILE_SCRAPER_ID

        if not PB_PROFILE_SCRAPER_ID:
            return None, "PB_PROFILE_SCRAPER_ID not configured"

        launch_time = time.time()
        launch_profile_scraper(profile_url)
        log.info("Profile Scraper launched for %s", profile_url)

        status = _poll_until_complete(PB_PROFILE_SCRAPER_ID, launch_time, timeout=timeout)
        csv_text = _download_csv(status)
        return csv_text, None

    except TimeoutError as e:
        log.warning("Profile Scraper timed out for %s: %s", profile_url, e)
        return None, str(e)
    except Exception as e:
        log.error("Profile Scraper failed for %s: %s", profile_url, e)
        return None, str(e)


def _run_activity_extractor(
    profile_url: str, num_activities: int, timeout: int,
) -> tuple[str | None, str | None]:
    """
    Launch Activity Extractor and wait for results.
    Returns (csv_text, error_message). csv_text is None on failure.
    """
    try:
        from app.config import PB_ACTIVITY_EXTRACTOR_ID

        if not PB_ACTIVITY_EXTRACTOR_ID:
            return None, "PB_ACTIVITY_EXTRACTOR_ID not configured"

        launch_time = time.time()
        launch_activity_extractor(profile_url, num_activities)
        log.info("Activity Extractor launched for %s", profile_url)

        status = _poll_until_complete(PB_ACTIVITY_EXTRACTOR_ID, launch_time, timeout=timeout)
        csv_text = _download_csv(status)
        return csv_text, None

    except TimeoutError as e:
        log.warning("Activity Extractor timed out for %s: %s", profile_url, e)
        return None, str(e)
    except Exception as e:
        log.error("Activity Extractor failed for %s: %s", profile_url, e)
        return None, str(e)


def enrich_contact(
    profile_url: str,
    num_activities: int = 10,
    timeout: int = DEFAULT_TIMEOUT_S,
) -> EnrichmentResult:
    """
    Run Profile Scraper + Activity Extractor for a single contact.

    Why parallel?
    - The two phantoms are independent — Activity Extractor doesn't need
      Profile Scraper output to run. Running them in parallel cuts total
      wait time roughly in half.

    Why ThreadPoolExecutor instead of asyncio?
    - PB polling uses time.sleep() which blocks. This runs inside a FastAPI
      background task (already off the main event loop), so plain threads
      are simpler and more predictable.

    Graceful degradation:
    - If one phantom fails, we still build enrichment from whatever we have.
    - The caller checks profile_ok / activity_ok to know what's available.

    Returns an EnrichmentResult with a `research` dict that can be stored
    directly in the DB's `research` column.
    """
    from concurrent.futures import ThreadPoolExecutor

    errors: list[str] = []

    with ThreadPoolExecutor(max_workers=2) as executor:
        profile_future = executor.submit(
            _run_profile_scraper, profile_url, timeout,
        )
        activity_future = executor.submit(
            _run_activity_extractor, profile_url, num_activities, timeout,
        )

        profile_csv, profile_err = profile_future.result()
        activity_csv, activity_err = activity_future.result()

    if profile_err:
        errors.append(f"Profile Scraper: {profile_err}")
    if activity_err:
        errors.append(f"Activity Extractor: {activity_err}")

    # Build the merged enrichment dict from whatever CSV data we got
    research = build_enrichment_from_pb(profile_csv, activity_csv)

    return EnrichmentResult(
        research=research,
        profile_ok=profile_err is None,
        activity_ok=activity_err is None,
        errors=errors,
    )
