/* Repulse Bay Bus Monitor — routes map.
 *
 * Primary purpose: draw any monitored route's FULL path along the roads with
 * all of its stops, picked from the index on the left (or deep-linked from a
 * dashboard card via ?route=NETWORK|ROUTE|SIDE).
 *
 * The two home stop poles always stay on the map with live-countdown popups.
 * Vehicle GPS is not published by the government transit APIs, so no moving
 * bus icons are shown — see the explainer on the page.
 */

const HOME_CENTER = [22.2382, 114.1984];

// Same pastel palette as the dashboard.
const ROUTE_COLORS = {
  '6': '#e2c491', '6A': '#dcaa9f', '6X': '#d59aa8', '63': '#9dc6c0',
  '65': '#b3c9a1', '66': '#bfaedd', '73': '#9db8dc', '260': '#dfb29b',
  '973': '#d3aec9', '40': '#aed3b5', '40X': '#9dc8b6', '52': '#b9d3a8',
  'N40': '#93b9a7',
};
const routeColor = (r) => ROUTE_COLORS[r] || 'hsl(210 30% 72%)';

const map = L.map('map', { center: HOME_CENTER, zoom: 15, minZoom: 10, maxZoom: 18 });

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  subdomains: 'abcd',
}).addTo(map);

// Leaflet mis-sizes when its container was laid out after init — recompute.
setTimeout(() => map.invalidateSize(), 100);
window.addEventListener('resize', () => map.invalidateSize());

const poleMarkers = [];
let latestSnapshot = null;
let routeLayer = null; // currently drawn route (polyline + stop dots)
let activeRow = null;
let activeKey = null; // "NETWORK|ROUTE|SIDE" of the drawn route
let drawToken = 0; // guards against out-of-order responses on rapid clicks

const statusEl = document.getElementById('mapStatus');
function setStatus(text, isError = false) {
  statusEl.textContent = text || '';
  statusEl.style.color = isError ? 'var(--eta-red)' : 'var(--text-faint)';
}

