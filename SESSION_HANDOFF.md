# Coding Guidance Handoff — 4 October 2026

Shared coding instructions now use maintained AGENTS.md and the exact real CLAUDE.md
import bridge. Original project instructions and the prior handoff below are preserved.
This was guidance-only work; no application, deployment, data or runtime changes.
Read `/opt/hive/docs/AGENT_GUIDANCE_ROLLOUT_2026-10-04.md` for verification, publication
and pending Claude login/session adoption. Historical instructions below retain their dates.

# SESSION HANDOFF — Repulse Bay Bus Monitor

Running log. Agents append to / update this at the end of every session.
Newest session first.

---

## Last Updated

**2026-07-26**

## Current State

Live and healthy at https://bus.bee-inc.ai. Docker container
`repulse-bay-bus-monitor` up since 2026-07-02 (3+ weeks), bound
`127.0.0.1:3000`, fronted by its own Cloudflare Tunnel
(`cloudflared-busmonitor.service`).

Last commit 2026-07-02, authored as `VPS Backup <vps-busmonitor@local>`.

**There is one uncommitted change in `server.js`, and it IS live.** It adds
`app.disable('x-powered-by')` plus `X-Content-Type-Options: nosniff` and
`X-Frame-Options: DENY` response headers. Verified serving on the running
container (`curl -sI http://127.0.0.1:3000/` returns both headers), and the
image was built 14 minutes after the file was last edited — so the change was
built in and is in production, it simply was never committed. This session did
**not** commit it: it predates this session and is not this session's work to
claim.

## What Changed This Session

Documentation only. No application code, config or data was touched.

- Added `AGENTS.md` (+ `CLAUDE.md` / `GEMINI.md` symlinks) so Claude Code,
  Codex and Gemini CLI read one source of truth.
- Added this file.

The AGENTS.md leads on the two things most likely to be broken by a
well-meaning edit: the 45s minimum poll interval on free public APIs, and that
**editing `server.js` does nothing until the Docker image is rebuilt** — the
deploy step here is `docker compose up -d --build`, not a service restart, which
is different from every other project on this VPS.

## Open Tasks / Next Steps

- **Commit the security-headers change in `server.js`.** It is live in the
  running container but absent from git, so the repo does not describe
  production and an unattended `git checkout` would quietly remove headers that
  are currently being served.
- **Reconsider the commit identity.** History is authored by `VPS Backup
  <vps-busmonitor@local>`, which makes changes hard to attribute. The sibling
  repos on this VPS commit as `Alessandro Bisagni <a.bisagni@bee-inc.com>`.
- **No tests.** The highest-value first test would assert the poll-interval
  clamp (`MIN_POLL_MS`), since that is the constraint whose breach has an
  external consequence — losing access to a free public API — and it is a pure
  function of an env var.

## Known Issues / Blockers

- **No test suite**; changes are verified by rebuilding and watching the live
  dashboard.
- **Deploy requires an image rebuild.** Easy to forget: a `server.js` edit looks
  applied on disk but the container keeps running the old code. That gap is
  exactly how the security-headers change ended up live-but-uncommitted with no
  obvious signal either way.
- **Container has been up 3+ weeks without a rebuild**, so the image is pinned to
  whatever `npm install` resolved on 2026-07-02. `package-lock.json` is
  committed, so a rebuild is reproducible.
- **Depends entirely on free third-party feeds** (Citybus, GMB, HKO, OSRM,
  CARTO/OSM tiles) with no fallback and no SLA. Any of them can change shape or
  withdraw access; the app is designed to degrade visibly rather than invent
  data, and that must stay true.
- **`data/history.jsonl` is irreplaceable** — the only record behind
  `/api/reliability`, not reconstructable from upstream, and nothing backs it up.
- The frontend `/api/config` exposes stop configuration publicly; it is behind
  Cloudflare Access on the tunnel, so do not expose port 3000 directly.

## Key Files Touched

| File | Why |
|---|---|
| `AGENTS.md` | **new** — agent guide (+ `CLAUDE.md`/`GEMINI.md` symlinks) |
| `SESSION_HANDOFF.md` | **new** — this file |

`server.js` shows as modified, but **not by this session** — see Current State.
