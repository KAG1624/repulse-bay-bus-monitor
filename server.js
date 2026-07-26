/**
 * Repulse Bay Bus Monitor — server.
 *
 * Polls, once per interval regardless of open tabs:
 *  - Citybus real-time ETAs (rt.data.gov.hk) for the two stop poles resolved
 *    by scripts/resolve-stops.js
 *  - GMB minibus real-time ETAs (data.etagmb.gov.hk) for the route directions
 *    discovered by scripts/discover-gmb-routes.js
 * and separately, on slower cycles, Hong Kong Observatory weather
 * (current conditions + gridded 2-hour rainfall nowcast).
 *
 * Also keeps a local departure-history log (data/history.jsonl): each time a
 * tracked vehicle's ETA disappears from the feed, the observed arrival is
 * approximated and compared against its first prediction, powering
 * GET /api/reliability.
 */

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT, 10) || 3000;
// Both upstream ETA feeds refresh roughly every 60s. Never poll faster than 45s.
const MIN_POLL_MS = 45000;
const POLL_MS = Math.max(MIN_POLL_MS, parseInt(process.env.POLL_INTERVAL_MS, 10) || 60000);
const MANUAL_REFRESH_MIN_MS = 30000;
const FETCH_TIMEOUT_MS = 12000;
const WEATHER_POLL_MS = 5 * 60 * 1000; // current conditions
const NOWCAST_POLL_MS = 10 * 60 * 1000; // 2.7MB gridded CSV — keep it slow

const CTB_API = 'https://rt.data.gov.hk/v2/transport/citybus';
const GMB_API = 'https://data.etagmb.gov.hk';
const HKO_RHRREAD = 'https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=rhrread&lang=en';
const HKO_NOWCAST = 'https://data.weather.gov.hk/weatherAPI/hko_data/F3/Gridded_rainfall_nowcast.csv';

const CONFIG_PATH = path.join(__dirname, 'config', 'stops.json');
const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_PATH = path.join(DATA_DIR, 'history.jsonl');
const HISTORY_WINDOW_MS = 7 * 24 * 3600 * 1000; // reliability stats window
const HISTORY_MAX_RECORDS = 20000;

// Preferred HKO stations for the Repulse Bay area, in order.
const TEMP_STATIONS = ['Stanley', 'Wong Chuk Hang', 'Hong Kong Observatory'];
const RAIN_DISTRICT = 'Southern District';
// Nowcast: nearest grid cell to the stop pair.
const NOWCAST_TARGET = { lat: 22.2381, long: 114.1981 };
const RAIN_MM_THRESHOLD = 0.5; // per half-hour window ≈ noticeable rain

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (err) {
  console.error(
    `Could not read ${CONFIG_PATH}.\n` +
      'Run "npm run resolve-stops" and "npm run discover-gmb-routes" first.'
  );
  process.exit(1);
}
if (!Array.isArray(config.stops) || config.stops.length !== 2) {
  console.error(`${CONFIG_PATH} is missing the Citybus stops. Run "npm run resolve-stops".`);
  process.exit(1);
}
const GMB_ENTRIES = config.gmb?.entries || [];
if (GMB_ENTRIES.length === 0) {
  console.warn(
    'Warning: no GMB entries in config — minibuses will not be shown. Run "npm run discover-gmb-routes".'
  );
}
const WALK_TIME_MIN = Number(config.walkTimeMinutes) || 5;

// ---------------------------------------------------------------------------
// Shared fetch helpers
// ---------------------------------------------------------------------------
async function fetchWithTimeout(url, asText = false) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return asText ? await res.text() : await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// Fetch plan
// ---------------------------------------------------------------------------
// Citybus: one request per (pole, route), remembering which direction(s) the
// pole serves so responses can be filtered.
function buildCtbPlan() {
  const plan = [];
  for (const stop of config.stops) {
    const byRoute = new Map();
    for (const r of stop.routes) {
      const rec = byRoute.get(r.route) || { route: r.route, dirs: new Set(), dest_en: r.dest_en };
      rec.dirs.add(r.dir);
      byRoute.set(r.route, rec);
    }
    for (const rec of byRoute.values()) plan.push({ stop, ...rec });
  }
  return plan;
}
const CTB_PLAN = buildCtbPlan();

