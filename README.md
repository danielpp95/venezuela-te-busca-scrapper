# Venezuela Te Busca — Scraper

Humanitarian scraper for [venezuelatebusca.com](https://venezuelatebusca.com/) — missing persons registry after the 2026 Venezuela earthquake.

No external dependencies. Runs with Node.js 18+.

---

## Output structure

```
DATA/
  persons_001.csv     ← up to 5,000 rows each
  persons_002.csv
  ...
  Images/
    <uuid>.webp       ← one file per person photo
  .state.json         ← pause/resume checkpoint
scraper.log           ← stdout when running in background
scraper.err           ← stderr when running in background
```

---

## Commands

```bash
# Start a full scrape (or resume if previously paused)
node scraper.js

# Check for new cases every hour (run after the full scrape completes)
node scraper.js --watch

# Show current progress
node scraper.js --stats

# Clear state and start from scratch (does NOT delete DATA/ files)
node scraper.js --reset
```

### Running in the background (Windows)

```powershell
Start-Process node -ArgumentList "scraper.js" `
  -RedirectStandardOutput scraper.log `
  -RedirectStandardError scraper.err `
  -NoNewWindow
```

### Stopping

Press **Ctrl+C** at any time. Progress is saved after every batch (~24 persons). Running `node scraper.js` again resumes from exactly where it left off.

---

## How it works

The site is a server-side rendered React/Remix app. Person data is embedded in each page's HTML as a serialized React flight format — no headless browser needed.

**Pagination** uses opaque base64 cursors. Each response includes a `nextCursor` token that encodes the last record's ID and timestamp. The scraper saves the current cursor to `.state.json` after every batch, enabling pause/resume.

**Watch mode** starts from page 1 (newest cases) each hour and follows cursors forward as long as it keeps finding cases newer than the saved checkpoint. It stops as soon as it hits a case that was already seen, or after 100 batches (~2,400 cases) as a safety cap.

---

## CSV columns

| Column | Description |
|---|---|
| id | UUID |
| firstName / lastName | Name |
| idNumber | Cédula / national ID |
| age | Age |
| gender | `male` / `female` / `other` |
| status | `missing` / `found` |
| lastSeen | Last known location |
| description | Free-text notes |
| photoUrl | Remote path (`/media/photos/…`) |
| photoLocalFile | Filename inside `DATA/Images/` |
| createdAt / updatedAt / lastActivityAt | Timestamps (ISO 8601 UTC) |
| reporterName / reporterPhone / reporterEmail | Who reported the case |
| foundNote | How / where the person was found |
| finderName / finderPhone / finderEmail | Finder contact info |
| hospitalName / hospitalStatus | Hospital (`admitted` / `discharged` / `deceased`) |
| sources | Data sources, pipe-separated |
| tips | Contact tips provided |

CSV files are UTF-8 with BOM so Excel and Windows tools display accented characters correctly.

---

## Configuration

Edit the `CONFIG` block at the top of `scraper.js`:

| Key | Default | Description |
|---|---|---|
| `requestDelay` | `600` ms | Wait between page requests |
| `imageConcurrency` | `5` | Parallel image downloads |
| `csvRowsPerFile` | `5000` | Rows per CSV file before rotating |
| `watchInterval` | `3600000` ms | How often watch mode checks (1 hour) |
| `maxRetries` | `5` | Retries per failed request |
