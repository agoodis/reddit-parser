const totalPostsElement = document.getElementById("total-posts");
const totalSnapshotsElement = document.getElementById("total-snapshots");
const settingsCountElement = document.getElementById("settings-count");
const lastSeenAtElement = document.getElementById("last-seen-at");
const subredditBreakdownElement = document.getElementById("subreddit-breakdown");
const exportButton = document.getElementById("export-button");
const exportCsvButton = document.getElementById("export-csv-button");
const optionsButton = document.getElementById("options-button");
const clearButton = document.getElementById("clear-button");
const statusElement = document.getElementById("status");

document.addEventListener("DOMContentLoaded", () => {
  void refreshStats();
});

exportButton.addEventListener("click", async () => {
  await withBusyState(exportButton, async () => {
    setStatus("Preparing SQLite export...");
    const response = await sendMessage({ type: "exportDatabase" });
    setStatus(`Saved ${response.filename}`);
  });
});

exportCsvButton.addEventListener("click", async () => {
  await withBusyState(exportCsvButton, async () => {
    setStatus("Preparing posts CSV export...");
    const response = await sendMessage({ type: "exportPostsCsv" });
    setStatus(`Saved ${response.filename}`);
  });
});

optionsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

clearButton.addEventListener("click", async () => {
  const confirmed = window.confirm("Delete the local SQLite database and all captured posts?");
  if (!confirmed) {
    return;
  }

  await withBusyState(clearButton, async () => {
    setStatus("Clearing local database...");
    await sendMessage({ type: "clearDatabase" });
    await refreshStats();
    setStatus("Local database cleared.");
  });
});

async function refreshStats() {
  const response = await sendMessage({ type: "getStats" });

  totalPostsElement.textContent = formatNumber(response.totalPosts);
  totalSnapshotsElement.textContent = formatNumber(response.totalSnapshots);
  settingsCountElement.textContent = formatNumber(response.settings.length);
  lastSeenAtElement.textContent = response.lastSeenAt
    ? formatDate(response.lastSeenAt)
    : "No data yet";

  if (!response.subredditBreakdown.length) {
    subredditBreakdownElement.innerHTML = '<li class="empty-state">No captured posts yet.</li>';
    return;
  }

  subredditBreakdownElement.innerHTML = response.subredditBreakdown
    .map(
      (entry) => `
        <li class="subreddit-row">
          <span class="subreddit-name">r/${escapeHtml(entry.subreddit)}</span>
          <span class="subreddit-count">${formatNumber(entry.postCount)}</span>
        </li>
      `
    )
    .join("");
}

async function withBusyState(button, action) {
  const previousText = button.textContent;
  button.disabled = true;

  try {
    await action();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  } finally {
    button.disabled = false;
    button.textContent = previousText;
  }
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (!response?.ok) {
        reject(new Error(response?.error || "Request failed"));
        return;
      }

      resolve(response);
    });
  });
}

function setStatus(text) {
  statusElement.textContent = text;
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(Number(value || 0));
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
