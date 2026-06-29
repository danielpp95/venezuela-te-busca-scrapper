#!/usr/bin/env node
/**
 * venezuelatebusca.com scraper
 * Humanitarian use — earthquake missing persons registry
 *
 * Usage:
 *   node scraper.js              # Start / resume full scrape
 *   node scraper.js --watch      # Hourly check for NEW cases only
 *   node scraper.js --reset      # Clear state and start fresh
 *   node scraper.js --page 42    # Scrape a single specific page
 *   node scraper.js --stats      # Show current state/progress
 */

"use strict";

const https = require("node:https");
const http  = require("node:http");
const fs    = require("node:fs");
const path  = require("node:path");
const url   = require("node:url");

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG = {
  baseUrl:          "https://venezuelatebusca.com",
  mediaBase:        "https://venezuelatebusca.com",
  personsPerPage:   24,
  csvRowsPerFile:   5000,
  requestDelay:     600,        // ms between page requests
  imageDelay:       100,        // ms between image downloads
  imageConcurrency: 5,          // parallel image downloads
  maxRetries:       5,
  retryBase:        2000,       // ms base for exponential backoff
  watchInterval:    60 * 60 * 1000, // 1 hour in ms
  dataDir:          path.join(process.cwd(), "DATA"),
  imagesDir:        path.join(process.cwd(), "DATA", "Images"),
  stateFile:        path.join(process.cwd(), "DATA", ".state.json"),
  userAgent:        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

// ─── CSV columns ─────────────────────────────────────────────────────────────

const CSV_COLUMNS = [
  "id", "firstName", "lastName", "idNumber", "age", "gender",
  "status", "lastSeen", "description",
  "photoUrl", "photoLocalFile",
  "createdAt", "updatedAt", "lastActivityAt",
  "reporterName", "reporterPhone", "reporterEmail",
  "foundNote", "finderName", "finderPhone", "finderEmail",
  "hospitalName", "hospitalStatus",
  "sources", "tips",
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(msg) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ─── State management ────────────────────────────────────────────────────────

function loadState() {
  if (fs.existsSync(CONFIG.stateFile)) {
    try { return JSON.parse(fs.readFileSync(CONFIG.stateFile, "utf8")); }
    catch { /* corrupted, start fresh */ }
  }
  return {
    currentPage:     1,
    totalPages:      null,
    totalScraped:    0,
    csvFileIndex:    1,
    csvRowCount:     0,
    completedPages:  [],
    failedPages:     [],
    lastRunAt:       null,
    newestCreatedAt: null,
    totalCount:      null,
  };
}

function saveState(state) {
  ensureDir(CONFIG.dataDir);
  state.lastRunAt = new Date().toISOString();
  fs.writeFileSync(CONFIG.stateFile, JSON.stringify(state, null, 2));
}

// ─── HTTP fetch ──────────────────────────────────────────────────────────────

function fetchUrl(targetUrl, binary = false) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const lib = parsed.protocol === "https:" ? https : http;
    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   "GET",
      headers:  {
        "User-Agent":      CONFIG.userAgent,
        "Accept":          binary ? "image/*,*/*" : "text/html,application/xhtml+xml,*/*;q=0.9",
        "Accept-Language": "es-VE,es;q=0.9,en;q=0.8",
        "Accept-Encoding": "identity",
        "Referer":         CONFIG.baseUrl + "/",
        "Cache-Control":   "no-cache",
      },
    };
    const req = lib.get(options, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, binary).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({
        status:  res.statusCode,
        headers: res.headers,
        body:    binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(new Error("Timeout")); });
  });
}

async function fetchWithRetry(targetUrl, binary = false, retries = CONFIG.maxRetries) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchUrl(targetUrl, binary);
      if (res.status === 429 || res.status === 503) {
        const wait = CONFIG.retryBase * Math.pow(2, attempt);
        log(`  Rate limited (${res.status}), waiting ${(wait/1000).toFixed(1)}s…`);
        await sleep(wait);
        continue;
      }
      if (res.status === 200) return res;
      if (res.status === 404) return null;
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (attempt === retries) throw err;
      const wait = CONFIG.retryBase * Math.pow(2, attempt);
      log(`  Error: ${err.message}, retry ${attempt + 1}/${retries} in ${(wait/1000).toFixed(1)}s…`);
      await sleep(wait);
    }
  }
}

