#!/usr/bin/env node
/**
 * One-time setup: resolve the two Repulse Bay Villa(s) stop poles
 * programmatically from the official Citybus open-data API and classify each
 * pole's direction of travel ("Towards Stanley" vs "Into Town") from route
 * stop sequences. No stop IDs are hardcoded.
 *
 * Method:
 *   1. Fetch the stop sequence of every monitored route (both directions).
 *   2. Keep "corridor" stops served by most of the routes, fetch their details.
 *   3. Anchor on the stop whose name matches "Repulse Bay Villa" / 淺水灣別墅.
 *      (The pole on the opposite side of the road can carry a different name —
 *      in practice it is "Repulse Bay Towers" — so it is found geometrically.)
 *   4. Classify every corridor stop's direction by looking at the terminus of
 *      each route sequence it appears in: a Stanley-area terminus means that
 *      stop serves "Towards Stanley".
 *   5. The second pole is the nearest corridor stop to the anchor that serves
 *      the OPPOSITE direction (must be within ~250m — the other side of the road).
 *
 * Writes the result to config/stops.json and prints it for verification.
 *
 * Usage: npm run resolve-stops
 */

const fs = require('fs');
const path = require('path');

const API_BASE = 'https://rt.data.gov.hk/v2/transport/citybus';
const ROUTES = ['6', '6A', '6X', '63', '65', '66', '73', '260', '973'];
const NAME_MATCHES = ['repulse bay villa', '淺水灣別墅'];
// Terminus names identifying the Stanley-bound direction of travel.
const STANLEY_PATTERN = /stanley|赤柱|chung hom kok|舂坎角/i;
// The two poles sit on opposite sides of one road: hard bound on separation.
const MAX_POLE_SEPARATION_M = 250;
// A stop must be served by at least this many of the monitored routes to count
// as part of the shared Repulse Bay corridor (keeps detail fetches bounded).
const MIN_ROUTE_COUNT = Math.ceil(ROUTES.length / 2);

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'stops.json');

async function fetchJSON(url, attempt = 1) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      return fetchJSON(url, attempt + 1);
    }
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.json();
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
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

