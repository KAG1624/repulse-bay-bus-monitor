# repulse-bay-bus-monitor — Shared Coding Guidance

This file provides guidance to coding agents when working with code in this repository.

Scope: `/opt/repulse-bay-bus-monitor` and its children, except any explicitly narrower coding scope.

## Shared Coding Workflow

This is the personal VPS `Personal_VPS-ale` (`srv1596163`), not the company VPS.
Use the personal working agreements loaded through `/home/ale/.codex/AGENTS.md` or
`/home/ale/.claude/CLAUDE.md`; the maintained user source is
`/home/ale/.config/agent-guidance/AGENTS.md`. The master procedure and rollout record live
in `/opt/hive/docs/AGENT_GUIDANCE_STANDARD.md` and `/opt/hive/docs/AGENT_GUIDANCE_ROLLOUT_2026-10-04.md`.
A Mac-hosted SSH chat must explicitly read these remote instructions before work.

Maintain AGENTS.md as the shared coding source. Same-directory CLAUDE.md is a real file
containing exactly `@./AGENTS.md` plus one newline. Preserve actual application provider
names and runtime decisions. Historical approvals and dated handoffs are not current
permission to run production operations. Read the current applicable handoff before edits.

Inspect branch, HEAD, staging and worktrees. Reread targets and compare hashes before writes;
reconcile changed content. Never stash, reset, restore, clean, switch branches, kill another
session, amend another person's commit, force-push, or stage someone else's files. Use named
paths only, never broad staging. Recheck HEAD, index and locks at commit time; inspect hooks
and deployment triggers before pushing. Preserve existing file ownership and credentials.
Worktree owners adopt guidance through Git; never overwrite their checkout copies.

Validate changed coding scopes with `/opt/hive/scripts/check_agent_guidance.py`.
Guidance checks need no build, deployment, restart, live database write, live-agent call,
message, credential refresh or backup run. Use action-disabled fresh sessions for loading
checks and name unavailable authentication/access checks honestly. Shared files do not
transfer private chat history, tool-specific skills or permissions between coding agents.

## Preserved Project Instructions

# AGENTS.md — Repulse Bay Bus Monitor

## Overview

A real-time transit dashboard for the two-sided bus stop on Repulse Bay Road
outside the villa. Built as a wall display: dark, high-contrast, large type,
two mirrored columns matching the two physical sides of the road.

Monitors both networks serving the stop: **Citybus** (routes 6, 6A, 6X, 63, 65,
66, 73, 260, 973 via `rt.data.gov.hk`) and **Green Minibus** (40, 40X, 52, N40
via `data.etagmb.gov.hk`), interleaved purely by arrival time. Plus a Hong Kong
Observatory weather strip, a walk-time "can I make it?" buffer, on-time history,
and a routes map at `/map`.

- **Stack:** Node ≥ 18 (built-in `fetch`), Express, vanilla JS frontend, Leaflet
  for the map. No database — JSONL and JSON files on disk.
- **Live at:** https://bus.bee-inc.ai via its own Cloudflare Tunnel
  (`cloudflared-busmonitor.service`, `/etc/cloudflared-busmonitor/config.yml`).
- **Runs in Docker**, not systemd: container `repulse-bay-bus-monitor` from
  `docker-compose.yml`, bound `127.0.0.1:3000`, capped at 0.5 CPU / 512MB.

`README.md` is thorough on behaviour and data sources — read it too.

## Setup / build / test

No test suite. Node dependencies are just `express` + `dotenv`.

```bash
npm install
npm run resolve-stops         # one-time: resolve the two Citybus stop poles
npm run discover-gmb-routes   # one-time: discover GMB routes on the corridor
npm start                     # dashboard on http://localhost:3000
```

**Deploying a change means rebuilding the image** — editing `server.js` on disk
does nothing until then:

```bash
sudo docker compose up -d --build
sudo docker logs -f repulse-bay-bus-monitor
```

`config/` and `data/` are bind-mounted, so changes to those take effect without
a rebuild.

## Directory structure

```
server.js         polling loops (ETAs, weather, nowcast), all /api endpoints,
                  departure-history logging, static file serving
public/
  index.html      the wall dashboard
  app.js          dashboard rendering + countdowns
  map.html/map.js Leaflet routes map
  style.css
config/stops.json the two resolved stop poles + walkTimeMinutes (bind-mounted;
                  tune walking time here, no rebuild needed)
scripts/
  resolve-stops.js        one-time Citybus stop-pole resolution
  discover-gmb-routes.js  one-time GMB route discovery
data/             history.jsonl + route-paths.json cache (gitignored,
                  bind-mounted, survives rebuilds)
Dockerfile, docker-compose.yml
```

Endpoints: `/api/etas`, `/api/weather`, `/api/reliability`, `/api/route-path`,
`/api/routes-list`, `/api/config`, `/api/health`, and `/map`.

## Constraints — do not break these

- **Never poll upstream faster than 45s.** Both ETA feeds refresh roughly every
  60s; `MIN_POLL_MS` clamps this and the clamp is not decoration. These are free
  public APIs and hammering them is how access gets withdrawn. The nowcast is a
  2.7MB gridded CSV — its 10-minute interval is deliberately slow.
- **Polling is server-side and open-tab-independent.** One loop serves all
  clients; do not move fetching into the browser or scale it per viewer.
- **No paid APIs, no scraping, no mock data.** This is a stated project rule.
  If a feed is unreachable, degrade visibly — never synthesise a plausible
  number.
- **Never draw bus positions.** Citybus and GMB publish arrival *predictions*,
  not vehicle GPS. The map shows routes and stops only. Faking a moving bus from
  an ETA would be inventing data.
- **`data/history.jsonl` is append-only and irreplaceable** — it is the entire
  basis of `/api/reliability` and cannot be backfilled from any upstream source.
  Never rewrite or truncate it. It is bind-mounted so it survives rebuilds; keep
  it that way.
- **`data/route-paths.json` is an OSRM cache**, fetched once per route from a
  free router. Do not clear it casually, and keep the stop-to-stop line fallback
  working for when OSRM is unreachable.
- The dashboard is a wall display read at a distance. Do not reduce type sizes
  or contrast for aesthetic reasons.

## Code style

- CommonJS (`require`), not ESM.
- `server.js` is sectioned by `// ---- Name ----` banner comments, with a
  file-header docstring explaining the polling model. Follow that.
- Tunables are `const`s at the top of `server.js` with a comment saying *why*
  that value (see `MIN_POLL_MS`, `NOWCAST_POLL_MS`). Add new ones the same way.
- Frontend is vanilla JS — no framework, no bundler, no build step.

## Session Handoff

Read **[SESSION_HANDOFF.md](SESSION_HANDOFF.md)** at the start of a session and
update it at the end: current state, what changed, open tasks, known issues,
key files touched.