// GMB: one display card per (route_code, side, displayLabel); a card may pool
// several service variants (route_id/route_seq/stop_seq triples) — e.g. route
// 52's "special departure" variants — whose ETAs are merged.
function buildGmbCards() {
  const cards = new Map();
  for (const e of GMB_ENTRIES) {
    const key = `${e.route_code}|${e.side}|${e.displayLabel}`;
    const card = cards.get(key) || {
      key,
      route: e.route_code,
      side: e.side,
      displayLabel: e.displayLabel,
      dest_en: e.dest_en,
      dest_tc: e.dest_tc,
      triples: [],
    };
    card.triples.push({ route_id: e.route_id, route_seq: e.route_seq, stop_seq: e.stop_seq });
    cards.set(key, card);
  }
  return [...cards.values()];
}
const GMB_CARDS = buildGmbCards();

// ---------------------------------------------------------------------------
// ETA polling + cache
// ---------------------------------------------------------------------------
let snapshot = null;
let lastPollAt = 0;
let lastManualAt = 0;
let pollCount = 0;
let polling = null;

async function pollCtb(isFirst) {
  return mapWithConcurrency(CTB_PLAN, 6, async ({ stop, route, dirs }) => {
    const url = `${CTB_API}/eta/CTB/${stop.id}/${route}`;
    try {
      const json = await fetchWithTimeout(url);
      if (isFirst) console.log(`[raw ctb] GET ${url}\n${JSON.stringify(json)}`);
      const etas = (json.data || [])
        .filter((e) => e.eta && dirs.has(e.dir))
        .map((e) => ({
          eta: e.eta,
          dest_en: e.dest_en,
          rmk_en: e.rmk_en || '',
        }))
        .sort((a, b) => new Date(a.eta) - new Date(b.eta));
      return { side: stop.label, route, ok: true, etas };
    } catch (err) {
      console.error(`[poll ctb] ${url} failed: ${err.message}`);
      return { side: stop.label, route, ok: false, error: err.message, etas: [] };
    }
  });
}

async function pollGmb(isFirst) {
  return mapWithConcurrency(GMB_CARDS, 6, async (card) => {
    const merged = [];
    let okCount = 0;
    let lastError = null;
    for (const t of card.triples) {
      const url = `${GMB_API}/eta/route-stop/${t.route_id}/${t.route_seq}/${t.stop_seq}`;
      try {
        const json = await fetchWithTimeout(url);
        if (isFirst) console.log(`[raw gmb] GET ${url}\n${JSON.stringify(json)}`);
        okCount++;
        for (const e of json.data?.eta || []) {
          if (e.timestamp) merged.push({ eta: e.timestamp, dest_en: card.dest_en, rmk_en: e.remarks_en || '' });
        }
      } catch (err) {
        lastError = err.message;
        console.error(`[poll gmb] ${url} failed: ${err.message}`);
      }
    }
    merged.sort((a, b) => new Date(a.eta) - new Date(b.eta));
    // Pooled variants can echo the same physical trip; drop near-duplicates.
    const etas = merged.filter(
      (e, i) => i === 0 || new Date(e.eta) - new Date(merged[i - 1].eta) > 60000
    );
    return {
      side: card.side,
      route: card.route,
      displayLabel: card.displayLabel,
      ok: okCount > 0,
      error: okCount > 0 ? null : lastError,
      etas,
      requests: card.triples.length,
      failedRequests: card.triples.length - okCount,
    };
  });
}