async function main() {
  console.log('Resolving Repulse Bay Villa stop poles from the Citybus API...\n');

  // 1. Stop sequences for every monitored route, both directions.
  const sequences = []; // { route, dir, stopIds }
  for (const route of ROUTES) {
    for (const dir of ['outbound', 'inbound']) {
      const json = await fetchJSON(`${API_BASE}/route-stop/CTB/${route}/${dir}`);
      const stopIds = (json.data || []).map((s) => s.stop);
      if (stopIds.length > 0) sequences.push({ route, dir, stopIds });
      console.log(`  route-stop ${route} ${dir}: ${stopIds.length} stops`);
    }
  }
  if (sequences.length === 0) throw new Error('No route-stop data returned by API.');

  // 2. Corridor stops: served by at least MIN_ROUTE_COUNT of the routes.
  const perRouteStopSets = new Map();
  for (const { route, stopIds } of sequences) {
    const set = perRouteStopSets.get(route) || new Set();
    stopIds.forEach((id) => set.add(id));
    perRouteStopSets.set(route, set);
  }
  const routeSets = [...perRouteStopSets.values()];
  const allStopIds = [...new Set(routeSets.flatMap((s) => [...s]))];
  const corridorIds = allStopIds.filter(
    (id) => routeSets.filter((s) => s.has(id)).length >= MIN_ROUTE_COUNT
  );
  console.log(`\nCorridor stops served by >=${MIN_ROUTE_COUNT} routes: ${corridorIds.length}`);

  const corridor = await mapWithConcurrency(corridorIds, 8, (id) =>
    fetchJSON(`${API_BASE}/stop/${id}`).then((j) => j.data)
  );

  // 3. Anchor pole: name match for Repulse Bay Villa(s).
  const anchors = corridor.filter((s) => {
    const en = (s.name_en || '').toLowerCase();
    const tc = s.name_tc || '';
    return NAME_MATCHES.some((m) => en.includes(m) || tc.includes(m));
  });
  if (anchors.length === 0) {
    console.log('\nCorridor stop names for debugging:');
    corridor.forEach((s) => console.log(`  ${s.stop}  ${s.name_en} / ${s.name_tc}`));
    throw new Error('No corridor stop name matched "Repulse Bay Villa" / 淺水灣別墅.');
  }
  const anchor = anchors[0];
  console.log(`\nAnchor pole (name match): ${anchor.stop}  ${anchor.name_en} / ${anchor.name_tc}`);
  if (anchors.length > 1) {
    console.log(`  (note: ${anchors.length} name matches; using the first, others: ${anchors
      .slice(1).map((s) => s.stop).join(', ')})`);
  }

  // 4. Classify every corridor stop's direction via route-sequence termini.
  const terminusCache = new Map();
  async function stopDetails(stopId) {
    const cached = corridor.find((s) => s.stop === stopId);
    if (cached) return cached;
    if (!terminusCache.has(stopId)) {
      const j = await fetchJSON(`${API_BASE}/stop/${stopId}`);
      terminusCache.set(stopId, j.data);
    }
    return terminusCache.get(stopId);
  }

  const info = new Map(
    corridor.map((s) => [s.stop, { stanleyVotes: 0, townVotes: 0, routes: [] }])
  );
  for (const { route, dir, stopIds } of sequences) {
    const terminus = await stopDetails(stopIds[stopIds.length - 1]);
    const towardsStanley = STANLEY_PATTERN.test(`${terminus.name_en} ${terminus.name_tc}`);
    for (const s of corridor) {
      if (!stopIds.includes(s.stop)) continue;
      const rec = info.get(s.stop);
      if (towardsStanley) rec.stanleyVotes++;
      else rec.townVotes++;
      rec.routes.push({
        route,
        dir: dir === 'outbound' ? 'O' : 'I',
        dest_en: terminus.name_en,
        dest_tc: terminus.name_tc,
      });
    }
  }
  const labelOf = (id) => {
    const rec = info.get(id);
    if (rec.stanleyVotes === rec.townVotes) return null; // ambiguous
    return rec.stanleyVotes > rec.townVotes ? 'Towards Stanley' : 'Into Town';
  };

  const anchorLabel = labelOf(anchor.stop);
  if (!anchorLabel) throw new Error(`Direction of anchor pole ${anchor.stop} is ambiguous.`);
  console.log(`Anchor pole direction: ${anchorLabel}`);

  // 5. Opposite pole: nearest corridor stop with the opposite direction label.
  const oppositeLabel = anchorLabel === 'Towards Stanley' ? 'Into Town' : 'Towards Stanley';
  const opposites = corridor
    .filter((s) => s.stop !== anchor.stop && labelOf(s.stop) === oppositeLabel)
    .map((s) => ({
      s,
      d: haversineMeters(+anchor.lat, +anchor.long, +s.lat, +s.long),
    }))
    .sort((a, b) => a.d - b.d);
  if (opposites.length === 0) {
    throw new Error(`No corridor stop found serving the opposite direction (${oppositeLabel}).`);
  }
  const opposite = opposites[0];
  console.log(
    `Opposite pole: ${opposite.s.stop}  ${opposite.s.name_en} / ${opposite.s.name_tc}  ` +
      `(${opposite.d.toFixed(0)}m from anchor)`
  );
  if (opposite.d > MAX_POLE_SEPARATION_M) {
    throw new Error(
      `Nearest opposite-direction stop is ${opposite.d.toFixed(0)}m away ` +
        `(> ${MAX_POLE_SEPARATION_M}m) — not the other side of the same road.`
    );
  }

  // 6. Write config.
  const toEntry = (s, label) => {
    const rec = info.get(s.stop);
    return {
      id: s.stop,
      name_en: s.name_en,
      name_tc: s.name_tc,
      lat: +s.lat,
      long: +s.long,
      label,
      routes: rec.routes,
    };
  };
  // Merge into any existing config: preserve the GMB section (written by
  // discover-gmb-routes.js) and the user-tunable walk time.
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    /* first run */
  }
  const config = {
    ...existing,
    location:
      'Repulse Bay Road, outside Repulse Bay Villa (opp. 9 South Bay Road), Hong Kong',
    company: 'CTB',
    routes: ROUTES,
    walkTimeMinutes: existing.walkTimeMinutes ?? 5,
    generatedAt: new Date().toISOString(),
    stops: [toEntry(anchor, anchorLabel), toEntry(opposite.s, oppositeLabel)],
  };

  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');

  console.log('\n=== RESOLVED STOPS (verify these) ===');
  for (const s of config.stops) {
    console.log(
      `  ${s.label.padEnd(15)} stop ${s.id}  ${s.name_en}  (${s.lat}, ${s.long})\n` +
        `                  routes: ${s.routes.map((r) => `${r.route}→${r.dest_en}`).join(' | ')}`
    );
  }
  console.log(`\nWritten to ${CONFIG_PATH}`);
}

main().catch((err) => {
  console.error('\nresolve-stops failed:', err.message);
  process.exit(1);
});
