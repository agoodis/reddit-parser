importScripts("../shared/default-subreddits.js", "../vendor/sql-wasm.js");

const DB_STORE_NAME = "kv";
const DB_STORAGE_NAME = "reddit-parser-storage";
const DB_STORAGE_KEY = "sqlite-db";
const SETTINGS_KEY = "subredditAllowlist";
const SNAPSHOT_INTERVAL_MS = 6 * 60 * 60 * 1000;

let sqlEnginePromise = null;
let dbPromise = null;

chrome.runtime.onInstalled.addListener(() => {
  void initializeExtension();
});

chrome.runtime.onStartup.addListener(() => {
  void initializeExtension();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void (async () => {
    switch (message?.type) {
      case "capturePosts":
        sendResponse({
          ok: true,
          ...(await capturePosts(message.posts, message.pageUrl))
        });
        break;
      case "getStats":
        sendResponse({
          ok: true,
          ...(await getStats())
        });
        break;
      case "getSettings":
        sendResponse({
          ok: true,
          settings: await loadAllowlist()
        });
        break;
      case "saveSettings":
        sendResponse({
          ok: true,
          settings: await saveAllowlist(message.settings)
        });
        break;
      case "exportDatabase":
        sendResponse({
          ok: true,
          filename: await exportDatabase()
        });
        break;
      case "clearDatabase":
        await clearDatabase();
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({ ok: false, error: "Unknown message type" });
    }
  })().catch((error) => {
    console.error("[reddit-parser] background error", error);
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  });

  return true;
});

async function initializeExtension() {
  await ensureAllowlistInitialized();
  await getDatabase();
}

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(result);
    });
  });
}

function storageSet(values) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(values, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve();
    });
  });
}

function downloadFile(options) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(options, (downloadId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(downloadId);
    });
  });
}

function openIndexedDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_STORAGE_NAME, 1);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DB_STORE_NAME)) {
        database.createObjectStore(DB_STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB"));
  });
}

async function readStoredDbBuffer() {
  const database = await openIndexedDb();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(DB_STORE_NAME, "readonly");
    const store = transaction.objectStore(DB_STORE_NAME);
    const request = store.get(DB_STORAGE_KEY);

    request.onsuccess = () => {
      const value = request.result;
      if (!value) {
        resolve(null);
        return;
      }

      resolve(new Uint8Array(value));
    };

    request.onerror = () => reject(request.error ?? new Error("Failed to read SQLite blob"));
    transaction.oncomplete = () => database.close();
  });
}

async function writeStoredDbBuffer(bytes) {
  const database = await openIndexedDb();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(DB_STORE_NAME, "readwrite");
    const store = transaction.objectStore(DB_STORE_NAME);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const request = store.put(buffer, DB_STORAGE_KEY);

    request.onerror = () => reject(request.error ?? new Error("Failed to persist SQLite blob"));
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => reject(transaction.error ?? new Error("Failed to persist SQLite blob"));
  });
}

async function getSqlEngine() {
  if (!sqlEnginePromise) {
    sqlEnginePromise = initSqlJs({
      // The manifest lives at repository root, while the sql.js assets stay in extension/vendor.
      locateFile: (fileName) => chrome.runtime.getURL(`extension/vendor/${fileName}`)
    });
  }

  return sqlEnginePromise;
}

async function getDatabase() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const SQL = await getSqlEngine();
      const storedBytes = await readStoredDbBuffer();
      const database = storedBytes ? new SQL.Database(storedBytes) : new SQL.Database();
      runMigrations(database);
      return database;
    })();
  }

  return dbPromise;
}

async function replaceDatabase(factory) {
  const SQL = await getSqlEngine();
  const database = factory(SQL);
  runMigrations(database);
  dbPromise = Promise.resolve(database);
  await persistDatabase(database);
}

