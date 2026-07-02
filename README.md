# Repulse Bay Bus Monitor

A real-time transit dashboard for the two-sided bus stop on Repulse Bay Road
outside Repulse Bay Villa (opposite 9 South Bay Road), Hong Kong. Designed as
a wall display: dark, high-contrast, large type, two mirrored columns that map
to the two physical sides of the road, in plain language anyone in the family
can read at a glance.

It monitors **both networks that serve this stop**:

- **Citybus** routes 6, 6A, 6X, 63, 65, 66, 73, 260, 973
  (official real-time API, rt.data.gov.hk)
- **Green Minibus (GMB)** routes 40, 40X, 52, N40 — discovered automatically,
  see below (official Transport Department API, data.etagmb.gov.hk)

Buses and minibuses are **interleaved purely by arrival time** in each
direction column and distinguished by styling: minibuses get a pill-shaped
badge with a green ring and a "MINIBUS" chip, city buses a rounded-square
badge with a "CITY BUS" chip.

Also on board:

- **Weather strip** (Hong Kong Observatory open data): current temperature at
  the Stanley station, rain-now status, "Rain in ~X min" from HKO's gridded
  2-hour rainfall nowcast for the Repulse Bay grid cell, plus any active
  warnings (typhoon signals etc.).
- **Walk-time buffer**: every arrival carries a chip answering "can I make
  it?" — "🚶 Leave now", "🚶 Leave within X min", or "Too late to walk — catch
  the next one" (the missed arrival's number is also dimmed). Tune the walking
  minutes in `config/stops.json` → `walkTimeMinutes`.
- **On-time history**: the server logs every tracked vehicle's first
  prediction vs its observed arrival (approximated as the moment its countdown
  hits zero and it leaves the feed) to `data/history.jsonl`, and a footer
  panel shows per-route averages over the last 7 days.
- **Route details on tap**: every card on the dashboard opens a popup with
  the remaining stops from this stop to the terminus (for that direction),
  that route's own on-time history, and a link to the map with the route
  pre-drawn.
- **Routes map** at `/map` (Leaflet + free CARTO/OSM tiles): an index of all
  monitored bus and minibus route directions — pick one and its full path is
  drawn along the actual roads with every stop from start to finish (road
  geometry via the free OSRM router, fetched once per route and cached in
  `data/route-paths.json`; falls back to stop-to-stop lines if OSRM is
  unreachable). The two home poles stay pinned with live-countdown popups.
  The Citybus and GMB open APIs only publish arrival predictions, not
  vehicle GPS, so the map shows routes and stops — never faked bus positions.

No paid APIs, no scraping, no mock data anywhere.

## Setup

Requires Node.js ≥ 18 (uses the built-in `fetch`).

```bash
npm install
npm run resolve-stops        # one-time: resolve the two Citybus stop poles
npm run discover-gmb-routes  # one-time: discover GMB routes serving the corridor
npm start                    # dashboard on http://localhost:3000
```

Configuration via `.env` (see `.env.example`): `PORT` (default 3000) and
`POLL_INTERVAL_MS` (default 60000, clamped to ≥ 45000).

### What the two setup scripts do (nothing is hardcoded)

**`npm run resolve-stops`** queries the Citybus API, finds the stop named
*Repulse Bay Villa(s) / 淺水灣別墅* on the corridor shared by all monitored
routes, geometrically locates the pole on the opposite side of the road (it
carries a different name — *Repulse Bay Towers*), classifies each pole's
direction ("Towards Stanley" / "Into Town") from route stop-sequence termini,
and writes `config/stops.json`. Verify the printed IDs on first run.