async function poll({ manual = false } = {}) {
  const isFirst = pollCount === 0;
  const startedAt = Date.now();

  const [ctbResults, gmbResults] = await Promise.all([pollCtb(isFirst), pollGmb(isFirst)]);

  const sides = ['Towards Stanley', 'Into Town'].map((side) => {
    const pole = config.stops.find((s) => s.label === side);
    const items = [
      ...ctbResults
        .filter((r) => r.side === side)
        .map((r) => ({
          network: 'CTB',
          route: r.route,
          displayLabel: side,
          dest_en: r.etas[0]?.dest_en || destFromConfig(pole, r.route),
          ok: r.ok,
          error: r.error || null,
          etas: r.etas,
        })),
      ...gmbResults
        .filter((r) => r.side === side)
        .map((r) => ({
          network: 'GMB',
          route: r.route,
          displayLabel: r.displayLabel,
          dest_en: r.etas[0]?.dest_en || GMB_CARDS.find((c) => c.route === r.route && c.side === side)?.dest_en || '',
          ok: r.ok,
          error: r.error,
          etas: r.etas,
        })),
    ];
    return {
      side,
      stop: pole ? { id: pole.id, name_en: pole.name_en, name_tc: pole.name_tc } : null,
      items,
    };
  });

  const totalRequests =
    ctbResults.length + gmbResults.reduce((n, r) => n + r.requests, 0);
  const failedRequests =
    ctbResults.filter((r) => !r.ok).length +
    gmbResults.reduce((n, r) => n + r.failedRequests, 0);

  snapshot = {
    generatedAt: new Date(startedAt).toISOString(),
    pollIntervalMs: POLL_MS,
    location: config.location,
    walkTimeMinutes: WALK_TIME_MIN,
    ok: failedRequests < totalRequests,
    failedRequests,
    totalRequests,
    sides,
  };
  lastPollAt = startedAt;
  pollCount++;

  recordHistory(sides, startedAt);

  const summary = sides
    .map(
      (s) =>
        `${s.side} [${s.items
          .map((i) => `${i.network === 'GMB' ? 'm' : ''}${i.route}:${i.ok ? (i.etas[0] ? i.etas[0].eta.slice(11, 19) : '—') : 'ERR'}`)
          .join(' ')}]`
    )
    .join('  ');
  console.log(
    `[poll #${pollCount}${manual ? ' manual' : ''}] ${new Date(startedAt).toISOString()} ` +
      `${failedRequests ? `(${failedRequests}/${totalRequests} requests failed) ` : ''}${summary}`
  );
}

function destFromConfig(pole, route) {
  return pole?.routes.find((r) => r.route === route)?.dest_en || '';
}

function pollCoalesced(opts) {
  if (!polling) {
    polling = poll(opts).finally(() => {
      polling = null;
    });
  }
  return polling;
}

// ---------------------------------------------------------------------------
// Departure history & reliability
// ---------------------------------------------------------------------------
// Approximation: track the soonest predicted vehicle per (network, side,
// route). When that prediction vanishes from the feed (or the soonest ETA
// jumps forward by > 3 minutes, meaning the tracked vehicle departed and the
// next one is now first), the vehicle is considered arrived at roughly its
// last predicted time. delaySec compares that against its FIRST prediction.
const tracked = new Map(); // key -> {firstPredicted, lastPredicted, polls}
let history = []; // in-memory copy of recent records

function loadHistory() {
  try {
    const lines = fs.readFileSync(HISTORY_PATH, 'utf8').split('\n').filter(Boolean);
    const cutoff = Date.now() - HISTORY_WINDOW_MS;
    history = lines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((r) => r && new Date(r.observed).getTime() > cutoff)
      .slice(-HISTORY_MAX_RECORDS);
    console.log(`[history] loaded ${history.length} records from ${HISTORY_PATH}`);
  } catch {
    history = [];
  }
}

function recordHistory(sides, nowMs) {
  const seen = new Set();
  const appendLines = [];
  for (const side of sides) {
    for (const item of side.items) {
      const key = `${item.network}|${side.side}|${item.route}`;
      seen.add(key);
      if (!item.ok) continue; // fetch failure ≠ vehicle departed; keep tracking
      const soonest = item.etas[0] ? new Date(item.etas[0].eta).getTime() : null;
      const t = tracked.get(key);
      if (t) {
        if (soonest && Math.abs(soonest - t.lastPredicted) < 3 * 60000) {
          // Same vehicle, prediction refined.
          t.lastPredicted = soonest;
          t.polls++;
          continue;
        }
        // Tracked vehicle left the feed. Only treat that as an ARRIVAL if its
        // prediction was about to come due — GMB "scheduled" ETAs sometimes
        // jump forward several minutes (a reschedule, not a departure), which
        // must be discarded or it poisons the stats with fake early arrivals.
        const wasDue = t.lastPredicted <= nowMs + 90 * 1000;
        if (t.polls >= 2 && wasDue) {
          const observed = Math.min(t.lastPredicted, nowMs);
          const rec = {
            network: item.network,
            route: item.route,
            side: side.side,
            firstPredicted: new Date(t.firstPredicted).toISOString(),
            lastPredicted: new Date(t.lastPredicted).toISOString(),
            observed: new Date(observed).toISOString(),
            delaySec: Math.round((observed - t.firstPredicted) / 1000),
          };
          history.push(rec);
          appendLines.push(JSON.stringify(rec));
        }
        tracked.delete(key);
      }
      if (soonest) {
        tracked.set(key, { firstPredicted: soonest, lastPredicted: soonest, polls: 1 });
      }
    }
  }
  for (const key of [...tracked.keys()]) if (!seen.has(key)) tracked.delete(key);
  if (appendLines.length) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFile(HISTORY_PATH, appendLines.join('\n') + '\n', (err) => {
      if (err) console.error('[history] append failed:', err.message);
    });
    const cutoff = Date.now() - HISTORY_WINDOW_MS;
    if (history.length > HISTORY_MAX_RECORDS) {
      history = history.filter((r) => new Date(r.observed).getTime() > cutoff).slice(-HISTORY_MAX_RECORDS);
    }
  }
}