// ─── Flight data parser ───────────────────────────────────────────────────────

function parseFlightData(html) {
  // Find the streamController.enqueue("...") script block
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/g;
  let m, flightScript = null;
  while ((m = scriptRe.exec(html)) !== null) {
    if (m[1].includes("streamController.enqueue")) {
      flightScript = m[1];
      break;
    }
  }
  if (!flightScript) return null;

  const startMarker = '.enqueue("';
  const startIdx = flightScript.indexOf(startMarker) + startMarker.length;
  if (startIdx < startMarker.length) return null;

  // Find closing quote (not preceded by backslash)
  let endIdx = startIdx;
  while (endIdx < flightScript.length) {
    if (flightScript[endIdx] === '"' && flightScript[endIdx - 1] !== "\\") break;
    endIdx++;
  }

  const rawStr = flightScript.substring(startIdx, endIdx);
  // JSON.parse on the quoted string handles all JS escape sequences correctly
  const jsonStr = JSON.parse('"' + rawStr + '"');
  return JSON.parse(jsonStr);
}

// Decode a value from the flat flight array
function decodeVal(arr, v, depth = 0) {
  if (depth > 10) return null; // prevent infinite loops
  if (v === -5 || v === -7) return null;
  if (typeof v === "number" && v >= 0) {
    const item = arr[v];
    if (item === null || item === undefined) return null;
    if (Array.isArray(item)) return item.map(x => decodeVal(arr, x, depth + 1));
    if (typeof item === "object") return decodeObj(arr, item, depth + 1);
    return item;
  }
  if (typeof v === "object" && v !== null && !Array.isArray(v)) return decodeObj(arr, v, depth + 1);
  if (Array.isArray(v)) return v.map(x => decodeVal(arr, x, depth + 1));
  return v;
}

function decodeObj(arr, obj, depth = 0) {
  if (Array.isArray(obj)) return obj.map(x => decodeVal(arr, x, depth + 1));
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    const keyIdx = parseInt(k.slice(1), 10);
    const key = arr[keyIdx];
    if (typeof key === "string") result[key] = decodeVal(arr, v, depth + 1);
  }
  return result;
}

function extractPageData(html) {
  const arr = parseFlightData(html);
  if (!arr) return null;

  // Total count
  const totalCountIdx = arr.indexOf("totalCount");
  const totalCount = totalCountIdx > -1 ? arr[totalCountIdx + 1] : null;

  // Persons list
  const personsIdx = arr.indexOf("persons");
  if (personsIdx === -1) return null;
  const personRefs = arr[personsIdx + 1];
  if (!Array.isArray(personRefs)) return null;

  const persons = personRefs.map(ref => {
    const raw = arr[ref];
    if (!raw || typeof raw !== "object") return null;
    return decodeObj(arr, raw);
  }).filter(Boolean);

  // Pagination
  const pageIdx  = arr.indexOf("page");
  const hasMoreIdx = arr.indexOf("hasMore");
  const page    = pageIdx > -1 ? arr[pageIdx + 1] : null;
  const hasMore = hasMoreIdx > -1 ? arr[hasMoreIdx + 1] : false;

  return { persons, page, hasMore, totalCount };
}

// ─── Person flattening ───────────────────────────────────────────────────────