function stopIcon(kind, text) {
  return L.divIcon({
    className: '',
    html: `<div class="stop-marker ${kind}">${text}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function fmtMins(iso) {
  const m = (new Date(iso).getTime() - Date.now()) / 60000;
  if (m < -1.5) return null;
  return m < 0.75 ? 'Due' : `${Math.round(m)} min`;
}

function polePopupHTML(m) {
  let html = `<div class="popup-title">${m.title}</div>`;
  if (!latestSnapshot) return html + '<div class="popup-eta">Loading live arrivals…</div>';
  const rows = [];
  for (const sideData of latestSnapshot.sides) {
    if (!m.sides.includes(sideData.side)) continue;
    for (const item of sideData.items) {
      if ((m.kind === 'ctb') !== (item.network === 'CTB')) continue;
      if (m.routes && !m.routes.includes(item.route)) continue;
      const t = item.etas.map((e) => fmtMins(e.eta)).filter(Boolean).slice(0, 2);
      if (t.length) rows.push(`<b>${item.route}</b> ${item.displayLabel} — ${t.join(', ')}`);
    }
  }
  html += rows.length
    ? `<div class="popup-eta">${rows.join('<br>')}</div>`
    : '<div class="popup-eta">No live departures right now.</div>';
  return html;
}

function refreshOpenPopups() {
  for (const m of poleMarkers) {
    if (m.marker.isPopupOpen()) m.marker.setPopupContent(polePopupHTML(m));
  }
}

// ── Route drawing ──────────────────────────────────────────────────────────

function clearRoute() {
  if (routeLayer) {
    map.removeLayer(routeLayer);
    routeLayer = null;
  }
  if (activeRow) activeRow.classList.remove('active');
  activeRow = null;
  activeKey = null;
  history.replaceState(null, '', 'map');
  setStatus('');
}

async function showRoute(network, route, side, row) {
  const key = `${network}|${route}|${side}`;

  // Clicking the already-drawn route deselects it and returns home.
  if (key === activeKey) {
    clearRoute();
    map.setView(HOME_CENTER, 15);
    return;
  }

  const token = ++drawToken;
  if (activeRow) activeRow.classList.remove('active');
  activeRow = row || null;
  activeKey = key;
  if (row) {
    row.classList.add('active', 'loading');
  }
  setStatus(`Drawing route ${route}…`);
  history.replaceState(null, '', `map?route=${encodeURIComponent(key)}`);

  if (routeLayer) {
    map.removeLayer(routeLayer);
    routeLayer = null;
  }

  let p;
  try {
    const res = await fetch(
      `api/route-path?network=${encodeURIComponent(network)}&route=${encodeURIComponent(route)}&side=${encodeURIComponent(side)}`
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    p = await res.json();
  } catch (err) {
    if (row) row.classList.remove('loading');
    if (token !== drawToken) return; // a newer click superseded this one
    // Reset selection so the same row can be clicked again to retry.
    if (row) row.classList.remove('active');
    activeRow = null;
    activeKey = null;
    setStatus(`Could not load route ${route} — ${err.message}`, true);
    return;
  }
  if (row) row.classList.remove('loading');
  // A newer click superseded this response: do not draw over it.
  if (token !== drawToken) return;
  setStatus(`${network === 'GMB' ? 'Minibus' : 'Bus'} ${route} to ${p.dest_en} — ${p.stops.length} stops. Click it again to clear.`);

  const color = routeColor(route);
  const layers = [
    // Halo under the line so it reads over dark tiles.
    L.polyline(p.geometry.points, { color: '#0b0e14', weight: 9, opacity: 0.8 }),
    L.polyline(p.geometry.points, { color, weight: 5, opacity: 0.95 }),
  ];
  p.stops.forEach((s, i) => {
    const isBoarding = i === p.boardingIndex;
    const isEnd = i === p.stops.length - 1;
    const dot = L.circleMarker([s.lat, s.long], {
      radius: isBoarding || isEnd ? 8 : 5,
      color: '#0b0e14',
      weight: 2,
      fillColor: isBoarding ? '#ffffff' : color,
      fillOpacity: 1,
    }).bindPopup(
      `<div class="popup-title">${i + 1}. ${s.name_en}</div>` +
        `<div class="popup-eta">${network === 'GMB' ? 'Minibus' : 'Bus'} ${route} to ${p.dest_en}` +
        `${isBoarding ? ' · <b>your stop</b>' : isEnd ? ' · <b>last stop</b>' : ''}</div>`
    );
    layers.push(dot);
  });

  routeLayer = L.layerGroup(layers).addTo(map);
  map.fitBounds(L.latLngBounds(p.stops.map((s) => [s.lat, s.long])).pad(0.08));
}

// ── Index ──────────────────────────────────────────────────────────────────

async function buildIndex() {
  const nav = document.getElementById('routeIndex');
  const { routes } = await (await fetch('api/routes-list')).json();

  const groups = [
    { title: 'City buses', match: (r) => r.network === 'CTB' },
    { title: 'Minibuses', match: (r) => r.network === 'GMB' },
  ];
  for (const g of groups) {
    const h = document.createElement('h2');
    h.textContent = g.title;
    nav.appendChild(h);
    for (const r of routes.filter(g.match)) {
      const row = document.createElement('button');
      row.className = `route-row${r.network === 'GMB' ? ' gmb' : ''}`;
      row.dataset.key = `${r.network}|${r.route}|${r.side}`;
      row.innerHTML = `
        <span class="row-badge" style="background:${routeColor(r.route)}">${r.route}</span>
        <span class="row-dest">${r.displayLabel} · to ${r.dest_en || '?'}</span>`;
      row.addEventListener('click', () => showRoute(r.network, r.route, r.side, row));
      nav.appendChild(row);
    }
  }
  return routes;
}

// ── Init ───────────────────────────────────────────────────────────────────

async function init() {
  const cfg = await (await fetch('api/config')).json();

  for (const s of cfg.ctbStops) {
    const m = {
      kind: 'ctb',
      title: `${s.label} — ${s.name_en}`,
      sides: [s.label],
      routes: s.routes,
      marker: L.marker([s.lat, s.long], { icon: stopIcon('ctb', 'B'), zIndexOffset: 500 }).addTo(map),
    };
    m.marker.bindPopup(() => polePopupHTML(m));
    poleMarkers.push(m);
  }
  for (const s of cfg.gmbStops) {
    const m = {
      kind: 'gmb',
      title: `Minibus stop — ${s.name_en}`,
      sides: s.sides,
      routes: s.routes,
      marker: L.marker([s.lat, s.long], { icon: stopIcon('gmb', 'M'), zIndexOffset: 500 }).addTo(map),
    };
    m.marker.bindPopup(() => polePopupHTML(m));
    poleMarkers.push(m);
  }

  const routes = await buildIndex();

  // Deep link from a dashboard card: ?route=NETWORK|ROUTE|SIDE
  const param = new URLSearchParams(location.search).get('route');
  if (param) {
    const [network, route, side] = param.split('|');
    const row = document.querySelector(`.route-row[data-key="${CSS.escape(param)}"]`);
    if (network && route && side) showRoute(network, route, side, row);
  }

  await fetchSnapshot();
  setInterval(fetchSnapshot, 30000);
}

async function fetchSnapshot() {
  try {
    const res = await fetch('api/etas');
    if (res.ok) {
      latestSnapshot = await res.json();
      refreshOpenPopups();
    }
  } catch {
    /* popups keep last data */
  }
}

document.getElementById('noteToggle').addEventListener('click', () => {
  document.getElementById('mapNote').classList.toggle('open');
});

init();
