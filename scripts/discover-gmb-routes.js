#!/usr/bin/env node
/**
 * One-time setup: discover which Green Minibus (GMB) routes serve the
 * Repulse Bay Road corridor at/near the Repulse Bay Villa stop pair, using
 * the Transport Department's official GMB open-data API (data.etagmb.gov.hk).
 *
 * Nothing is hardcoded: the script iterates EVERY Hong Kong Island GMB route,
 * fetches each direction's stop list, and keeps directions whose stop names
 * match the corridor keywords below. For each kept direction it records the
 * best (closest-to-our-location) matching stop's route_id / route_seq /
 * stop_seq — the triple needed for ETA queries — and merges the result into
 * config/stops.json under the "gmb" key (preserving the Citybus section).
 *
 * Re-run this any time the Transport Department adds or changes routes:
 *   npm run discover-gmb-routes
 *
 * Direction labels: GMB termini do not always fit the Citybus
 * "Into Town"/"Towards Stanley" binary (e.g. route 52 runs to Aberdeen, which
 * is neither). The physical SIDE of the road ("side" field) is still binary —
 * a minibus heading away from Stanley uses the same pole side as buses to
 * Central — but the human label ("displayLabel") is derived from the actual
 * terminus and falls back to "Towards <terminus>" when it maps to neither
 * town nor Stanley, rather than mislabeling it.
 */

const fs = require('fs');
const path = require('path');

const API_BASE = 'https://data.etagmb.gov.hk';
const REGION = 'HKI';

// Corridor stop-name keywords, ordered by proximity to our location
// (Repulse Bay Road opposite 9 South Bay Road). Lower index = closer = better.
const KEYWORDS = [
  { en: 'south bay road', tc: '南灣道' },
  { en: 'repulse bay villa', tc: '淺水灣別墅' },
  { en: 'repulse bay beach', tc: '淺水灣海灘' },
  { en: 'belleview drive', tc: '麗景道' },
];

const STANLEY_PATTERN = /stanley|赤柱|chung hom kok|舂坎角|舂磡角/i;
// "Jardine's Bazaar" is the Causeway Bay terminus of routes 40/40X/N40 — town.
const TOWN_PATTERN =
  /central|admiralty|wan chai|causeway|tin hau|north point|exchange square|jardine|中環|金鐘|灣仔|銅鑼灣|天后|北角|渣甸/i;

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'stops.json');
const DEFAULT_WALK_TIME_MIN = 5;

async function fetchJSON(url, attempt = 1) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 800 * attempt));
      return fetchJSON(url, attempt + 1);
    }
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.json();
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

function matchKeyword(stop) {
  const en = (stop.name_en || '').toLowerCase();
  const tc = stop.name_tc || '';
  for (let i = 0; i < KEYWORDS.length; i++) {
    if (en.includes(KEYWORDS[i].en) || tc.includes(KEYWORDS[i].tc)) return i;
  }
  return -1;
}

function titleCase(s) {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(^|[\s(])\w/g, (c) => c.toUpperCase());
}

function classify(destEn, destTc) {
  const hay = `${destEn} ${destTc}`;
  if (STANLEY_PATTERN.test(hay)) {
    return { side: 'Towards Stanley', displayLabel: 'Towards Stanley' };
  }
  // Everything not Stanley-bound physically departs from the town-side pole
  // area of the road, so the column ("side") is binary even when the label
  // is not.
  if (TOWN_PATTERN.test(hay)) {
    return { side: 'Into Town', displayLabel: 'Into Town' };
  }
  // Terminus maps to neither (e.g. Aberdeen): keep an honest plain label.
  const short = titleCase(destEn.split('(')[0]);
  return { side: 'Into Town', displayLabel: `Towards ${short}` };
}

