// LinkedIn Connection Detector - Background Service Worker

const BACKEND_URL = "https://pulse-by-prefactor-1.onrender.com";
const WEBHOOK_URL = `${BACKEND_URL}/webhook/new-connections`;
const CHECK_INTERVAL_MINUTES = 60;
const CONNECTIONS_PER_PAGE = 40;
const MAX_PAGES = 3;
const MAX_NEW_CONNECTIONS_PER_CHECK = 20;
const STORAGE_KEY = "known_connections";
const LOG_KEY = "check_log";
const VIEWER_URN_KEY = "viewer_profile_urn";
const BASELINE_KEY = "connection_baseline_initialized";
const BASELINE_AT_KEY = "connection_baseline_seeded_at";
const LINKEDIN_OPEN_CHECK_KEY = "last_linkedin_open_check_day";

async function getLinkedInCookies() {
  const cookies = await chrome.cookies.getAll({ domain: ".linkedin.com" });
  const csrfCookie = cookies.find((cookie) => cookie.name === "JSESSIONID");
  const liAt = cookies.find((cookie) => cookie.name === "li_at");
  if (!csrfCookie || !liAt) return null;

  return {
    csrf: csrfCookie.value.replace(/"/g, ""),
    liAt: liAt.value,
  };
}

async function fetchVoyagerJson(url, csrf, options = {}) {
  const resp = await fetch(url, {
    ...options,
    headers: {
      "csrf-token": csrf,
      "x-restli-protocol-version": "2.0.0",
      ...(options.headers || {}),
    },
    credentials: "include",
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`${resp.status}: ${text.slice(0, 200)}`);
  }

  return resp.json();
}

async function fetchConnections(csrf, start = 0, count = CONNECTIONS_PER_PAGE) {
  const url = new URL("https://www.linkedin.com/voyager/api/relationships/dash/connections");
  url.searchParams.set("decorationId", "com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithProfile-16");
  url.searchParams.set("count", String(count));
  url.searchParams.set("q", "search");
  url.searchParams.set("start", String(start));
  return fetchVoyagerJson(url.toString(), csrf);
}

async function fetchViewerUrn(csrf) {
  const stored = await chrome.storage.local.get(VIEWER_URN_KEY);
  if (stored[VIEWER_URN_KEY]) return stored[VIEWER_URN_KEY];

  const data = await fetchVoyagerJson("https://www.linkedin.com/voyager/api/me", csrf);
  const urn = data.miniProfile?.entityUrn || "";
  if (!urn) {
    throw new Error("LinkedIn viewer URN not found");
  }

  await chrome.storage.local.set({ [VIEWER_URN_KEY]: urn });
  return urn;
}

function parseConnections(apiResponse) {
  const elements = apiResponse.elements || [];
  return elements
    .map((el) => {
      const mini = el.connectedMemberResolutionResult || {};
      return {
        linkedin_urn: mini.entityUrn || el.connectedMember || "",
        public_identifier: mini.publicIdentifier || "",
        first_name: mini.firstName || "",
        last_name: mini.lastName || "",
        headline: mini.headline || "",
        profile_picture: mini.profilePicture?.displayImageReference?.vectorImage?.rootUrl || "",
      };
    })
    .filter((conn) => conn.linkedin_urn);
}

async function fetchFullProfile(csrf, publicIdentifier) {
  if (!publicIdentifier) return null;
  return fetchVoyagerJson(
    `https://www.linkedin.com/voyager/api/identity/profiles/${publicIdentifier}/profileView`,
    csrf
  ).catch(() => null);
}

async function fetchProfilePageHtml(publicIdentifier) {
  if (!publicIdentifier) return "";
  const resp = await fetch(`https://www.linkedin.com/in/${publicIdentifier}/`, {
    credentials: "include",
  });
  if (!resp.ok) return "";
  return resp.text();
}

function extractProfileUrn(profileView) {
  if (!profileView) return "";
  return (
    profileView.profile?.entityUrn ||
    profileView.profile?.miniProfile?.entityUrn ||
    profileView.profile?.objectUrn ||
    profileView.miniProfile?.entityUrn ||
      ""
    );
}

function normalizeProfileUrn(profileUrn) {
  if (!profileUrn) return "";
  const parts = profileUrn.split(":");
  const memberId = parts[parts.length - 1];
  return memberId ? `urn:li:fsd_profile:${memberId}` : "";
}

function extractProfileUrnFromHtml(html = "") {
  if (!html) return "";
  const patterns = [
    /urn:li:(?:fsd_profile|fs_profile|fs_miniProfile|member):[A-Za-z0-9_-]+/,
    /"entityUrn":"(urn:li:[^"]+)"/,
    /"objectUrn":"(urn:li:[^"]+)"/,
    /"profileUrn":"(urn:li:[^"]+)"/,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    const raw = match ? (match[1] || match[0]) : "";
    const normalized = normalizeProfileUrn(raw);
    if (normalized) return normalized;
  }
  return "";
}

