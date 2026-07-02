/* Repulse Bay Bus Monitor — dashboard client.
 *
 * Rendering is strictly diff-based: every card element is created once and
 * kept; on each update only the text nodes whose values actually changed are
 * touched, and a one-shot 350ms fade is applied to a changed number. Cards
 * are only re-ordered (with a FLIP transform) when the sort order really
 * changed. Nothing on a card blinks or loops — the only repeating "live"
 * indicator is the header dot + "synced Xs ago" text.
 */

const CLIENT_POLL_MS = 20000; // server caches upstream; this is cheap
const WEATHER_POLL_MS = 60000;
const RESYNC_MS = 5000; // re-diff countdowns (no-op unless a minute boundary passed)
const STALE_FACTOR = 3;
// "Leave now" window: bus arrives within walk time + this many minutes.
const LEAVE_NOW_SLACK_MIN = 3;

// Pastel, harmonized route palette: city buses in warm/cool muted tones,
// minibuses kept inside one soft green family.
const ROUTE_COLORS = {
  '6': '#e2c491',
  '6A': '#dcaa9f',
  '6X': '#d59aa8',
  '63': '#9dc6c0',
  '65': '#b3c9a1',
  '66': '#bfaedd',
  '73': '#9db8dc',
  '260': '#dfb29b',
  '973': '#d3aec9',
  '40': '#aed3b5',
  '40X': '#9dc8b6',
  '52': '#b9d3a8',
  'N40': '#93b9a7',
};

const els = {
  liveDot: document.getElementById('liveDot'),
  syncText: document.getElementById('syncText'),
  refreshBtn: document.getElementById('refreshBtn'),
  pollBar: document.getElementById('pollBar'),
  banner: document.getElementById('banner'),
  weatherMain: document.getElementById('weatherMain'),
  weatherWarn: document.getElementById('weatherWarn'),
  walkHint: document.getElementById('walkHint'),
  reliabilityToggle: document.getElementById('reliabilityToggle'),
  reliabilityPanel: document.getElementById('reliabilityPanel'),
  reliabilityTable: document.getElementById('reliabilityTable'),
  cols: {
    'Towards Stanley': {
      cards: document.getElementById('cards-stanley'),
      sub: document.getElementById('sub-stanley'),
    },
    'Into Town': {
      cards: document.getElementById('cards-town'),
      sub: document.getElementById('sub-town'),
    },
  },
};

let snapshot = null;
let walkTime = 5;
const cards = new Map(); // key -> {el, refs, last:{...}, container}
const colOrder = new Map(); // container element -> [keys] currently in DOM order