function reliabilityStats() {
  const cutoff = Date.now() - HISTORY_WINDOW_MS;
  const byRoute = new Map();
  for (const r of history) {
    if (new Date(r.observed).getTime() < cutoff) continue;
    const key = `${r.network}|${r.route}`;
    const agg = byRoute.get(key) || { network: r.network, route: r.route, n: 0, delaySum: 0, late: 0 };
    agg.n++;
    agg.delaySum += r.delaySec;
    if (r.delaySec > 180) agg.late++;
    byRoute.set(key, agg);
  }
  return {
    windowDays: HISTORY_WINDOW_MS / 86400000,
    generatedAt: new Date().toISOString(),
    routes: [...byRoute.values()]
      .map((a) => ({
        network: a.network,
        route: a.route,
        samples: a.n,
        avgDelayMin: +(a.delaySum / a.n / 60).toFixed(1),
        latePct: Math.round((a.late / a.n) * 100),
      }))
      .sort((a, b) => a.route.localeCompare(b.route, undefined, { numeric: true })),
  };
}

// ---------------------------------------------------------------------------
// Route paths (full stop sequence + road-following geometry)
// ---------------------------------------------------------------------------
// Used by the dashboard's "remaining stops" popup and the map's route lines.
// Stop sequences come from the official CTB/GMB APIs; the line geometry that
// follows the actual roads comes from the free OSRM demo router (cached to
// disk permanently, so it is hit at most once per route direction ever).
// If OSRM is unreachable the geometry falls back to chaining the stops.
const ROUTE_PATHS_PATH = path.join(DATA_DIR, 'route-paths.json');
const OSRM_API = 'https://router.project-osrm.org/route/v1/driving';
let routePaths = {};
try {
  routePaths = JSON.parse(fs.readFileSync(ROUTE_PATHS_PATH, 'utf8'));
} catch {
  routePaths = {};
}
const routePathInflight = new Map();

function saveRoutePaths() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFile(ROUTE_PATHS_PATH, JSON.stringify(routePaths), (err) => {
    if (err) console.error('[route-path] cache write failed:', err.message);
  });
}

// Path building hits many small endpoints; a transient failure must not
// abort a whole route build, so retry briefly before giving up.
async function fetchWithRetry(url, asText = false, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      return await fetchWithTimeout(url, asText);
    } catch (err) {
      if (i >= tries) throw err;
      await new Promise((r) => setTimeout(r, 700 * i));
    }
  }
}

async function fetchGeometry(stops) {
  try {
    const coords = stops.map((s) => `${s.long},${s.lat}`).join(';');
    const j = await fetchWithRetry(`${OSRM_API}/${coords}?overview=full&geometries=geojson`);
    if (j.code === 'Ok' && j.routes?.[0]) {
      // GeoJSON is [lng,lat]; Leaflet wants [lat,lng].
      return { source: 'osrm', points: j.routes[0].geometry.coordinates.map(([lng, lat]) => [lat, lng]) };
    }
    throw new Error(j.code || 'no route');
  } catch (err) {
    console.error('[route-path] OSRM geometry failed, falling back to stop chain:', err.message);
    return { source: 'stops', points: stops.map((s) => [s.lat, s.long]) };
  }
}

