# Venezuela Te Busca — Scraper

Humanitarian scraper for [venezuelatebusca.com](https://venezuelatebusca.com/) — missing persons registry after the 2026 Venezuela earthquake.

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
```

## CSV columns

| Column | Description |
|---|---|
| id | UUID |
| firstName / lastName | Name |
| idNumber | Cédula / ID |
| age | Age |
| gender | male / female / other |
| status | missing / found |
| lastSeen | Last known location |
| description | Free-text description |
| photoUrl | Remote URL (`/media/photos/…`) |
| photoLocalFile | Filename in `DATA/Images/` |
| createdAt / updatedAt / lastActivityAt | Timestamps (ISO 8601) |
| reporterName / reporterPhone / reporterEmail | Who reported |
| foundNote | How/where they were found |
| finderName / finderPhone / finderEmail | Finder contact |
| hospitalName / hospitalStatus | Hospital info (admitted / discharged / deceased) |
| sources | Source references |
| tips | Contact tips provided |

---

## Commands

```bash
# Full scrape (start or resume automatically)
node scraper.js

# Scrape a single page (useful for testing)
node scraper.js --page 5

# Check for new cases every hour (run after full scrape)
node scraper.js --watch

# Show current progress
node scraper.js --stats

# Clear all state and start fresh (does NOT delete DATA/ files)
node scraper.js --reset
```

## Pause & Resume

Just press **Ctrl+C** at any time. State is saved after every page.
Running `node scraper.js` again will pick up exactly where it left off.

## Rate limiting

The scraper waits **600 ms** between page requests and backs off exponentially on 429/503 errors. To be more aggressive (not recommended), edit `CONFIG.requestDelay` in `scraper.js`.

## Watch mode (hourly new cases)

```bash
node scraper.js --watch
```

Checks page 1 every hour and appends any cases newer than the last scraped
`createdAt` to the current CSV file.

To run it in the background on Windows:

```powershell
Start-Process node -ArgumentList "scraper.js --watch" -WindowStyle Minimized
```

---

## Requirements

- Node.js v18+ (no npm packages required)