function runMigrations(database) {
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id TEXT NOT NULL UNIQUE,
      subreddit TEXT NOT NULL,
      title TEXT,
      author TEXT,
      permalink TEXT NOT NULL,
      post_url TEXT,
      created_at TEXT,
      score INTEGER,
      comment_count INTEGER,
      body_text TEXT,
      flair TEXT,
      page_url TEXT,
      raw_payload TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_posts_subreddit_created_at
      ON posts(subreddit, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_posts_last_seen_at
      ON posts(last_seen_at DESC);

    CREATE TABLE IF NOT EXISTS capture_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id TEXT NOT NULL,
      seen_at TEXT NOT NULL,
      score INTEGER,
      comment_count INTEGER,
      page_url TEXT,
      UNIQUE(post_id, seen_at),
      FOREIGN KEY(post_id) REFERENCES posts(post_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_capture_snapshots_post_id_seen_at
      ON capture_snapshots(post_id, seen_at DESC);
  `);
}

async function persistDatabase(database) {
  const bytes = database.export();
  await writeStoredDbBuffer(bytes);
}

async function ensureAllowlistInitialized() {
  const stored = await storageGet(SETTINGS_KEY);
  if (!Array.isArray(stored[SETTINGS_KEY]) || stored[SETTINGS_KEY].length === 0) {
    await storageSet({ [SETTINGS_KEY]: [...DEFAULT_SUBREDDITS] });
  }
}

async function loadAllowlist() {
  await ensureAllowlistInitialized();
  const stored = await storageGet(SETTINGS_KEY);
  return sanitizeAllowlist(stored[SETTINGS_KEY]);
}

async function saveAllowlist(settings) {
  const sanitized = sanitizeAllowlist(settings);
  await storageSet({ [SETTINGS_KEY]: sanitized });
  return sanitized;
}

function sanitizeAllowlist(value) {
  const source = Array.isArray(value) ? value : DEFAULT_SUBREDDITS;
  const unique = new Map();

  for (const entry of source) {
    const normalized = normalizeSubreddit(entry);
    if (!normalized) {
      continue;
    }

    const key = normalized.toLowerCase();
    if (!unique.has(key)) {
      unique.set(key, normalized);
    }
  }

  return [...unique.values()];
}

function normalizeSubreddit(value) {
  if (!value) {
    return "";
  }

  return String(value)
    .trim()
    .replace(/^https?:\/\/(?:www\.|old\.|new\.)?reddit\.com\/r\//i, "")
    .replace(/^\/?r\//i, "")
    .replace(/\/.*$/, "")
    .trim();
}

function normalizePermalink(value) {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value, "https://www.reddit.com");
    url.hash = "";
    url.search = "";
    return url.href;
  } catch {
    return null;
  }
}

function normalizeMaybeUrl(value) {
  if (!value) {
    return null;
  }

  try {
    return new URL(value, "https://www.reddit.com").href;
  } catch {
    return null;
  }
}

function extractPostIdFromPermalink(permalink) {
  const match = permalink?.match(/\/comments\/([a-z0-9]+)\//i);
  return match ? match[1].toLowerCase() : null;
}

function normalizePostId(rawValue, permalink) {
  const raw = String(rawValue ?? "").trim().replace(/^t3_/i, "");
  if (raw) {
    return raw.toLowerCase();
  }

  return extractPostIdFromPermalink(permalink);
}

function parseInteger(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  const text = String(value).trim().toLowerCase().replace(/,/g, "");
  if (!text) {
    return null;
  }

  const match = text.match(/(-?\d+(?:\.\d+)?)([kmb])?/i);
  if (!match) {
    return null;
  }

  const base = Number.parseFloat(match[1]);
  if (!Number.isFinite(base)) {
    return null;
  }

  const multiplier = {
    k: 1_000,
    m: 1_000_000,
    b: 1_000_000_000
  }[match[2]?.toLowerCase() ?? ""] ?? 1;

  return Math.round(base * multiplier);
}

function normalizeIsoDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function normalizeText(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).replace(/\s+/g, " ").trim();
  return normalized || null;
}

function buildPostRecord(rawPost, fallbackPageUrl, nowIso) {
  const permalink = normalizePermalink(rawPost?.permalink);
  const postId = normalizePostId(rawPost?.postId, permalink);
  const subreddit = normalizeSubreddit(rawPost?.subreddit);
  if (!postId || !permalink || !subreddit) {
    return null;
  }

  return {
    postId,
    subreddit,
    title: normalizeText(rawPost?.title),
    author: normalizeText(rawPost?.author),
    permalink,
    postUrl: normalizeMaybeUrl(rawPost?.postUrl) ?? permalink,
    createdAt: normalizeIsoDate(rawPost?.createdAt),
    score: parseInteger(rawPost?.score),
    commentCount: parseInteger(rawPost?.commentCount),
    bodyText: normalizeText(rawPost?.bodyText),
    flair: normalizeText(rawPost?.flair),
    pageUrl: normalizeMaybeUrl(rawPost?.pageUrl) ?? normalizeMaybeUrl(fallbackPageUrl),
    rawPayload: JSON.stringify(rawPost ?? {}),
    seenAt: nowIso
  };
}

function shouldWriteSnapshot(lastSnapshot, post, nowIso) {
  if (!lastSnapshot) {
    return true;
  }

  if (lastSnapshot.score !== post.score || lastSnapshot.commentCount !== post.commentCount) {
    return true;
  }

  const lastSeen = Date.parse(lastSnapshot.seenAt ?? "");
  const now = Date.parse(nowIso);
  if (Number.isNaN(lastSeen) || Number.isNaN(now)) {
    return true;
  }

  return now - lastSeen >= SNAPSHOT_INTERVAL_MS;
}

async function capturePosts(rawPosts, pageUrl) {
  if (!Array.isArray(rawPosts) || rawPosts.length === 0) {
    return { captured: 0, skipped: 0, snapshots: 0 };
  }

  const allowlist = new Set((await loadAllowlist()).map((entry) => entry.toLowerCase()));
  const database = await getDatabase();
  const nowIso = new Date().toISOString();
  const postStatement = database.prepare(`
    INSERT INTO posts (
      post_id,
      subreddit,
      title,
      author,
      permalink,
      post_url,
      created_at,
      score,
      comment_count,
      body_text,
      flair,
      page_url,
      raw_payload,
      first_seen_at,
      last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(post_id) DO UPDATE SET
      subreddit = excluded.subreddit,
      title = COALESCE(excluded.title, posts.title),
      author = COALESCE(excluded.author, posts.author),
      permalink = excluded.permalink,
      post_url = COALESCE(excluded.post_url, posts.post_url),
      created_at = COALESCE(excluded.created_at, posts.created_at),
      score = COALESCE(excluded.score, posts.score),
      comment_count = COALESCE(excluded.comment_count, posts.comment_count),
      body_text = COALESCE(excluded.body_text, posts.body_text),
      flair = COALESCE(excluded.flair, posts.flair),
      page_url = COALESCE(excluded.page_url, posts.page_url),
      raw_payload = excluded.raw_payload,
      last_seen_at = excluded.last_seen_at
  `);
  const lastSnapshotStatement = database.prepare(`
    SELECT score, comment_count, seen_at
    FROM capture_snapshots
    WHERE post_id = ?
    ORDER BY seen_at DESC
    LIMIT 1
  `);
  const snapshotStatement = database.prepare(`
    INSERT INTO capture_snapshots (post_id, seen_at, score, comment_count, page_url)
    VALUES (?, ?, ?, ?, ?)
  `);

  let captured = 0;
  let skipped = 0;
  let snapshots = 0;

  database.exec("BEGIN TRANSACTION;");

  try {
    for (const rawPost of rawPosts) {
      const record = buildPostRecord(rawPost, pageUrl, nowIso);
      if (!record || !allowlist.has(record.subreddit.toLowerCase())) {
        skipped += 1;
        continue;
      }

      postStatement.run([
        record.postId,
        record.subreddit,
        record.title,
        record.author,
        record.permalink,
        record.postUrl,
        record.createdAt,
        record.score,
        record.commentCount,
        record.bodyText,
        record.flair,
        record.pageUrl,
        record.rawPayload,
        record.seenAt,
        record.seenAt
      ]);

      let latestSnapshot = null;
      lastSnapshotStatement.bind([record.postId]);
      if (lastSnapshotStatement.step()) {
        const row = lastSnapshotStatement.getAsObject();
        latestSnapshot = {
          score: parseInteger(row.score),
          commentCount: parseInteger(row.comment_count),
          seenAt: row.seen_at ? String(row.seen_at) : null
        };
      }
      lastSnapshotStatement.reset();

      if (shouldWriteSnapshot(latestSnapshot, record, nowIso)) {
        snapshotStatement.run([
          record.postId,
          record.seenAt,
          record.score,
          record.commentCount,
          record.pageUrl
        ]);
        snapshots += 1;
      }

      captured += 1;
    }

    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  } finally {
    postStatement.free();
    lastSnapshotStatement.free();
    snapshotStatement.free();
  }

  if (captured > 0) {
    await persistDatabase(database);
  }

  return { captured, skipped, snapshots };
}

function readScalar(database, sql) {
  const result = database.exec(sql);
  if (!result.length || !result[0].values.length) {
    return 0;
  }

  return result[0].values[0][0];
}

function readRows(database, sql) {
  const statement = database.prepare(sql);
  const rows = [];

  while (statement.step()) {
    rows.push(statement.getAsObject());
  }

  statement.free();
  return rows;
}

async function getStats() {
  const database = await getDatabase();
  const settings = await loadAllowlist();
  const subredditRows = readRows(database, `
    SELECT
      subreddit,
      COUNT(*) AS post_count,
      MAX(last_seen_at) AS last_seen_at
    FROM posts
    GROUP BY subreddit
    ORDER BY post_count DESC, subreddit ASC
    LIMIT 12
  `).map((row) => ({
    subreddit: String(row.subreddit),
    postCount: parseInteger(row.post_count) ?? 0,
    lastSeenAt: row.last_seen_at ? String(row.last_seen_at) : null
  }));

  return {
    totalPosts: parseInteger(readScalar(database, "SELECT COUNT(*) FROM posts;")) ?? 0,
    totalSnapshots: parseInteger(readScalar(database, "SELECT COUNT(*) FROM capture_snapshots;")) ?? 0,
    lastSeenAt: readScalar(database, "SELECT COALESCE(MAX(last_seen_at), '') FROM posts;") || null,
    settings,
    subredditBreakdown: subredditRows
  };
}

async function exportDatabase() {
  const database = await getDatabase();
  await persistDatabase(database);

  const blob = new Blob([database.export()], { type: "application/vnd.sqlite3" });
  const url = URL.createObjectURL(blob);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `reddit-parser-${timestamp}.sqlite`;

  try {
    await downloadFile({
      url,
      filename,
      saveAs: true,
      conflictAction: "uniquify"
    });
  } finally {
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 60_000);
  }

  return filename;
}

async function clearDatabase() {
  await replaceDatabase((SQL) => new SQL.Database());
}
