# reddit-parser

Chrome extension for collecting Reddit post metadata from selected subreddits into a local SQLite database.

## What it does

- Watches Reddit listing pages while you browse.
- Captures visible posts from monitored subreddits.
- Stores data in a real SQLite database powered by `sql.js`.
- Keeps both the latest `posts` table and a `capture_snapshots` history table for score/comment changes over time.
- Exports the database as a `.sqlite` file and the current `posts` table as `.csv` for downstream analysis in Python, DuckDB, SQLite CLI, Datasette, or DB Browser for SQLite.

Captured fields include:

- subreddit
- post id
- title
- author
- votes / score
- comment count
- created date
- permalink
- post URL
- preview text / body text when available
- flair when available
- first seen / last seen timestamps

## Default monitored subreddits

```text
BORUpdates
BestofRedditorUpdates
AmItheAsshole
AmItheButtface
relationship_advice
relationships
Marriage
TrueOffMyChest
MaliciousCompliance
ProRevenge
coworkerstories
talesfromtechsupport
legaladvice
Ratschlag
UnresolvedMysteries
WithoutATrace
UnsolvedCrime
```

## Project layout

```text
extension/
  background/   MV3 service worker and SQLite persistence
  content/      Reddit DOM scraper
  options/      Subreddit allowlist editor
  popup/        Quick stats + SQLite export UI
  shared/       Default subreddit list
  vendor/       sql.js runtime copied from node_modules
scripts/
  sync-sqljs.mjs
  validate-extension.mjs
```

## Setup

1. Install dependencies:

   ```sh
   npm install
   ```

2. Load the unpacked extension:

   - Open `chrome://extensions`
   - Enable Developer mode
   - Click Load unpacked
   - Select the repository root folder, the one that contains `manifest.json`

3. Optional: open the options page and edit the subreddit list.

## Usage

1. Browse Reddit pages such as `https://www.reddit.com/r/BestofRedditorUpdates/`.
2. As posts appear in the page, the content script extracts their visible metadata.
3. Open the extension popup to see capture stats.
4. Click `Export .sqlite` to download the full database, or `Export posts CSV` to download the latest `posts` table as CSV.

## Database schema

### `posts`

Latest known state for each captured post.

### `capture_snapshots`

Periodic snapshots of score and comment counts. A new snapshot is saved when values change or when the post is seen again after a 6 hour gap.

## Export formats

- `.sqlite` contains both `posts` and `capture_snapshots`.
- `.csv` contains the latest `posts` rows only.

## Notes and limits

- The extension captures only posts currently rendered in the page DOM. It does not backfill an entire subreddit history automatically.
- Reddit changes its front-end markup regularly. The scraper targets the current `shreddit-post` / listing-card structure and includes fallbacks, but selectors may need updates later.
- Data stays local in the browser until you export the SQLite file.