async function buildCtbPath(route, dir) {
  const dirWord = dir === 'O' ? 'outbound' : 'inbound';
  const rs = await fetchWithRetry(`${CTB_API}/route-stop/CTB/${route}/${dirWord}`);
  const seq = rs.data || [];
  if (!seq.length) throw new Error(`no route-stop data for CTB ${route} ${dirWord}`);
  const details = await mapWithConcurrency(seq, 8, async (s) => {
    const j = await fetchWithRetry(`${CTB_API}/stop/${s.stop}`);
    return { seq: s.seq, id: s.stop, name_en: j.data.name_en, name_tc: j.data.name_tc, lat: +j.data.lat, long: +j.data.long };
  });
  const geometry = await fetchGeometry(details);
  return { network: 'CTB', route, dest_en: details[details.length - 1].name_en, stops: details, geometry };
}

async function buildGmbPath(entry) {
  const rs = await fetchWithRetry(`${GMB_API}/route-stop/${entry.route_id}/${entry.route_seq}`);
  const seq = rs.data?.route_stops || [];
  if (!seq.length) throw new Error(`no route-stop data for GMB ${entry.route_code}`);
  const details = await mapWithConcurrency(seq, 8, async (s) => {
    const j = await fetchWithRetry(`${GMB_API}/stop/${s.stop_id}`);
    const c = j.data.coordinates.wgs84;
    return { seq: s.stop_seq, id: s.stop_id, name_en: s.name_en, name_tc: s.name_tc, lat: c.latitude, long: c.longitude };
  });
  const geometry = await fetchGeometry(details);
  return {
    network: 'GMB',
    route: entry.route_code,
    dest_en: entry.dest_en || details[details.length - 1].name_en,
    stops: details,
    geometry,
  };
}

// Resolve (network, route, side) → a concrete route direction descriptor.
function resolveRouteRef(network, route, side) {
  if (network === 'CTB') {
    const pole = config.stops.find((s) => s.label === side);
    const rec = pole?.routes.find((r) => r.route === route);
    if (!rec) return null;
    return { key: `CTB|${route}|${rec.dir}`, build: () => buildCtbPath(route, rec.dir), boardingStopId: pole.id };
  }
  const candidates = GMB_ENTRIES.filter((e) => e.route_code === route && e.side === side);
  if (!candidates.length) return null;
  // A card can pool several service variants; describe the normal departure.
  const entry = candidates.find((e) => /normal/i.test(e.description_en || '')) || candidates[0];
  return {
    key: `GMB|${entry.route_id}|${entry.route_seq}`,
    build: () => buildGmbPath(entry),
    boardingStopId: entry.stop_id,
  };
}

async function getRoutePath(network, route, side) {
  const ref = resolveRouteRef(network, route, side);
  if (!ref) return null;
  if (!routePaths[ref.key]) {
    if (!routePathInflight.has(ref.key)) {
      routePathInflight.set(
        ref.key,
        ref
          .build()
          .then((payload) => {
            routePaths[ref.key] = payload;
            saveRoutePaths();
            return payload;
          })
          .finally(() => routePathInflight.delete(ref.key))
      );
    }
    await routePathInflight.get(ref.key);
  }
  const payload = routePaths[ref.key];
  const boardingIndex = payload.stops.findIndex((s) => String(s.id) === String(ref.boardingStopId));
  return { ...payload, side, boardingIndex };
}

// The monitored routes are fixed, so build every route path once at startup
// (skipping anything already in the disk cache). After the first warm-up the
// data is effectively hardcoded: /api/route-path answers instantly from
// memory, and the cache survives restarts via data/route-paths.json.
async function warmRoutePaths() {
  const pending = routesList().filter((r) => {
    const ref = resolveRouteRef(r.network, r.route, r.side);
    return ref && !routePaths[ref.key];
  });
  if (!pending.length) {
    console.log(`[route-path] all ${Object.keys(routePaths).length} route paths already cached`);
    return;
  }
  console.log(`[route-path] warming ${pending.length} route paths...`);
  for (const r of pending) {
    try {
      const p = await getRoutePath(r.network, r.route, r.side);
      console.log(
        `[route-path] warmed ${r.network} ${r.route} (${r.side}): ${p.stops.length} stops, geometry=${p.geometry.source}`
      );
    } catch (err) {
      console.error(`[route-path] warm failed for ${r.network} ${r.route} (${r.side}): ${err.message}`);
    }
    // Sequential with a pause: the free OSRM demo router rate-limits bursts.
    await new Promise((res) => setTimeout(res, 1200));
  }
  console.log(`[route-path] warm-up complete (${Object.keys(routePaths).length} cached)`);
}