**`npm run discover-gmb-routes`** iterates **every** Hong Kong Island GMB
route in the Transport Department API, fetches each direction's stop list,
and keeps the ones whose stops match the corridor keywords ("South Bay Road",
"Repulse Bay Villa", "Repulse Bay Beach", "Belleview Drive" and their Chinese
equivalents), recording the exact `route_id`/`route_seq`/`stop_seq` triples
needed for ETA queries. It also derives a plain direction label per route
direction: GMB termini don't always fit the Into-Town/Stanley binary — route
52 runs to **Aberdeen**, so its cards say "Towards Aberdeen" instead of being
forced into a wrong label (it still lives in the town-side column, because
that's the physical side of the road it departs from). Re-run this any time
the Transport Department adds or changes routes; it merges into
`config/stops.json` without touching the Citybus section.

## Verifying the data is genuinely live

**1. Server logs.** On startup the server prints every raw upstream response
(`[raw ctb] …` and `[raw gmb] …`), then a compact per-poll line:

```
[poll #1] … Towards Stanley [6:20:21:00 … m40:20:24:34 m52:20:22:08 …]
[poll #2] … Towards Stanley [6:20:20:47 … m40:20:24:21 m52:20:21:40 …]
```

(`m`-prefixed = minibus.) Values drift between polls; when a vehicle departs
its ETA drops off and the next takes its place.

**2. Curl either upstream twice, a minute apart:**

```bash
# Citybus (stop IDs are in config/stops.json; 002257 = Into Town pole)
curl -s https://rt.data.gov.hk/v2/transport/citybus/eta/CTB/002257/6 | python3 -m json.tool
sleep 60
curl -s https://rt.data.gov.hk/v2/transport/citybus/eta/CTB/002257/6 | python3 -m json.tool

# GMB (route_id/route_seq/stop_seq from config/stops.json "gmb" section)
curl -s https://data.etagmb.gov.hk/eta/route-stop/2005220/1/11 | python3 -m json.tool
```

Compare `eta` / `timestamp` / `data_timestamp` fields between calls — they
move. Both feeds refresh roughly every 60s, so calls a few seconds apart may
legitimately match.

**3. The dashboard** shows a "synced Xs ago" counter, a progress bar filling
across each poll cycle, and a pulsing live dot (the only looping animation on
the page — cards never blink and are only touched when a value actually
changes). If a feed stops responding or goes stale, an explicit "no live
data" banner/state appears; stale numbers are never shown silently.

## Reusing this elsewhere

1. `config/stops.json` → `walkTimeMinutes`: minutes from your door to the
   stop (used by the leave-now chips). Takes effect on server restart.
2. Citybus side: edit `ROUTES`, `NAME_MATCHES`, `STANLEY_PATTERN` in
   `scripts/resolve-stops.js`; the two column labels live there and in
   `public/index.html` / `els.cols` in `public/app.js`.
3. GMB side: edit `REGION` (`HKI`/`KLN`/`NT`), `KEYWORDS`, and the
   `STANLEY_PATTERN`/`TOWN_PATTERN` classifiers in
   `scripts/discover-gmb-routes.js`.
4. Weather: `TEMP_STATIONS`, `RAIN_DISTRICT`, and `NOWCAST_TARGET`
   (lat/long) at the top of `server.js`.
5. Map: `CENTER` / `MAX_BOUNDS` in `public/map.js`.
6. Delete `config/stops.json`, re-run both setup scripts, verify the printed
   output, `npm start`.

## Project structure

```
server.js                       Express server: CTB+GMB polling, cache, weather,
                                history log, /api/* endpoints
config/stops.json               Auto-generated (Citybus poles + GMB triples +
                                walkTimeMinutes — the only hand-tunable field)
scripts/resolve-stops.js        Citybus stop-pole resolution + direction labels
scripts/discover-gmb-routes.js  GMB corridor-route discovery + direction labels
public/index.html|style.css|app.js   Dashboard (diff-based rendering, no blinking)
public/map.html|map.js          Stop map page (Leaflet, /map)
data/history.jsonl              Departure history log (auto-created, gitignored)
```

### API endpoints

- `GET /api/etas` — cached combined CTB+GMB snapshot
- `GET /api/weather` — cached HKO conditions + rain nowcast
- `GET /api/reliability` — per-route on-time stats (7-day window)
- `GET /api/route-path?network=&route=&side=` — full stop sequence +
  road-following geometry for one route direction (disk-cached)
- `GET /api/routes-list` — index of all monitored route directions
- `GET /api/config` — stop geography for the map page
- `POST /api/refresh` — force a poll (throttled to 30s)
- `GET /api/health` — poll/history/weather status

## Hosting notes

Environment-agnostic: relative asset paths and API fetches (works behind a
subpath reverse proxy), port from `$PORT`. Outbound dependencies:
`rt.data.gov.hk`, `data.etagmb.gov.hk`, `data.weather.gov.hk`, and
`router.project-osrm.org` (once per route, then disk-cached); the browser
loads Leaflet from unpkg and map tiles from CARTO on the `/map` page only.
`data/` must be writable for the history log and route-geometry cache.

## Data attribution

Bus data: Citybus Limited · Minibus data: Transport Department · Weather:
Hong Kong Observatory — all via [DATA.GOV.HK](https://data.gov.hk).
Map tiles: © OpenStreetMap contributors, © CARTO.