function routeColor(route) {
  if (ROUTE_COLORS[route]) return ROUTE_COLORS[route];
  let h = 0;
  for (const c of route) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 30% 72%)`; // pastel fallback for unknown routes
}

const minutesUntil = (iso) => (new Date(iso).getTime() - Date.now()) / 60000;
const etaClass = (m) => (m < 3 ? 'eta-red' : m <= 8 ? 'eta-amber' : 'eta-green');

function fmtAgo(seconds) {
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))}s ago`;
  return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s ago`;
}

// ── Card creation ──────────────────────────────────────────────────────────

function buildCard(key, item, columnLabel) {
  const el = document.createElement('article');
  el.className = `card entering${item.network === 'GMB' ? ' gmb' : ''}`;
  el.dataset.key = key;
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', `Route ${item.route} — show remaining stops`);
  el.addEventListener('click', () => openRouteModal(item.network, item.route, columnLabel));
  el.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      openRouteModal(item.network, item.route, columnLabel);
    }
  });
  el.innerHTML = `
    <div class="badge-wrap">
      <div class="route-badge" style="background:${routeColor(item.route)}">${item.route}</div>
      <span class="vehicle-chip">${item.network === 'GMB' ? 'Minibus' : 'City Bus'}</span>
    </div>
    <div class="card-mid">
      <div class="card-dir hidden"></div>
      <div class="card-dest"></div>
      <div class="card-next"></div>
      <div class="card-rmk hidden"></div>
      <span class="walk-chip hidden"></span>
    </div>
    <div class="card-eta">
      <span class="eta-min"></span>
      <span class="eta-unit"></span>
    </div>`;
  el.addEventListener('animationend', () => el.classList.remove('entering'));
  const refs = {
    dir: el.querySelector('.card-dir'),
    dest: el.querySelector('.card-dest'),
    next: el.querySelector('.card-next'),
    rmk: el.querySelector('.card-rmk'),
    walk: el.querySelector('.walk-chip'),
    min: el.querySelector('.eta-min'),
    unit: el.querySelector('.eta-unit'),
  };
  refs.min.addEventListener('animationend', () => refs.min.classList.remove('flash'));
  return { el, refs, last: {} };
}

// Set a text node only if changed; returns whether it changed.
function setText(node, value) {
  if (node.textContent !== value) {
    node.textContent = value;
    return true;
  }
  return false;
}

function setHiddenText(node, value) {
  setText(node, value || '');
  node.classList.toggle('hidden', !value);
}

// ── Per-card diff update ───────────────────────────────────────────────────

function walkState(mins) {
  // Can this arrival still be caught if you leave home now?
  if (mins < walkTime - 0.5) return { cls: 'late', text: 'Too late to walk — catch the next one', missed: true };
  if (mins <= walkTime + LEAVE_NOW_SLACK_MIN) return { cls: 'go', text: '🚶 Leave now', missed: false };
  const slack = Math.round(mins - walkTime);
  return { cls: 'soon', text: `🚶 Leave within ${slack} min`, missed: false };
}

function updateCard(card, item, columnLabel) {
  const { refs, el, last } = card;

  // Direction line, only when it differs from the column heading (GMB e.g.
  // "Towards Aberdeen" in the town-side column).
  const dirText = item.displayLabel !== columnLabel ? item.displayLabel : '';
  if (last.dirText !== dirText) {
    setHiddenText(refs.dir, dirText);
    last.dirText = dirText;
  }

  const destText = item.dest ? `to ${titleCaseIfShouty(item.dest)}` : '';
  if (last.destText !== destText) {
    setText(refs.dest, destText);
    last.destText = destText;
  }

  if (!item.live) {
    if (!last.nodata) {
      el.classList.add('nodata');
      refs.min.textContent = 'no live data';
      refs.min.className = 'eta-min eta-none';
      refs.unit.textContent = '';
      refs.walk.classList.add('hidden');
      refs.rmk.classList.add('hidden');
      last.nodata = true;
      last.minText = null;
    }
    setText(refs.next, item.error ? 'source unreachable' : 'no departures reported');
    return;
  }
  if (last.nodata) {
    el.classList.remove('nodata');
    last.nodata = false;
  }

  const mins = item.minutes[0];
  const display = mins < 0.75 ? 'Due' : String(Math.round(mins));
  const walk = walkState(mins);

  if (last.minText !== display) {
    refs.min.textContent = display;
    // One-shot fade on the changed number only — never on unchanged cards.
    if (last.minText != null) {
      refs.min.classList.remove('flash');
      void refs.min.offsetWidth;
      refs.min.classList.add('flash');
    }
    last.minText = display;
  }
  const colorCls = etaClass(mins);
  if (last.colorCls !== colorCls || last.missed !== walk.missed) {
    refs.min.classList.remove('eta-red', 'eta-amber', 'eta-green', 'eta-none', 'missed');
    refs.min.classList.add(colorCls);
    if (walk.missed) refs.min.classList.add('missed');
    last.colorCls = colorCls;
    last.missed = walk.missed;
  }
  setText(refs.unit, display === 'Due' ? '' : 'min');

  const later = item.minutes.slice(1, 3).map((m) => (m < 0.75 ? 'due' : `${Math.round(m)}`));
  setText(refs.next, later.length ? `then ${later.join(' · ')} min` : '');

  if (last.walkText !== walk.text) {
    refs.walk.textContent = walk.text;
    refs.walk.className = `walk-chip ${walk.cls}`;
    last.walkText = walk.text;
  }

  setHiddenText(refs.rmk, item.rmk || '');
}

function titleCaseIfShouty(s) {
  // GMB feeds SHOUT some names ("ABERDEEN (YUE FAI ROAD)") — soften them.
  if (s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/(^|[\s(/])\p{L}/gu, (c) => c.toUpperCase());
}

// ── Column sync (order diff + FLIP) ────────────────────────────────────────

function reorderIfNeeded(container, orderedEls) {
  const prev = colOrder.get(container) || [];
  const nextOrder = orderedEls.map((el) => el.dataset.key);
  if (prev.length === nextOrder.length && prev.every((k, i) => k === nextOrder[i])) return;

  const firstRects = new Map(
    orderedEls.filter((el) => el.parentNode).map((el) => [el, el.getBoundingClientRect()])
  );
  orderedEls.forEach((el) => container.appendChild(el));
  for (const el of orderedEls) {
    const first = firstRects.get(el);
    if (!first || first.width === 0) continue;
    const dy = first.top - el.getBoundingClientRect().top;
    if (Math.abs(dy) > 2) {
      el.style.transition = 'none';
      el.style.transform = `translateY(${dy}px)`;
      void el.offsetWidth;
      el.style.transition = '';
      el.style.transform = '';
    }
  }
  colOrder.set(container, nextOrder);
}

function syncBoard() {
  if (!snapshot) return;

  for (const sideData of snapshot.sides) {
    const col = els.cols[sideData.side];
    if (!col) continue;
    if (sideData.stop) {
      setText(col.sub, `${sideData.stop.name_en} · stop ${sideData.stop.id}`);
    }

    const items = sideData.items.map((r) => {
      const upcoming = r.etas
        .map((e) => ({ ...e, mins: minutesUntil(e.eta) }))
        .filter((e) => e.mins > -1.5);
      return {
        key: `${sideData.side}|${r.network}|${r.route}|${r.displayLabel}`,
        network: r.network,
        route: r.route,
        displayLabel: r.displayLabel,
        live: r.ok && upcoming.length > 0,
        error: !r.ok,
        dest: upcoming[0]?.dest_en || r.dest_en || '',
        rmk: upcoming[0]?.rmk_en || '',
        minutes: upcoming.map((e) => e.mins),
      };
    });

    // Soonest first across BOTH vehicle types — bus and minibus interleave
    // purely by arrival time. No-data rows sink to the bottom.
    items.sort((a, b) => {
      if (a.live !== b.live) return a.live ? -1 : 1;
      if (!a.live) return a.route.localeCompare(b.route, undefined, { numeric: true });
      return a.minutes[0] - b.minutes[0];
    });

    const ordered = [];
    for (const item of items) {
      let card = cards.get(item.key);
      if (!card) {
        card = buildCard(item.key, item, sideData.side);
        cards.set(item.key, card);
        col.cards.appendChild(card.el);
      }
      updateCard(card, item, sideData.side);
      ordered.push(card.el);
    }
    reorderIfNeeded(col.cards, ordered);
  }
}

// ── Header: sync age, poll bar, staleness banner ───────────────────────────

function updateSyncUI() {
  if (!snapshot) return;
  const ageS = (Date.now() - new Date(snapshot.generatedAt).getTime()) / 1000;
  const intervalS = snapshot.pollIntervalMs / 1000;
  setText(els.syncText, `synced ${fmtAgo(ageS)}`);
  els.pollBar.style.width = `${(Math.min(1, ageS / intervalS) * 100).toFixed(1)}%`;

  const stale = ageS > intervalS * STALE_FACTOR;
  const allDown = snapshot.ok === false;
  els.liveDot.classList.toggle('down', stale || allDown);
  if (stale) {
    showBanner(`No live data — last successful sync ${fmtAgo(ageS)}. Retrying automatically.`);
  } else if (allDown) {
    showBanner('No live data — the arrival services are not responding. Retrying automatically.');
  } else if (snapshot.failedRequests > 0) {
    showBanner(
      `Partial data — ${snapshot.failedRequests} of ${snapshot.totalRequests} arrival queries failed. Affected routes show "no live data".`
    );
  } else {
    hideBanner();
  }
}

function showBanner(msg) {
  setText(els.banner, msg);
  els.banner.classList.remove('hidden');
}
function hideBanner() {
  els.banner.classList.add('hidden');
}

// ── Weather strip ──────────────────────────────────────────────────────────

function weatherEmoji(icon) {
  if (icon >= 50 && icon <= 52) return '☀️';
  if (icon === 53 || icon === 54) return '🌦️';
  if (icon >= 60 && icon <= 61) return '☁️';
  if (icon >= 62 && icon <= 64) return '🌧️';
  if (icon === 65) return '⛈️';
  if (icon >= 70 && icon <= 77) return '🌙';
  if (icon >= 80 && icon <= 85) return '💨';
  return '🌡️';
}

async function fetchWeather() {
  try {
    const res = await fetch('api/weather');
    if (!res.ok) return;
    const w = await res.json();
    let rainText;
    if (w.rainNowMm > 0) rainText = 'Raining now';
    else if (w.rainExpectedInMin === 0) rainText = 'Rain starting now';
    else if (w.rainExpectedInMin != null) rainText = `Rain in ~${w.rainExpectedInMin} min`;
    else rainText = 'No rain expected soon';
    const temp = w.tempC != null ? `${w.tempC}°` : '–°';
    setText(els.weatherMain, `${weatherEmoji(w.icon)} ${temp} · ${rainText}`);
    const warn = (w.warnings && w.warnings[0]) || '';
    setHiddenText(els.weatherWarn, warn ? `⚠️ ${warn}` : '');
    els.weatherWarn.title = (w.warnings || []).join('\n');
  } catch {
    /* keep previous weather */
  }
}

// ── Reliability panel ──────────────────────────────────────────────────────

async function loadReliability() {
  const tbody = els.reliabilityTable.querySelector('tbody');
  tbody.innerHTML = '<tr><td colspan="5">Loading…</td></tr>';
  try {
    const res = await fetch('api/reliability');
    const data = await res.json();
    if (!data.routes.length) {
      tbody.innerHTML =
        '<tr><td colspan="5">No history yet — keep the monitor running and this fills in by itself.</td></tr>';
      return;
    }
    tbody.innerHTML = '';
    for (const r of data.routes) {
      const tr = document.createElement('tr');
      const diff =
        r.avgDelayMin > 0.2
          ? `${r.avgDelayMin} min later than first predicted`
          : r.avgDelayMin < -0.2
            ? `${Math.abs(r.avgDelayMin)} min earlier than first predicted`
            : 'On prediction';
      tr.innerHTML = `
        <td>${r.route}</td>
        <td>${r.network === 'GMB' ? 'Minibus' : 'City Bus'}</td>
        <td>${r.samples}</td>
        <td>${diff}</td>
        <td>${r.latePct}% of the time</td>`;
      tbody.appendChild(tr);
    }
  } catch {
    tbody.innerHTML = '<tr><td colspan="5">Could not load history.</td></tr>';
  }
}

els.reliabilityToggle.addEventListener('click', () => {
  const open = els.reliabilityPanel.classList.toggle('hidden');
  els.reliabilityToggle.setAttribute('aria-expanded', String(!open));
  if (!open) loadReliability();
});

// ── Data fetching ──────────────────────────────────────────────────────────

async function fetchSnapshot() {
  try {
    const res = await fetch('api/etas');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    snapshot = await res.json();
    walkTime = snapshot.walkTimeMinutes ?? walkTime;
    setText(els.walkHint, `🚶 ${walkTime} min walk`);
    syncBoard();
    updateSyncUI();
  } catch {
    if (!snapshot) {
      setText(els.syncText, 'server unreachable');
      els.liveDot.classList.add('down');
      showBanner('No live data — cannot reach the monitor server.');
    }
  }
}

async function manualRefresh() {
  const btn = els.refreshBtn;
  btn.disabled = true;
  btn.classList.add('spinning');
  try {
    const res = await fetch('api/refresh', { method: 'POST' });
    const json = await res.json();
    const snap = json && json.sides ? json : json && json.snapshot ? json.snapshot : null;
    if (snap) {
      snapshot = snap;
      syncBoard();
      updateSyncUI();
    }
  } catch {
    /* keep current view */
  } finally {
    setTimeout(() => {
      btn.disabled = false;
      btn.classList.remove('spinning');
    }, 600);
  }
}

// ── Route detail modal (remaining stops + on-time history) ─────────────────

const modal = {
  root: document.getElementById('routeModal'),
  backdrop: document.getElementById('modalBackdrop'),
  badge: document.getElementById('modalBadge'),
  title: document.getElementById('modalTitle'),
  dest: document.getElementById('modalDest'),
  reliability: document.getElementById('modalReliability'),
  mapLink: document.getElementById('modalMapLink'),
  stopsTitle: document.getElementById('modalStopsTitle'),
  stops: document.getElementById('modalStops'),
  close: document.getElementById('modalClose'),
};
let modalToken = 0; // ignore stale async fills after re-open/close
// Route paths never change while the page is open (fixed stop lists, served
// from the server's pre-warmed cache) — fetch each at most once per session.
const pathCache = new Map();

async function getPath(network, route, side) {
  const key = `${network}|${route}|${side}`;
  if (!pathCache.has(key)) {
    const res = await fetch(
      `api/route-path?network=${encodeURIComponent(network)}&route=${encodeURIComponent(route)}&side=${encodeURIComponent(side)}`
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    pathCache.set(key, await res.json());
  }
  return pathCache.get(key);
}

async function openRouteModal(network, route, side) {
  const token = ++modalToken;
  modal.root.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  modal.badge.textContent = route;
  modal.badge.className = `modal-badge${network === 'GMB' ? ' gmb' : ''}`;
  modal.badge.style.background = routeColor(route);
  modal.title.textContent = `${network === 'GMB' ? 'Minibus' : 'Bus'} ${route} · ${side}`;
  modal.dest.textContent = '';
  modal.reliability.textContent = 'Checking this route’s on-time history…';
  modal.mapLink.href = `map?route=${encodeURIComponent(`${network}|${route}|${side}`)}`;
  modal.stopsTitle.textContent = '';
  modal.stops.innerHTML = '<li class="modal-loading">Loading the stop list…</li>';

  // Stops and reliability load independently.
  fillModalStops(network, route, side, token);
  fillModalReliability(network, route, token);
}

async function fillModalStops(network, route, side, token) {
  try {
    const p = await getPath(network, route, side);
    if (token !== modalToken) return;

    modal.dest.textContent = `to ${titleCaseIfShouty(p.dest_en)}`;
    const from = Math.max(0, p.boardingIndex);
    const remaining = p.stops.slice(from);
    const skipped = p.stops.length - remaining.length;
    modal.stopsTitle.textContent =
      `${remaining.length - 1} stops from here to the end` +
      (skipped > 0 ? ` (${skipped} earlier stop${skipped === 1 ? '' : 's'} not shown)` : '');

    modal.stops.innerHTML = '';
    remaining.forEach((s, i) => {
      const li = document.createElement('li');
      const name = titleCaseIfShouty(s.name_en);
      if (i === 0) {
        li.className = 'here';
        li.innerHTML = `${name} <span class="stop-note">— this stop, board here</span>`;
      } else if (i === remaining.length - 1) {
        li.className = 'terminus';
        li.innerHTML = `${name} <span class="stop-note">— last stop</span>`;
      } else {
        li.textContent = name;
      }
      modal.stops.appendChild(li);
    });
  } catch (err) {
    if (token !== modalToken) return;
    modal.stops.innerHTML = `<li class="modal-loading">Could not load the stop list (${err.message}). Try again in a moment.</li>`;
  }
}

async function fillModalReliability(network, route, token) {
  try {
    const res = await fetch('api/reliability');
    const data = await res.json();
    if (token !== modalToken) return;
    const r = data.routes.find((x) => x.network === network && x.route === route);
    if (!r) {
      modal.reliability.textContent =
        'No on-time history for this route yet — the monitor collects it automatically while it runs.';
      return;
    }
    const diff =
      r.avgDelayMin > 0.2
        ? `usually arrives about ${r.avgDelayMin} min later than first predicted`
        : r.avgDelayMin < -0.2
          ? `usually arrives about ${Math.abs(r.avgDelayMin)} min earlier than first predicted`
          : 'usually arrives right on its prediction';
    modal.reliability.textContent =
      `Over the last ${data.windowDays} days (${r.samples} tracked arrival${r.samples === 1 ? '' : 's'}): ` +
      `${diff}; more than 3 minutes late ${r.latePct}% of the time.`;
  } catch {
    if (token === modalToken) modal.reliability.textContent = '';
  }
}

function closeRouteModal() {
  modalToken++;
  modal.root.classList.add('hidden');
  document.body.style.overflow = '';
}
modal.close.addEventListener('click', closeRouteModal);
modal.backdrop.addEventListener('click', closeRouteModal);
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !modal.root.classList.contains('hidden')) closeRouteModal();
});

els.refreshBtn.addEventListener('click', manualRefresh);

fetchSnapshot();
fetchWeather();
setInterval(fetchSnapshot, CLIENT_POLL_MS);
setInterval(fetchWeather, WEATHER_POLL_MS);
// Header-only ticker (sync age + poll bar). Cards are NOT touched here.
setInterval(updateSyncUI, 1000);
// Countdown re-diff: only changes DOM when a displayed minute actually rolls.
setInterval(syncBoard, RESYNC_MS);