async function fetchRecentPosts(csrf, urn) {
  const url = new URL("https://www.linkedin.com/voyager/api/identity/profileUpdatesV2");
  url.searchParams.set("profileUrn", urn);
  url.searchParams.set("q", "memberShareFeed");
  url.searchParams.set("moduleKey", "member-shares:phone");
  url.searchParams.set("count", "10");
  url.searchParams.set("start", "0");

  const data = await fetchVoyagerJson(url.toString(), csrf).catch(() => null);
  return data ? extractPostTexts(data) : [];
}

function extractPostTexts(feedData) {
  const posts = [];
  for (const el of feedData.elements || []) {
    const commentary =
      el.commentary?.text?.text ||
      el.value?.["com.linkedin.voyager.feed.render.UpdateV2"]?.commentary?.text?.text ||
      "";
    if (commentary) posts.push(commentary.slice(0, 500));
    if (posts.length >= 5) break;
  }
  return posts;
}

function parseFullProfile(profileView) {
  if (!profileView) return {};

  const profile = profileView.profile || {};
  const positions = profileView.positionView?.elements || [];

  return {
    summary: (profile.summary || "").slice(0, 1000),
    location: profile.locationName || profile.geoLocationName || "",
    industry: profile.industryName || "",
    experience: positions.slice(0, 3).map((position) => ({
      title: position.title || "",
      companyName: position.companyName || "",
      description: (position.description || "").slice(0, 300),
    })),
  };
}

async function enrichConnection(csrf, conn) {
  const [profileView, posts] = await Promise.all([
    fetchFullProfile(csrf, conn.public_identifier),
    fetchRecentPosts(csrf, conn.linkedin_urn),
  ]);

  const parsed = parseFullProfile(profileView);
  return {
    ...conn,
    summary: parsed.summary || "",
    location: parsed.location || "",
    industry: parsed.industry || "",
    experience: parsed.experience || [],
    recent_posts: posts,
  };
}

async function sendLinkedInMessage(csrf, senderUrn, recipientUrn, messageBody) {
  const memberId = recipientUrn.includes(":") ? recipientUrn.split(":").pop() : recipientUrn;
  const url = "https://www.linkedin.com/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage";

  const payload = {
    dedupeByClientGeneratedToken: false,
    message: {
      body: { text: messageBody },
      renderContentUnionType: "NONE",
      originToken: crypto.randomUUID(),
    },
    mailboxUrn: senderUrn,
    trackingId: crypto.randomUUID(),
    hostRecipientUrns: [`urn:li:fsd_profile:${memberId}`],
  };

  await fetchVoyagerJson(url, csrf, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  return true;
}

async function resolveRecipientUrn(csrf, item) {
  if (item.linkedin_urn && item.linkedin_urn.startsWith("urn:li:fsd_profile:")) {
    return item.linkedin_urn;
  }

  let activeProfile = { publicIdentifier: "", profileUrn: "" };
  if (!item.public_identifier || item.linkedin_urn?.startsWith("pending:")) {
    activeProfile = await getActiveLinkedInProfileContext();
    if (activeProfile.profileUrn) {
      return activeProfile.profileUrn;
    }
  }

  let publicIdentifier = item.public_identifier || "";
  if (!publicIdentifier || item.linkedin_urn?.startsWith("pending:")) {
    publicIdentifier =
      activeProfile.publicIdentifier || (await getActiveLinkedInPublicIdentifier()) || publicIdentifier;
  }

  if (!publicIdentifier) {
    throw new Error("No public identifier available to resolve recipient");
  }

  const profileView = await fetchFullProfile(csrf, publicIdentifier);
  const resolvedUrn = extractProfileUrn(profileView);
  if (resolvedUrn) {
    return normalizeProfileUrn(resolvedUrn);
  }

  const profileHtml = await fetchProfilePageHtml(publicIdentifier);
  const htmlUrn = extractProfileUrnFromHtml(profileHtml);
  if (htmlUrn) {
    return htmlUrn;
  }

  throw new Error(`Could not resolve LinkedIn URN for ${publicIdentifier}`);
}

async function addLog(status, message) {
  const stored = await chrome.storage.local.get(LOG_KEY);
  const logs = stored[LOG_KEY] || [];
  logs.unshift({
    time: new Date().toISOString(),
    status,
    message,
  });
  await chrome.storage.local.set({ [LOG_KEY]: logs.slice(0, 50) });
}

function isLinkedInUrl(url = "") {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "www.linkedin.com" || parsed.hostname.endsWith(".linkedin.com");
  } catch {
    return false;
  }
}

