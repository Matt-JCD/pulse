const checkBtn = document.getElementById("check-btn");
const sendBtn = document.getElementById("send-btn");
const resetBtn = document.getElementById("reset-btn");
const knownCount = document.getElementById("known-count");
const pendingCount = document.getElementById("pending-count");
const nextCheck = document.getElementById("next-check");
const resultDiv = document.getElementById("result");
const logsDiv = document.getElementById("logs");

loadStats();
loadLogs();
loadNextAlarm();
loadPendingSends();

checkBtn.addEventListener("click", async () => {
  checkBtn.disabled = true;
  checkBtn.textContent = "Checking...";
  resultDiv.style.display = "none";

  const result = await chrome.runtime.sendMessage({ action: "check-now" });

  checkBtn.disabled = false;
  checkBtn.textContent = "Check Now";
  resultDiv.style.display = "block";

  if (result.error) {
    resultDiv.style.background = "#2a1515";
    resultDiv.style.color = "#e54d4d";
    resultDiv.textContent = `Error: ${result.error}`;
  } else if (result.new > 0) {
    resultDiv.style.background = "#0d2a24";
    resultDiv.style.color = "#08CAA6";
    resultDiv.textContent = `Found ${result.new} new connection(s). Sent to pipeline.`;
  } else {
    resultDiv.style.background = "#1a1a1a";
    resultDiv.style.color = "#888";
    resultDiv.textContent = `Checked ${result.checked} connections - no new ones.`;
  }

  loadStats();
  loadLogs();
});

sendBtn.addEventListener("click", async () => {
  sendBtn.disabled = true;
  sendBtn.textContent = "Sending...";
  resultDiv.style.display = "none";

  const result = await chrome.runtime.sendMessage({ action: "send-now" });

  sendBtn.disabled = false;
  sendBtn.textContent = "Send Now";
  resultDiv.style.display = "block";

  if (result.error) {
    resultDiv.style.background = "#2a1515";
    resultDiv.style.color = "#e54d4d";
    resultDiv.textContent = `Error: ${result.error}`;
  } else if (result.sent > 0) {
    resultDiv.style.background = "#0d2a24";
    resultDiv.style.color = "#08CAA6";
    resultDiv.textContent = `Sent ${result.sent} message(s)!${result.errors ? ` (${result.errors} failed)` : ""}`;
  } else {
    resultDiv.style.background = "#1a1a1a";
    resultDiv.style.color = "#888";
    resultDiv.textContent = "No pending messages to send.";
  }

  loadLogs();
  loadPendingSends();
});

resetBtn.addEventListener("click", async () => {
  const confirmed = confirm(
    "Reset the local extension cache? The next check will re-fetch recent LinkedIn connections."
  );
  if (!confirmed) return;

  await chrome.runtime.sendMessage({ action: "reset" });
  loadStats();
  loadLogs();
  resultDiv.style.display = "block";
  resultDiv.style.background = "#1a1a1a";
  resultDiv.style.color = "#888";
  resultDiv.textContent = "Local cache cleared.";
});

async function loadStats() {
  const stats = await chrome.runtime.sendMessage({ action: "get-stats" });
  knownCount.textContent = stats.known.toLocaleString();
}

async function loadLogs() {
  const logs = await chrome.runtime.sendMessage({ action: "get-logs" });
  if (logs.length === 0) {
    logsDiv.innerHTML = '<div class="empty">No checks yet</div>';
    return;
  }

  logsDiv.innerHTML = logs
    .slice(0, 10)
    .map((log) => {
      const time = new Date(log.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const date = new Date(log.time).toLocaleDateString([], { month: "short", day: "numeric" });
      const cls = log.status === "ok" ? "log-ok" : "log-error";
      const icon = log.status === "ok" ? "\u2713" : "\u2717";
      return `<div class="log-entry">
        <span class="log-time">${date} ${time}</span>
        <span class="${cls}">${icon}</span>
        <span class="log-msg">${log.message}</span>
      </div>`;
    })
    .join("");
}

async function loadPendingSends() {
  try {
    const resp = await fetch("https://pulse-by-prefactor-1.onrender.com/pending-sends");
    if (!resp.ok) throw new Error(String(resp.status));
    const data = await resp.json();
    pendingCount.textContent = data.length;
  } catch {
    pendingCount.textContent = "?";
  }
}

async function loadNextAlarm() {
  const alarm = await chrome.alarms.get("check-connections");
  if (!alarm) return;

  const next = new Date(alarm.scheduledTime);
  const diff = Math.max(0, Math.round((next - Date.now()) / 60000));
  nextCheck.textContent = `${diff} min`;
}