function flattenPerson(p) {
  const reporter = p.reporter || {};
  const finder   = p.finder   || {};

  // Sources: array of objects with source, sourceId, notes
  const sourcesStr = Array.isArray(p.sources)
    ? p.sources.map(s => {
        if (!s || typeof s !== "object") return String(s);
        return [s.source, s.sourceId, s.notes].filter(Boolean).join("|");
      }).join("; ")
    : "";

  // Tips: array of contact tips
  const tipsStr = Array.isArray(p.tips)
    ? p.tips.map(t => {
        if (!t || typeof t !== "object") return String(t);
        return [t.type, t.value, t.label].filter(Boolean).join("|");
      }).join("; ")
    : "";

  // Image local filename
  const photoFile = p.photoUrl
    ? path.basename(p.photoUrl)
    : "";

  return {
    id:               p.id            || "",
    firstName:        p.firstName     || "",
    lastName:         p.lastName      || "",
    idNumber:         p.idNumber      || "",
    age:              p.age           ?? "",
    gender:           p.gender        || "",
    status:           p.status        || "",
    lastSeen:         p.lastSeen      || "",
    description:      (p.description  || "").replace(/\r?\n/g, " "),
    photoUrl:         p.photoUrl      || "",
    photoLocalFile:   photoFile,
    createdAt:        p.createdAt     || "",
    updatedAt:        p.updatedAt     || "",
    lastActivityAt:   p.lastActivityAt || "",
    reporterName:     reporter.name   || "",
    reporterPhone:    reporter.phone  || "",
    reporterEmail:    reporter.email  || "",
    foundNote:        (p.foundNote    || "").replace(/\r?\n/g, " "),
    finderName:       finder.name     || "",
    finderPhone:      finder.phone    || "",
    finderEmail:      finder.email    || "",
    hospitalName:     p.hospitalName  || "",
    hospitalStatus:   p.hospitalStatus || "",
    sources:          sourcesStr,
    tips:             tipsStr,
  };
}

// ─── CSV writer ──────────────────────────────────────────────────────────────