// Index of every monitored route direction (for the map legend).
function routesList() {
  const list = [];
  for (const pole of config.stops) {
    const seen = new Set();
    for (const r of pole.routes) {
      if (seen.has(r.route)) continue;
      seen.add(r.route);
      list.push({ network: 'CTB', route: r.route, side: pole.label, displayLabel: pole.label, dest_en: r.dest_en });
    }
  }
  for (const card of GMB_CARDS) {
    list.push({ network: 'GMB', route: card.route, side: card.side, displayLabel: card.displayLabel, dest_en: card.dest_en });
  }
  return list.sort(
    (a, b) =>
      (a.network === b.network ? 0 : a.network === 'CTB' ? -1 : 1) ||
      a.route.localeCompare(b.route, undefined, { numeric: true }) ||
      a.side.localeCompare(b.side)
  );
}

// ---------------------------------------------------------------------------
// Weather (HKO)
// ---------------------------------------------------------------------------
let weather = null; // cached /api/weather payload

function parseHkoTime(s) {
  // "202607021948" in Hong Kong time (+08:00)
  return new Date(
    `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:00+08:00`
  );
}

async function pollCurrentWeather() {
  try {
    const j = await fetchWithTimeout(HKO_RHRREAD);
    const temps = j.temperature?.data || [];
    const station = TEMP_STATIONS.map((n) => temps.find((t) => t.place === n)).find(Boolean) || temps[0];
    const rain = (j.rainfall?.data || []).find((r) => r.place === RAIN_DISTRICT);
    weather = {
      ...(weather || {}),
      updatedAt: new Date().toISOString(),
      tempC: station ? station.value : null,
      tempStation: station ? station.place : null,
      rainNowMm: rain ? rain.max ?? rain.value ?? 0 : null,
      warnings: j.warningMessage || [],
      icon: Array.isArray(j.icon) ? j.icon[0] : j.icon,
    };
  } catch (err) {
    console.error('[weather] rhrread failed:', err.message);
    if (weather) weather.stale = true;
  }
}

