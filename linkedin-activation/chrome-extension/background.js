// LinkedIn Connection Detector — Background Service Worker
// Runs hourly, fetches connections via Voyager API, POSTs new ones to webhook

const WEBHOOK_URL = "https://pulse-by-prefactor-1.onrender.com/webhook/new-connections";
const CHECK_INTERVAL_MINUTES = 60;
const CONNECTIONS_PER_PAGE = 40;
const MAX_PAGES = 5; // 200 connections max per check
const STORAGE_KEY = "known_connections";
const LOG_KEY = "check_log";

// --- LinkedIn Voyager API ---

async function getLinkedInCookies() {
  const cookies = await chrome.cookies.getAll({ domain: ".linkedin.com" });
  const csrfCookie = cookies.find((c) => c.name === "JSESSIONID");
  const liAt = cookies.find((c) => c.name === "li_at");
  if (!csrfCookie || !liAt) return null;
  // JSESSIONID is stored with quotes: "ajax:123..."
  const csrf = csrfCookie.value.replace(/"/g, "");
  return { csrf, liAt: liAt.value };
}

async function fetchConnections(csrf, start = 0, count = CONNECTIONS_PER_PAGE) {
  const url = new URL("https://www.linkedin.com/voyager/api/relationships/dash/connections");
  url.searchParams.set("decorationId", "com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithProfile-16");
  url.searchParams.set("count", count.toString());
  url.searchParams.set("q", "search");
  url.searchParams.set("start", start.toString());

  const resp = await fetch(url.toString(), {
    headers: {
      "csrf-token": csrf,
      "x-restli-protocol-version": "2.0.0",
    },
    credentials: "include",
  });

  if (!resp.ok) {
    throw new Error(`LinkedIn API ${resp.status}: ${resp.statusText}`);
  }

  return resp.json();
}

function parseConnections(apiResponse) {
  const elements = apiResponse.elements || [];
  return elements.map((el) => {
    const mini = el.connectedMemberResolutionResult || {};
    const entityUrn = mini.entityUrn || el.connectedMember || "";
    const publicIdentifier = mini.publicIdentifier || "";
    const firstName = mini.firstName || "";
    const lastName = mini.lastName || "";
    const headline = mini.headline || "";
    const profilePicture = mini.profilePicture?.displayImageReference?.vectorImage?.rootUrl || "";

    return {
      linkedin_urn: entityUrn,
      public_identifier: publicIdentifier,
      first_name: firstName,
      last_name: lastName,
      headline: headline,
      profile_picture: profilePicture,
    };
  }).filter((c) => c.linkedin_urn);
}

// --- Core Logic ---

async function checkForNewConnections() {
  const startTime = Date.now();
  console.log("[LinkedIn Detector] Starting connection check...");

  const creds = await getLinkedInCookies();
  if (!creds) {
    console.error("[LinkedIn Detector] Not logged into LinkedIn — no cookies found");
    await addLog("error", "Not logged into LinkedIn");
    return { error: "Not logged into LinkedIn" };
  }

  // Fetch recent connections (paginated)
  let allConnections = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    try {
      const data = await fetchConnections(creds.csrf, page * CONNECTIONS_PER_PAGE);
      const parsed = parseConnections(data);
      allConnections = allConnections.concat(parsed);

      // Stop if we got fewer than a full page
      if (parsed.length < CONNECTIONS_PER_PAGE) break;
    } catch (err) {
      console.error(`[LinkedIn Detector] Page ${page} fetch failed:`, err);
      if (page === 0) {
        await addLog("error", `API call failed: ${err.message}`);
        return { error: err.message };
      }
      break; // Use what we have from previous pages
    }
  }

  console.log(`[LinkedIn Detector] Fetched ${allConnections.length} connections`);

  // Load known connections from storage
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const knownUrns = new Set(stored[STORAGE_KEY] || []);

  // Find new ones
  const newConnections = allConnections.filter((c) => !knownUrns.has(c.linkedin_urn));

  if (newConnections.length === 0) {
    console.log("[LinkedIn Detector] No new connections");
    await addLog("ok", `Checked ${allConnections.length} connections, 0 new`);
    return { checked: allConnections.length, new: 0 };
  }

  console.log(`[LinkedIn Detector] Found ${newConnections.length} new connection(s)!`);

  // POST to webhook
  try {
    const resp = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connections: newConnections }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Webhook ${resp.status}: ${text}`);
    }

    const result = await resp.json();
    console.log("[LinkedIn Detector] Webhook response:", result);
  } catch (err) {
    console.error("[LinkedIn Detector] Webhook POST failed:", err);
    await addLog("error", `Webhook failed: ${err.message} (${newConnections.length} new connections not sent)`);
    return { error: err.message, new: newConnections.length };
  }

  // Update known connections (add all fetched, not just new)
  const updatedUrns = [...knownUrns, ...allConnections.map((c) => c.linkedin_urn)];
  const uniqueUrns = [...new Set(updatedUrns)];
  await chrome.storage.local.set({ [STORAGE_KEY]: uniqueUrns });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  await addLog("ok", `Found ${newConnections.length} new of ${allConnections.length} total (${elapsed}s)`);

  return { checked: allConnections.length, new: newConnections.length };
}

// --- Logging ---

async function addLog(status, message) {
  const stored = await chrome.storage.local.get(LOG_KEY);
  const logs = stored[LOG_KEY] || [];
  logs.unshift({
    time: new Date().toISOString(),
    status,
    message,
  });
  // Keep last 50 entries
  await chrome.storage.local.set({ [LOG_KEY]: logs.slice(0, 50) });
}

// --- Alarm Setup ---

chrome.alarms.create("check-connections", {
  delayInMinutes: 1, // First check 1 min after install
  periodInMinutes: CHECK_INTERVAL_MINUTES,
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "check-connections") {
    checkForNewConnections();
  }
});

// --- Message Handler (for popup) ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "check-now") {
    checkForNewConnections().then(sendResponse);
    return true; // Keep channel open for async response
  }
  if (msg.action === "get-logs") {
    chrome.storage.local.get(LOG_KEY).then((stored) => {
      sendResponse(stored[LOG_KEY] || []);
    });
    return true;
  }
  if (msg.action === "get-stats") {
    chrome.storage.local.get(STORAGE_KEY).then((stored) => {
      sendResponse({ known: (stored[STORAGE_KEY] || []).length });
    });
    return true;
  }
  if (msg.action === "reset") {
    chrome.storage.local.remove([STORAGE_KEY, LOG_KEY]).then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }
});