function extractPublicIdentifierFromUrl(url = "") {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/in\/([^/?#]+)/i);
    return match ? decodeURIComponent(match[1]) : "";
  } catch {
    return "";
  }
}

async function getActiveLinkedInPublicIdentifier() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTab = tabs.find((tab) => isLinkedInUrl(tab.url));
  if (!activeTab?.url) return "";
  return extractPublicIdentifierFromUrl(activeTab.url);
}

async function getActiveLinkedInProfileContext() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTab = tabs.find((tab) => isLinkedInUrl(tab.url));
  if (!activeTab?.id || !activeTab.url) {
    return { publicIdentifier: "", profileUrn: "" };
  }

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: activeTab.id },
    func: () => {
      const canonicalHref =
        document.querySelector('link[rel="canonical"]')?.href || window.location.href || "";
        const html = document.documentElement?.innerHTML || "";
        const profileUrnMatch = html.match(/urn:li:(?:fsd_profile|fs_profile|fs_miniProfile|member):[A-Za-z0-9_-]+/);
        const pathnameMatch = canonicalHref.match(/\/in\/([^/?#]+)/i);
        return {
          publicIdentifier: pathnameMatch ? decodeURIComponent(pathnameMatch[1]) : "",
          profileUrn: profileUrnMatch ? profileUrnMatch[0] : "",
        };
      },
  });

  const context = result?.result || { publicIdentifier: "", profileUrn: "" };
  return {
    publicIdentifier: context.publicIdentifier || "",
    profileUrn: normalizeProfileUrn(context.profileUrn || ""),
  };
}

async function maybeRunCheckOnLinkedInOpen(url) {
  if (!isLinkedInUrl(url)) return;

  const stored = await chrome.storage.local.get(LINKEDIN_OPEN_CHECK_KEY);
  const today = new Date().toISOString().slice(0, 10);
  if (stored[LINKEDIN_OPEN_CHECK_KEY] === today) {
    return;
  }

  await chrome.storage.local.set({ [LINKEDIN_OPEN_CHECK_KEY]: today });
  console.log("[LinkedIn Detector] First LinkedIn open today - running connection check");
  checkForNewConnections();
}