async function pollNowcast() {
  try {
    const csv = await fetchWithTimeout(HKO_NOWCAST, true);
    const lines = csv.split('\n');
    // Find the grid cell nearest the stop, then collect its 4 half-hour windows.
    let bestDist = Infinity;
    let bestCell = null;
    const cells = new Map(); // "lat,long" -> [{endsAt, mm}]
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      if (parts.length < 5) continue;
      const lat = +parts[2];
      const long = +parts[3];
      const d = Math.abs(lat - NOWCAST_TARGET.lat) + Math.abs(long - NOWCAST_TARGET.long);
      if (d > 0.05) continue; // only cells near Repulse Bay
      const cellKey = `${lat},${long}`;
      if (!cells.has(cellKey)) cells.set(cellKey, []);
      cells.get(cellKey).push({ endsAt: parseHkoTime(parts[1]).toISOString(), mm: +parts[4] });
      if (d < bestDist) {
        bestDist = d;
        bestCell = cellKey;
      }
    }
    const windows = (cells.get(bestCell) || []).sort((a, b) => new Date(a.endsAt) - new Date(b.endsAt));
    // First upcoming half-hour window with meaningful rain → minutes until it starts.
    let rainInMin = null;
    for (const w of windows) {
      if (w.mm >= RAIN_MM_THRESHOLD) {
        const startsAt = new Date(w.endsAt).getTime() - 30 * 60000;
        rainInMin = Math.max(0, Math.round((startsAt - Date.now()) / 60000));
        break;
      }
    }
    weather = {
      ...(weather || {}),
      nowcastUpdatedAt: new Date().toISOString(),
      nowcastCell: bestCell,
      nowcastWindows: windows,
      rainExpectedInMin: rainInMin,
    };
  } catch (err) {
    console.error('[weather] nowcast failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

app.get('/map', (req, res) => res.sendFile(path.join(__dirname, 'public', 'map.html')));

app.get('/api/etas', (req, res) => {
  if (!snapshot) return res.status(503).json({ ok: false, error: 'First poll not completed yet' });
  res.json(snapshot);
});

app.get('/api/weather', (req, res) => {
  if (!weather) return res.status(503).json({ ok: false, error: 'Weather not fetched yet' });
  res.json(weather);
});

app.get('/api/reliability', (req, res) => res.json(reliabilityStats()));

// Full stop sequence + road geometry for one monitored route direction.
// ?network=CTB|GMB & route=6 & side=Into%20Town
app.get('/api/route-path', async (req, res) => {
  const { network, route, side } = req.query;
  if (!network || !route || !side) {
    return res.status(400).json({ ok: false, error: 'network, route and side are required' });
  }
  try {
    const payload = await getRoutePath(String(network), String(route), String(side));
    if (!payload) return res.status(404).json({ ok: false, error: 'Unknown route/side' });
    res.json(payload);
  } catch (err) {
    console.error('[route-path] failed:', err.message);
    res.status(502).json({ ok: false, error: `Could not load the route: ${err.message}` });
  }
});

// Index of all monitored route directions (map legend).
app.get('/api/routes-list', (req, res) => res.json({ routes: routesList() }));

// Static geography for the map page (from config; no upstream calls).
app.get('/api/config', (req, res) => {
  res.json({
    location: config.location,
    walkTimeMinutes: WALK_TIME_MIN,
    ctbStops: config.stops.map((s) => ({
      id: s.id,
      label: s.label,
      name_en: s.name_en,
      lat: s.lat,
      long: s.long,
      routes: [...new Set(s.routes.map((r) => r.route))],
    })),
    gmbStops: dedupeGmbStops(),
  });
});

function dedupeGmbStops() {
  const byId = new Map();
  for (const e of GMB_ENTRIES) {
    if (e.lat == null) continue;
    const rec = byId.get(e.stop_id) || {
      stop_id: e.stop_id,
      name_en: e.stop_name_en,
      lat: e.lat,
      long: e.long,
      sides: new Set(),
      routes: new Set(),
    };
    rec.routes.add(e.route_code);
    rec.sides.add(e.side);
    byId.set(e.stop_id, rec);
  }
  return [...byId.values()].map((r) => ({
    ...r,
    sides: [...r.sides],
    routes: [...r.routes],
  }));
}

app.post('/api/refresh', async (req, res) => {
  const now = Date.now();
  const since = now - Math.max(lastPollAt, lastManualAt);
  if (since < MANUAL_REFRESH_MIN_MS) {
    return res.status(429).json({
      ok: false,
      error: 'Refresh throttled to protect the upstream APIs',
      retryInMs: MANUAL_REFRESH_MIN_MS - since,
      snapshot,
    });
  }
  lastManualAt = now;
  try {
    await pollCoalesced({ manual: true });
    pollCurrentWeather();
    res.json(snapshot);
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message, snapshot });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: !!snapshot,
    lastPollAt: lastPollAt ? new Date(lastPollAt).toISOString() : null,
    pollIntervalMs: POLL_MS,
    pollCount,
    historyRecords: history.length,
    weatherUpdatedAt: weather?.updatedAt || null,
  });
});

app.listen(PORT, () => {
  console.log(`Repulse Bay Bus Monitor listening on http://localhost:${PORT}`);
  console.log(
    `Citybus poles: ${config.stops.map((s) => `${s.id} (${s.label})`).join(' + ')} | ` +
      `GMB cards: ${GMB_CARDS.map((c) => `${c.route} ${c.displayLabel}`).join(', ')} | ` +
      `poll every ${POLL_MS / 1000}s | walk time ${WALK_TIME_MIN} min`
  );
  loadHistory();
  warmRoutePaths().catch((err) => console.error('[route-path] warm-up crashed:', err.message));
  pollCoalesced().catch((err) => console.error('[poll] initial poll failed:', err.message));
  setInterval(() => pollCoalesced().catch((err) => console.error('[poll] failed:', err.message)), POLL_MS);
  pollCurrentWeather();
  setInterval(pollCurrentWeather, WEATHER_POLL_MS);
  pollNowcast();
  setInterval(pollNowcast, NOWCAST_POLL_MS);
});