async function main() {
  console.log(`Discovering GMB routes on the Repulse Bay corridor (region ${REGION})...\n`);

  const routeList = await fetchJSON(`${API_BASE}/route/${REGION}`);
  const routeCodes = routeList.data.routes;
  console.log(`${routeCodes.length} ${REGION} GMB route codes to scan.`);

  // Every route code can have multiple service variants (route_id), each with
  // 1-2 directions (route_seq).
  const directionsToScan = [];
  await mapWithConcurrency(routeCodes, 8, async (code) => {
    const detail = await fetchJSON(`${API_BASE}/route/${REGION}/${encodeURIComponent(code)}`);
    for (const variant of detail.data) {
      for (const dir of variant.directions) {
        directionsToScan.push({
          route_code: code,
          route_id: variant.route_id,
          description_en: variant.description_en,
          route_seq: dir.route_seq,
          orig_en: dir.orig_en?.trim(),
          dest_en: dir.dest_en?.trim(),
          dest_tc: dir.dest_tc?.trim(),
        });
      }
    }
  });
  console.log(`${directionsToScan.length} route directions to scan for corridor stops.\n`);

  const hits = [];
  await mapWithConcurrency(directionsToScan, 8, async (d) => {
    const rs = await fetchJSON(`${API_BASE}/route-stop/${d.route_id}/${d.route_seq}`);
    const stops = rs.data.route_stops || [];
    let best = null;
    for (const s of stops) {
      const rank = matchKeyword(s);
      if (rank >= 0 && (!best || rank < best.rank)) best = { rank, stop: s };
    }
    if (best) hits.push({ ...d, matchRank: best.rank, stop: best.stop });
  });

  if (hits.length === 0) {
    throw new Error('No GMB route direction stops on the Repulse Bay corridor — check KEYWORDS.');
  }

  // Fetch coordinates for each matched stop (deduped).
  const stopIds = [...new Set(hits.map((h) => h.stop.stop_id))];
  const coordMap = new Map();
  await mapWithConcurrency(stopIds, 8, async (id) => {
    const j = await fetchJSON(`${API_BASE}/stop/${id}`);
    coordMap.set(id, j.data.coordinates.wgs84);
  });

  const entries = hits
    .map((h) => {
      const { side, displayLabel } = classify(h.dest_en || '', h.dest_tc || '');
      const coords = coordMap.get(h.stop.stop_id) || {};
      return {
        route_code: h.route_code,
        route_id: h.route_id,
        route_seq: h.route_seq,
        description_en: h.description_en,
        stop_seq: h.stop.stop_seq,
        stop_id: h.stop.stop_id,
        stop_name_en: h.stop.name_en,
        stop_name_tc: h.stop.name_tc,
        lat: coords.latitude ?? null,
        long: coords.longitude ?? null,
        orig_en: h.orig_en,
        dest_en: h.dest_en,
        dest_tc: h.dest_tc,
        side,
        displayLabel,
        matchedKeyword: KEYWORDS[h.matchRank].en,
      };
    })
    .sort(
      (a, b) =>
        a.route_code.localeCompare(b.route_code, undefined, { numeric: true }) ||
        a.route_seq - b.route_seq
    );

  console.log('=== DISCOVERED GMB ROUTE DIRECTIONS (verify these) ===');
  for (const e of entries) {
    console.log(
      `  ${e.route_code.padEnd(4)} route_id ${e.route_id} seq ${e.route_seq}  ` +
        `${(e.orig_en || '?')} → ${(e.dest_en || '?')}\n` +
        `       side: ${e.side.padEnd(15)} label: ${e.displayLabel.padEnd(18)} ` +
        `stop_seq ${e.stop_seq} (${e.stop_name_en}) [matched: ${e.matchedKeyword}]`
    );
  }

  // Merge into config/stops.json, preserving the Citybus section.
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    console.log('\n(config/stops.json not found yet — writing GMB section only; ' +
      'run "npm run resolve-stops" for the Citybus section.)');
  }
  config.walkTimeMinutes = config.walkTimeMinutes ?? DEFAULT_WALK_TIME_MIN;
  config.gmb = {
    generatedAt: new Date().toISOString(),
    region: REGION,
    keywords: KEYWORDS.map((k) => k.en),
    entries,
  };
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  console.log(`\n${entries.length} GMB route directions written to ${CONFIG_PATH} (gmb section).`);
}

main().catch((err) => {
  console.error('\ndiscover-gmb-routes failed:', err.message);
  process.exit(1);
});
