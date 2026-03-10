(() => {
  const POST_SELECTORS = [
    "shreddit-post",
    'article[data-testid="post-container"]',
    'div[data-testid="post-container"]'
  ];
  const BODY_SELECTORS = [
    '[slot="text-body"]',
    '[data-click-id="text"]',
    '[data-post-click-location="text-body"]',
    '[data-testid="post-container"] [data-click-id="text"]'
  ];
  const TITLE_SELECTORS = [
    "h3",
    '[slot="title"]',
    'a[data-testid="post-title"]',
    'a[id^="post-title-"]'
  ];

  const sentSignatures = new Map();
  let scanTimer = null;
  let lastKnownUrl = location.href;

  const observer = new MutationObserver(() => {
    scheduleScan(500);
  });

  function start() {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    scheduleScan(250);
    setTimeout(() => scheduleScan(1_500), 1_500);
    setTimeout(() => scheduleScan(4_000), 4_000);

    setInterval(() => {
      if (location.href !== lastKnownUrl) {
        lastKnownUrl = location.href;
        sentSignatures.clear();
        scheduleScan(400);
      }
    }, 1_000);
  }

  function scheduleScan(delayMs) {
    window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(() => {
      void scanPage();
    }, delayMs);
  }

  async function scanPage() {
    const posts = collectPosts();
    if (!posts.length) {
      return;
    }

    const changedPosts = [];
    for (const post of posts) {
      const identity = post.postId || post.permalink;
      if (!identity) {
        continue;
      }

      const signature = JSON.stringify([
        post.subreddit,
        post.title,
        post.score,
        post.commentCount,
        post.createdAt,
        post.permalink,
        post.bodyText
      ]);

      if (sentSignatures.get(identity) === signature) {
        continue;
      }

      sentSignatures.set(identity, signature);
      changedPosts.push(post);
    }

    trimSentSignatures();

    if (!changedPosts.length) {
      return;
    }

    chrome.runtime.sendMessage(
      {
        type: "capturePosts",
        posts: changedPosts,
        pageUrl: location.href
      },
      () => {
        void chrome.runtime.lastError;
      }
    );
  }

  function trimSentSignatures() {
    const maxEntries = 1_500;
    if (sentSignatures.size <= maxEntries) {
      return;
    }

    const keys = [...sentSignatures.keys()];
    for (const key of keys.slice(0, sentSignatures.size - maxEntries)) {
      sentSignatures.delete(key);
    }
  }

  function collectPosts() {
    const candidates = new Set();
    for (const selector of POST_SELECTORS) {
      for (const element of document.querySelectorAll(selector)) {
        candidates.add(element);
      }
    }

    const posts = [];
    const seenIds = new Set();

    for (const element of candidates) {
      const post = extractPost(element);
      const identity = post?.postId || post?.permalink;
      if (!post || !identity || seenIds.has(identity)) {
        continue;
      }

      seenIds.add(identity);
      posts.push(post);
    }

    return posts;
  }

  function extractPost(element) {
    if (element.matches("shreddit-post")) {
      return extractFromShredditPost(element);
    }

    return extractFromGenericCard(element);
  }

  function extractFromShredditPost(element) {
    const permalink = absoluteUrl(
      element.getAttribute("permalink") ||
        queryAttr(element, ['a[href*="/comments/"]'], "href")
    );
    const postUrl = absoluteUrl(
      element.getAttribute("content-href") ||
        queryAttr(element, TITLE_SELECTORS.map((selector) => `${selector}[href]`), "href") ||
        permalink
    );
    const title =
      normalizeText(
        element.getAttribute("post-title") ||
          element.getAttribute("title") ||
          queryText(element, TITLE_SELECTORS)
      ) || null;
    const subreddit =
      normalizeSubreddit(
        element.getAttribute("subreddit-prefixed-name") ||
          element.getAttribute("subreddit-name") ||
          pageSubreddit()
      ) || null;
    const author =
      normalizeText(
        element.getAttribute("author") ||
          queryText(element, ['a[href*="/user/"]', 'a[href*="/u/"]'])
      ) || null;
    const createdAt =
      normalizeDate(
        element.getAttribute("created-timestamp") ||
          queryAttr(element, ["time[datetime]"], "datetime") ||
          queryAttr(element, ["faceplate-timeago[ts]"], "ts")
      ) || null;
    const score =
      parseCount(
        element.getAttribute("score") ||
          queryAttr(element, ["faceplate-number[number]"], "number") ||
          queryText(element, ['button[aria-label*="upvote"]'])
      ) ?? null;
    const commentCount =
      parseCount(
        element.getAttribute("comment-count") ||
          queryText(element, ['a[href*="/comments/"]', 'button[aria-label*="comment"]'])
      ) ?? null;
    const flair =
      normalizeText(
        queryText(element, ['[slot="post-flair"]', '[data-testid="post-flair"]'])
      ) || null;
    const bodyText = extractBodyText(element);
    const postId =
      normalizePostId(
        element.getAttribute("post-id") ||
          element.getAttribute("thingid") ||
          element.id,
        permalink
      ) || null;

    if (!permalink || !postId || !subreddit) {
      return null;
    }

    return {
      postId,
      subreddit,
      title,
      author,
      permalink,
      postUrl,
      createdAt,
      score,
      commentCount,
      flair,
      bodyText,
      pageUrl: location.href
    };
  }

  function extractFromGenericCard(element) {
    const permalink = absoluteUrl(
      queryAttr(element, ['a[href*="/comments/"]'], "href")
    );
    const title =
      normalizeText(
        queryText(element, TITLE_SELECTORS) ||
          queryText(element, ['a[href*="/comments/"]'])
      ) || null;
    const subreddit =
      normalizeSubreddit(
        queryText(element, [
          'a[href^="/r/"]:not([href*="/comments/"])',
          'a[href*="reddit.com/r/"]:not([href*="/comments/"])'
        ]) ||
          pageSubreddit()
      ) || null;
    const author =
      normalizeText(
        queryText(element, ['a[href*="/user/"]', 'a[href*="/u/"]'])
      ) || null;
    const createdAt =
      normalizeDate(
        queryAttr(element, ["time[datetime]"], "datetime") ||
          queryAttr(element, ["faceplate-timeago[ts]"], "ts")
      ) || null;
    const score =
      parseCount(
        queryAttr(element, ["faceplate-number[number]"], "number") ||
          queryText(element, [
            '[id*="vote-arrows"]',
            'button[aria-label*="upvote"]',
            'button[aria-label*="vote"]'
          ])
      ) ?? null;
    const commentCount =
      parseCount(
        queryText(element, ['a[href*="/comments/"]', 'button[aria-label*="comment"]'])
      ) ?? null;
    const flair =
      normalizeText(
        queryText(element, ['[data-testid="post-flair"]', 'span[id^="post-flair"]'])
      ) || null;
    const bodyText = extractBodyText(element);
    const postId = normalizePostId(null, permalink);
    const postUrl = absoluteUrl(
      queryAttr(element, ['a[href*="/comments/"]'], "href") || permalink
    );

    if (!permalink || !postId || !subreddit) {
      return null;
    }

    return {
      postId,
      subreddit,
      title,
      author,
      permalink,
      postUrl,
      createdAt,
      score,
      commentCount,
      flair,
      bodyText,
      pageUrl: location.href
    };
  }

  function extractBodyText(element) {
    for (const selector of BODY_SELECTORS) {
      const match = element.querySelector(selector);
      const text = normalizeText(match?.innerText || match?.textContent || "");
      if (text) {
        return text;
      }
    }

    return null;
  }

  function queryText(root, selectors) {
    for (const selector of selectors) {
      const match = root.querySelector(selector);
      const text = normalizeText(match?.innerText || match?.textContent || "");
      if (text) {
        return text;
      }
    }

    return null;
  }

  function queryAttr(root, selectors, attributeName) {
    for (const selector of selectors) {
      const match = root.querySelector(selector);
      const value = match?.getAttribute(attributeName);
      if (value) {
        return value;
      }
    }

    return null;
  }

  function normalizeText(value) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text || null;
  }

  function normalizeSubreddit(value) {
    const text = normalizeText(value);
    if (!text) {
      return null;
    }

    return text
      .replace(/^https?:\/\/(?:www\.|old\.|new\.)?reddit\.com\/r\//i, "")
      .replace(/^\/?r\//i, "")
      .replace(/\/.*$/, "")
      .trim();
  }

  function normalizePostId(value, permalink) {
    const raw = normalizeText(value)?.replace(/^t3_/i, "");
    if (raw) {
      return raw.toLowerCase();
    }

    const match = permalink?.match(/\/comments\/([a-z0-9]+)\//i);
    return match ? match[1].toLowerCase() : null;
  }

  function absoluteUrl(value) {
    if (!value) {
      return null;
    }

    try {
      return new URL(value, location.origin).href;
    } catch {
      return null;
    }
  }

  function normalizeDate(value) {
    if (!value) {
      return null;
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return null;
    }

    return date.toISOString();
  }

  function parseCount(value) {
    if (value === null || value === undefined) {
      return null;
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.trunc(value);
    }

    const text = String(value).trim().toLowerCase().replace(/,/g, "");
    if (!text || text === "vote" || text === "votes") {
      return null;
    }

    const match = text.match(/(-?\d+(?:\.\d+)?)\s*([kmb])?/i);
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

  function pageSubreddit() {
    const match = location.pathname.match(/^\/r\/([^/]+)/i);
    return match ? normalizeSubreddit(match[1]) : null;
  }

  start();
})();