async function checkPendingSends() {
  console.log("[LinkedIn Detector] Checking for pending sends...");

  const creds = await getLinkedInCookies();
  if (!creds) {
    console.log("[LinkedIn Detector] Not logged in - skipping send check");
    return { error: "Not logged in" };
  }

  let senderUrn;
  try {
    senderUrn = await fetchViewerUrn(creds.csrf);
  } catch (err) {
    await addLog("error", `Could not resolve sender URN: ${err.message}`);
    return { error: err.message };
  }

  let pendingSends;
  try {
    const resp = await fetch(`${BACKEND_URL}/pending-sends`);
    if (!resp.ok) throw new Error(String(resp.status));
    pendingSends = await resp.json();
  } catch (err) {
    console.error("[LinkedIn Detector] Failed to fetch pending sends:", err);
    return { error: err.message };
  }

  if (!pendingSends.length) return { pending: 0 };

  let sent = 0;
  let errors = 0;

  for (let index = 0; index < pendingSends.length; index += 1) {
    const item = pendingSends[index];
    const name = `${item.first_name} ${item.last_name}`.trim();

    try {
      const recipientUrn = await resolveRecipientUrn(creds.csrf, item);
      await sendLinkedInMessage(creds.csrf, senderUrn, recipientUrn, item.draft_message);

      const confirmResp = await fetch(`${BACKEND_URL}/confirm-send/${item.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!confirmResp.ok) {
        throw new Error(`Confirm send failed: ${confirmResp.status}`);
      }

      sent += 1;
      if (index < pendingSends.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    } catch (err) {
      console.error(`[LinkedIn Detector] Failed to send to ${name}:`, err);
      errors += 1;
      await addLog("error", `Send failed for ${name}: ${err.message}`);
    }
  }

  if (sent > 0) {
    await addLog("ok", `Sent ${sent} message(s)${errors ? `, ${errors} failed` : ""}`);
  }

  return { sent, errors };
}

async function checkForNewConnections() {
  const startTime = Date.now();
  console.log("[LinkedIn Detector] Starting connection check...");

  const creds = await getLinkedInCookies();
  if (!creds) {
    await addLog("error", "Not logged into LinkedIn");
    return { error: "Not logged into LinkedIn" };
  }

  let backendUrns;
  try {
    const resp = await fetch(`${BACKEND_URL}/known-urns`);
    if (!resp.ok) throw new Error(String(resp.status));
    backendUrns = new Set(await resp.json());
  } catch (err) {
    await addLog("error", `Backend unreachable: ${err.message}`);
    return { error: `Backend unreachable: ${err.message}` };
  }

  const stored = await chrome.storage.local.get([STORAGE_KEY, BASELINE_KEY]);
  const knownLocalUrns = new Set(stored[STORAGE_KEY] || []);
  const baselineInitialized = Boolean(stored[BASELINE_KEY]);

  const allConnections = [];
  const newConnections = [];
  const seenUrns = new Set();

  for (let page = 0; page < MAX_PAGES; page += 1) {
    try {
      const data = await fetchConnections(creds.csrf, page * CONNECTIONS_PER_PAGE);
      const parsed = parseConnections(data).filter((conn) => {
        if (seenUrns.has(conn.linkedin_urn)) return false;
        seenUrns.add(conn.linkedin_urn);
        return true;
      });

      allConnections.push(...parsed);

      const pageNewConnections = baselineInitialized
        ? parsed.filter(
            (conn) => !knownLocalUrns.has(conn.linkedin_urn) && !backendUrns.has(conn.linkedin_urn)
          )
        : [];
      newConnections.push(...pageNewConnections);

      if (parsed.length < CONNECTIONS_PER_PAGE) break;
      if (baselineInitialized && page > 0 && pageNewConnections.length === 0) break;
      if (newConnections.length >= MAX_NEW_CONNECTIONS_PER_CHECK) {
        newConnections.length = MAX_NEW_CONNECTIONS_PER_CHECK;
        break;
      }
    } catch (err) {
      console.error(`[LinkedIn Detector] Page ${page} fetch failed:`, err);
      if (page === 0) {
        await addLog("error", `API call failed: ${err.message}`);
        return { error: err.message };
      }
      break;
    }
  }

  await chrome.storage.local.set({
    [STORAGE_KEY]: allConnections.map((conn) => conn.linkedin_urn),
  });

  if (!baselineInitialized) {
    const seededAt = new Date().toISOString();
    await chrome.storage.local.set({
      [BASELINE_KEY]: true,
      [BASELINE_AT_KEY]: seededAt,
    });
    await addLog("ok", `Seeded baseline with ${allConnections.length} recent connections`);
    return {
      checked: allConnections.length,
      new: 0,
      seeded: true,
    };
  }

  if (!newConnections.length) {
    await addLog("ok", `Checked ${allConnections.length} connections, 0 new`);
    return { checked: allConnections.length, new: 0 };
  }

  console.log(`[LinkedIn Detector] Found ${newConnections.length} new connection(s)`);
  return enrichAndSend(creds.csrf, newConnections, allConnections, startTime);
}

async function enrichAndSend(csrf, newConnections, allConnections, startTime) {
  const enrichedConnections = [];

  for (const conn of newConnections) {
    try {
      const enriched = await enrichConnection(csrf, conn);
      enrichedConnections.push(enriched);
    } catch (err) {
      console.warn(`[LinkedIn Detector] Enrichment failed for ${conn.first_name}:`, err);
      enrichedConnections.push(conn);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  try {
    const resp = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connections: enrichedConnections }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Webhook ${resp.status}: ${text}`);
    }
  } catch (err) {
    await addLog("error", `Webhook failed: ${err.message} (${newConnections.length} not sent)`);
    return { error: err.message, new: newConnections.length };
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  await addLog("ok", `Found ${newConnections.length} new of ${allConnections.length} checked (${elapsed}s)`);
  return { checked: allConnections.length, new: newConnections.length };
}

chrome.alarms.create("check-connections", {
  delayInMinutes: 1,
  periodInMinutes: CHECK_INTERVAL_MINUTES,
});

// Run a check whenever Chrome starts up
chrome.runtime.onStartup.addListener(() => {
  console.log("[LinkedIn Detector] Chrome started — running connection check");
  checkForNewConnections();
});

chrome.alarms.create("check-pending-sends", {
  delayInMinutes: 0.5,
  periodInMinutes: 0.5,
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "check-connections") checkForNewConnections();
  if (alarm.name === "check-pending-sends") checkPendingSends();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  maybeRunCheckOnLinkedInOpen(tab.url);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "check-now") {
    checkForNewConnections().then(sendResponse);
    return true;
  }
  if (msg.action === "get-logs") {
    chrome.storage.local.get(LOG_KEY).then((stored) => sendResponse(stored[LOG_KEY] || []));
    return true;
  }
  if (msg.action === "get-stats") {
    chrome.storage.local.get(STORAGE_KEY).then((stored) => {
      sendResponse({ known: (stored[STORAGE_KEY] || []).length });
    });
    return true;
  }
  if (msg.action === "send-now") {
    checkPendingSends().then(sendResponse);
    return true;
  }
  if (msg.action === "reset") {
    chrome.storage.local
      .remove([
        STORAGE_KEY,
        LOG_KEY,
        VIEWER_URN_KEY,
        BASELINE_KEY,
        BASELINE_AT_KEY,
        LINKEDIN_OPEN_CHECK_KEY,
      ])
      .then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }
  return false;
});
