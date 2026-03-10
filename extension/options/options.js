const textarea = document.getElementById("subreddits");
const saveButton = document.getElementById("save-button");
const resetButton = document.getElementById("reset-button");
const statusElement = document.getElementById("status");

document.addEventListener("DOMContentLoaded", () => {
  void loadSettings();
});

saveButton.addEventListener("click", async () => {
  await withBusyState(saveButton, async () => {
    const settings = textarea.value
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean);

    const response = await sendMessage({
      type: "saveSettings",
      settings
    });

    textarea.value = response.settings.join("\n");
    setStatus(`Saved ${response.settings.length} subreddit entries.`);
  });
});

resetButton.addEventListener("click", () => {
  textarea.value = DEFAULT_SUBREDDITS.join("\n");
  setStatus("Defaults restored in the editor. Save to apply them.");
});

async function loadSettings() {
  const response = await sendMessage({ type: "getSettings" });
  textarea.value = response.settings.join("\n");
}

async function withBusyState(button, action) {
  button.disabled = true;

  try {
    await action();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  } finally {
    button.disabled = false;
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