function csvEscape(val) {
  const s = String(val ?? "");
  if (s.includes('"') || s.includes(",") || s.includes("\n") || s.includes("\r")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function csvRow(obj) {
  return CSV_COLUMNS.map(col => csvEscape(obj[col])).join(",") + "\n";
}

// UTF-8 BOM ensures Excel and Windows tools display accents correctly
const CSV_HEADER = "﻿" + CSV_COLUMNS.join(",") + "\n";

function csvFilePath(index) {
  return path.join(CONFIG.dataDir, `persons_${String(index).padStart(3, "0")}.csv`);
}

function appendToCSV(state, rows) {
  for (const row of rows) {
    // Rotate file if needed
    if (state.csvRowCount >= CONFIG.csvRowsPerFile) {
      state.csvFileIndex++;
      state.csvRowCount = 0;
    }

    const filePath = csvFilePath(state.csvFileIndex);
    const isNew = !fs.existsSync(filePath);

    if (isNew) {
      fs.writeFileSync(filePath, CSV_HEADER);
    }

    fs.appendFileSync(filePath, csvRow(row));
    state.csvRowCount++;
    state.totalScraped++;
  }
}

// ─── Image downloader ────────────────────────────────────────────────────────

async function downloadImage(photoUrl, state) {
  if (!photoUrl) return;
  const filename = path.basename(photoUrl);
  const destPath = path.join(CONFIG.imagesDir, filename);

  if (fs.existsSync(destPath)) return; // already downloaded

  const fullUrl = CONFIG.mediaBase + photoUrl;
  try {
    const res = await fetchWithRetry(fullUrl, true, 3);
    if (res && res.body && res.body.length > 0) {
      fs.writeFileSync(destPath, res.body);
    }
  } catch (err) {
    log(`  Image failed: ${filename} — ${err.message}`);
  }
}

async function downloadImagesForPage(persons) {
  const queue = persons.filter(p => p.photoUrl).map(p => p.photoUrl);
  // Process in chunks of imageConcurrency
  for (let i = 0; i < queue.length; i += CONFIG.imageConcurrency) {
    const batch = queue.slice(i, i + CONFIG.imageConcurrency);
    await Promise.all(batch.map(u => downloadImage(u)));
    if (i + CONFIG.imageConcurrency < queue.length) await sleep(CONFIG.imageDelay);
  }
}

// ─── Core scraper ────────────────────────────────────────────────────────────

async function scrapePage(pageNum) {
  const pageUrl = `${CONFIG.baseUrl}/?page=${pageNum}`;
  const res = await fetchWithRetry(pageUrl);
  if (!res) return null;
  return extractPageData(res.body);
}

async function runFullScrape(state, opts = {}) {
  ensureDir(CONFIG.dataDir);
  ensureDir(CONFIG.imagesDir);

  log("Starting full scrape…");
  log(`State: page ${state.currentPage}, ${state.totalScraped} already scraped`);

  let page = opts.singlePage || state.currentPage;
  const singlePage = Boolean(opts.singlePage);

  while (true) {
    // Skip already-completed pages (unless doing a single-page run)
    if (!singlePage && state.completedPages.includes(page)) {
      log(`Page ${page} already done, skipping`);
      page++;
      continue;
    }

    log(`Fetching page ${page}${state.totalPages ? "/" + state.totalPages : ""}…`);

    let data = null;
    try {
      data = await scrapePage(page);
    } catch (err) {
      log(`  Failed page ${page}: ${err.message}`);
      if (!state.failedPages.includes(page)) state.failedPages.push(page);
      if (singlePage) break;
      page++;
      saveState(state);
      await sleep(CONFIG.requestDelay * 3);
      continue;
    }

    if (!data) {
      log(`  No data on page ${page}, stopping`);
      break;
    }

    if (data.totalCount && !state.totalCount) {
      state.totalCount = data.totalCount;
      state.totalPages = Math.ceil(data.totalCount / CONFIG.personsPerPage);
      log(`Total: ${data.totalCount} persons (~${state.totalPages} pages)`);
    }

    const flatPersons = data.persons.map(flattenPerson);

    // Track newest record for watch mode
    if (flatPersons.length > 0 && flatPersons[0].createdAt) {
      const newest = flatPersons.reduce((a, b) =>
        (a.createdAt > b.createdAt ? a : b), flatPersons[0]);
      if (!state.newestCreatedAt || newest.createdAt > state.newestCreatedAt) {
        state.newestCreatedAt = newest.createdAt;
      }
    }

    // Write CSV
    appendToCSV(state, flatPersons);
    log(`  Wrote ${flatPersons.length} persons → CSV #${state.csvFileIndex} (${state.totalScraped} total)`);

    // Download images (non-blocking relative to CSV, but awaited per page)
    await downloadImagesForPage(data.persons);

    if (!state.completedPages.includes(page)) state.completedPages.push(page);
    state.currentPage = page + 1;
    saveState(state);

    if (singlePage) break;
    if (!data.hasMore) {
      log("No more pages. Scrape complete!");
      break;
    }

    page++;
    await sleep(CONFIG.requestDelay);
  }

  // Retry failed pages once at the end
  if (!singlePage && state.failedPages.length > 0) {
    log(`\nRetrying ${state.failedPages.length} failed pages…`);
    const toRetry = [...state.failedPages];
    state.failedPages = [];
    for (const fp of toRetry) {
      log(`Re-fetching page ${fp}…`);
      try {
        const data = await scrapePage(fp);
        if (data) {
          appendToCSV(state, data.persons.map(flattenPerson));
          await downloadImagesForPage(data.persons);
          state.completedPages.push(fp);
          log(`  Recovered page ${fp}: ${data.persons.length} persons`);
        }
      } catch (err) {
        log(`  Still failing: ${fp} — ${err.message}`);
        state.failedPages.push(fp);
      }
      saveState(state);
      await sleep(CONFIG.requestDelay * 2);
    }
  }

  printStats(state);
}

// ─── Watch mode ──────────────────────────────────────────────────────────────

async function runWatch(state) {
  ensureDir(CONFIG.dataDir);
  ensureDir(CONFIG.imagesDir);

  log("Watch mode started — checking for new cases every hour");
  log(`Last known newest case: ${state.newestCreatedAt || "unknown"}`);

  while (true) {
    log("Checking for new cases…");
    let totalNew = 0;
    let newestFoundAt = state.newestCreatedAt;

    try {
      let page = 1;
      let keepPaging = true;

      while (keepPaging) {
        log(`  Scanning page ${page}…`);
        const data = await scrapePage(page);

        if (!data || data.persons.length === 0) break;

        // Update total count from first page
        if (page === 1 && data.totalCount) {
          log(`  Site total: ${data.totalCount} persons`);
          state.totalCount = data.totalCount;
        }

        // Filter only persons newer than what we've already seen
        const newPersons = state.newestCreatedAt
          ? data.persons.filter(p => p.createdAt > state.newestCreatedAt)
          : data.persons;

        if (newPersons.length > 0) {
          appendToCSV(state, newPersons.map(flattenPerson));
          await downloadImagesForPage(newPersons);
          totalNew += newPersons.length;

          // Track the newest createdAt found in this batch
          const batchNewest = newPersons.reduce((a, b) =>
            (a.createdAt > b.createdAt ? a : b), newPersons[0]);
          if (!newestFoundAt || batchNewest.createdAt > newestFoundAt) {
            newestFoundAt = batchNewest.createdAt;
          }

          log(`  Page ${page}: ${newPersons.length} new cases`);
        }

        // Stop paginating if this page had cases older than our checkpoint
        // (means we've caught up to previously-seen data)
        const hasOldCases = newPersons.length < data.persons.length;
        if (hasOldCases || !data.hasMore) {
          keepPaging = false;
        } else {
          page++;
          await sleep(CONFIG.requestDelay);
        }
      }

      if (totalNew > 0) {
        state.newestCreatedAt = newestFoundAt;
        saveState(state);
        log(`Done — wrote ${totalNew} new case(s) total`);
      } else {
        log("No new cases since last check.");
      }

    } catch (err) {
      log(`Watch check failed: ${err.message}`);
    }

    log(`Next check in 1 hour…`);
    await sleep(CONFIG.watchInterval);
  }
}

// ─── Stats ───────────────────────────────────────────────────────────────────

function printStats(state) {
  const csvFiles = fs.existsSync(CONFIG.dataDir)
    ? fs.readdirSync(CONFIG.dataDir).filter(f => f.endsWith(".csv")).length
    : 0;
  const imgCount = fs.existsSync(CONFIG.imagesDir)
    ? fs.readdirSync(CONFIG.imagesDir).length
    : 0;

  console.log("\n═══════════════════════════════════════");
  console.log("  SCRAPE STATS");
  console.log("═══════════════════════════════════════");
  console.log(`  Total scraped:    ${state.totalScraped}`);
  console.log(`  Site total:       ${state.totalCount || "unknown"}`);
  console.log(`  Pages done:       ${state.completedPages.length}`);
  console.log(`  Pages failed:     ${state.failedPages.length}`);
  console.log(`  Current page:     ${state.currentPage}`);
  console.log(`  CSV files:        ${csvFiles}`);
  console.log(`  Images:           ${imgCount}`);
  console.log(`  Last run:         ${state.lastRunAt || "never"}`);
  console.log("═══════════════════════════════════════\n");
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const watchMode  = args.includes("--watch");
  const resetMode  = args.includes("--reset");
  const statsMode  = args.includes("--stats");
  const pageArg    = args.indexOf("--page");
  const singlePage = pageArg > -1 ? parseInt(args[pageArg + 1], 10) : null;

  ensureDir(CONFIG.dataDir);
  ensureDir(CONFIG.imagesDir);

  if (resetMode) {
    if (fs.existsSync(CONFIG.stateFile)) fs.unlinkSync(CONFIG.stateFile);
    log("State cleared. Run without --reset to start fresh.");
    return;
  }

  const state = loadState();

  if (statsMode) {
    printStats(state);
    return;
  }

  if (watchMode) {
    await runWatch(state);
    return;
  }

  if (singlePage) {
    log(`Scraping single page ${singlePage}…`);
    await runFullScrape(state, { singlePage });
    return;
  }

  // Full scrape (default)
  await runFullScrape(state);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
