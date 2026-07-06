/* Sunset Spots — find the best drive-up sunset viewpoints near a UK location.
 *
 * Pipeline:
 *   1. Resolve a location (browser geolocation or Nominatim search, UK only).
 *   2. Compute tonight's sunset time and azimuth (inline solar math).
 *   3. Pull candidates from OpenStreetMap via Overpass: tagged viewpoints,
 *      peaks and roadside laybys, plus benches, parking and road geometry
 *      near each candidate.
 *   4. Fetch elevation for each candidate and for sample points along the
 *      sunset bearing, to test whether the terrain opens up towards the sun.
 *   5. Score and rank: roadside access and pull-overs score high, benches are
 *      a bonus, anything a long hike from a road is excluded.
 */

'use strict';

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

const UK_BOUNDS = { south: 49.8, west: -8.7, north: 60.9, east: 1.8 };
const UK_CENTRE = [54.5, -2.5];

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const MAX_CANDIDATES = 60;      // cap before elevation lookups
const ROAD_SEARCH_M = 2500;     // roads fetched within this range of candidates
const EXCLUDE_ROAD_DIST_M = 2000; // further than this from any road: not listed
const BENCH_RANGE_M = 250;
const PARKING_RANGE_M = 600;
const VIEW_SAMPLE_DISTS_M = [600, 1500, 3000]; // terrain samples towards sunset
const EYE_HEIGHT_M = 2;

/* ------------------------------------------------------------------ *
 * Solar math (compact port of the standard SunCalc formulas,
 * https://github.com/mourner/suncalc, BSD-2-Clause)
 * ------------------------------------------------------------------ */

const Sun = (() => {
  const rad = Math.PI / 180;
  const dayMs = 86400000, J1970 = 2440588, J2000 = 2451545;
  const e = rad * 23.4397; // obliquity of the Earth

  const toJulian = (date) => date.valueOf() / dayMs - 0.5 + J1970;
  const fromJulian = (j) => new Date((j + 0.5 - J1970) * dayMs);
  const toDays = (date) => toJulian(date) - J2000;

  const solarMeanAnomaly = (d) => rad * (357.5291 + 0.98560028 * d);
  const eclipticLongitude = (M) => {
    const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    const P = rad * 102.9372; // perihelion of the Earth
    return M + C + P + Math.PI;
  };
  const declination = (l) => Math.asin(Math.sin(e) * Math.sin(l));
  const rightAscension = (l) => Math.atan2(Math.sin(l) * Math.cos(e), Math.cos(l));
  const siderealTime = (d, lw) => rad * (280.16 + 360.9856235 * d) - lw;

  function sunCoords(d) {
    const M = solarMeanAnomaly(d);
    const L = eclipticLongitude(M);
    return { dec: declination(L), ra: rightAscension(L) };
  }

  /** Sun azimuth (degrees clockwise from north) and altitude (degrees). */
  function position(date, lat, lng) {
    const lw = rad * -lng, phi = rad * lat, d = toDays(date);
    const c = sunCoords(d);
    const H = siderealTime(d, lw) - c.ra;
    const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(c.dec) * Math.cos(phi));
    const alt = Math.asin(Math.sin(phi) * Math.sin(c.dec) + Math.cos(phi) * Math.cos(c.dec) * Math.cos(H));
    return { azimuth: ((az / rad) + 180 + 360) % 360, altitude: alt / rad };
  }

  const J0 = 0.0009;
  const julianCycle = (d, lw) => Math.round(d - J0 - lw / (2 * Math.PI));
  const approxTransit = (Ht, lw, n) => J0 + (Ht + lw) / (2 * Math.PI) + n;
  const solarTransitJ = (ds, M, L) => J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  const hourAngle = (h, phi, dec) =>
    Math.acos((Math.sin(h) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec)));

  /** Sunset (upper limb touching horizon, -0.833°) for the given date, or null. */
  function sunset(date, lat, lng) {
    const lw = rad * -lng, phi = rad * lat;
    const d = toDays(date);
    const n = julianCycle(d, lw);
    const ds = approxTransit(0, lw, n);
    const M = solarMeanAnomaly(ds);
    const L = eclipticLongitude(M);
    const dec = declination(L);
    const w = hourAngle(-0.833 * rad, phi, dec);
    if (Number.isNaN(w)) return null; // no sunset (deep polar) — not the UK
    const Jset = solarTransitJ(approxTransit(w, lw, n), M, L);
    return fromJulian(Jset);
  }

  return { position, sunset };
})();

/* ------------------------------------------------------------------ *
 * Geodesy helpers
 * ------------------------------------------------------------------ */

const EARTH_R = 6371000;
const toRad = (d) => d * Math.PI / 180;
const toDeg = (r) => r * 180 / Math.PI;

function haversineM(a, b) {
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(s));
}

/** Point reached from `origin` travelling `distM` metres on `bearingDeg`. */
function destination(origin, bearingDeg, distM) {
  const br = toRad(bearingDeg), d = distM / EARTH_R;
  const lat1 = toRad(origin.lat), lng1 = toRad(origin.lng);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br));
  const lng2 = lng1 + Math.atan2(
    Math.sin(br) * Math.sin(d) * Math.cos(lat1),
    Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: toDeg(lat2), lng: toDeg(lng2) };
}

/** Approximate distance in metres from point p to segment a-b (local planar). */
function pointToSegmentM(p, a, b) {
  const cosLat = Math.cos(toRad(p.lat));
  const ax = (a.lng - p.lng) * cosLat, ay = a.lat - p.lat;
  const bx = (b.lng - p.lng) * cosLat, by = b.lat - p.lat;
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : -(ax * dx + ay * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.sqrt(cx * cx + cy * cy) * (Math.PI / 180) * EARTH_R;
}

const inUK = (p) =>
  p.lat >= UK_BOUNDS.south && p.lat <= UK_BOUNDS.north &&
  p.lng >= UK_BOUNDS.west && p.lng <= UK_BOUNDS.east;

/* ------------------------------------------------------------------ *
 * External data
 * ------------------------------------------------------------------ */

async function geocodeUK(query) {
  const url = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({
    q: query, format: 'jsonv2', countrycodes: 'gb', limit: '1',
  });
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Geocoding failed (${res.status})`);
  const hits = await res.json();
  if (!hits.length) throw new Error(`Couldn't find “${query}” in the UK.`);
  return {
    lat: parseFloat(hits[0].lat),
    lng: parseFloat(hits[0].lon),
    label: hits[0].display_name.split(',').slice(0, 2).join(','),
  };
}

/** Best-effort place name for a map click; falls back to coordinates. */
async function reverseLabel(p) {
  try {
    const url = 'https://nominatim.openstreetmap.org/reverse?' + new URLSearchParams({
      lat: p.lat.toFixed(5), lon: p.lng.toFixed(5), format: 'jsonv2', zoom: '14',
    });
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (res.ok) {
      const hit = await res.json();
      if (hit.display_name) return hit.display_name.split(',').slice(0, 2).join(',');
    }
  } catch { /* fall through to coordinates */ }
  return `Dropped pin (${p.lat.toFixed(3)}, ${p.lng.toFixed(3)})`;
}

/** Phase 1: just the candidate spots within the search radius. Cheap. */
function candidatesQuery(centre, radiusM) {
  const around = `(around:${radiusM},${centre.lat.toFixed(5)},${centre.lng.toFixed(5)})`;
  return `[out:json][timeout:60];
(
  nwr["tourism"="viewpoint"]${around};
  node["natural"="peak"]${around};
  nwr["parking"="layby"]${around};
  nwr["highway"="rest_area"]${around};
);
out tags center;`;
}

/** Phase 2: benches, parking and road geometry around the capped candidate
 *  set only — fetching roads across the whole radius is far too heavy.
 *  Motorways are omitted: being near one doesn't mean you can stop there. */
function contextQuery(candidates) {
  const byType = { node: [], way: [], relation: [] };
  for (const c of candidates) {
    const [type, id] = c.id.split('/');
    byType[type].push(id);
  }
  const cands = Object.entries(byType)
    .filter(([, ids]) => ids.length)
    .map(([type, ids]) => `${type}(id:${ids.join(',')});`)
    .join('\n  ');
  return `[out:json][timeout:90];
(
  ${cands}
)->.cands;
node["amenity"="bench"](around.cands:${BENCH_RANGE_M})->.benches;
nwr["amenity"="parking"](around.cands:${PARKING_RANGE_M})->.parking;
way["highway"~"^(trunk|primary|secondary|tertiary|unclassified|residential|service|living_street)$"](around.cands:${ROAD_SEARCH_M})->.roads;
.benches out skel;
.parking out tags center;
.roads out skel geom;`;
}

async function fetchOverpass(query) {
  let lastErr;
  // Two passes over the mirrors with a pause between passes — the public
  // Overpass instances rate-limit (429) freely and recover quickly.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 8000));
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          body: 'data=' + encodeURIComponent(query),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        if (!res.ok) throw new Error(`Overpass ${res.status}`);
        return await res.json();
      } catch (err) {
        lastErr = err;
      }
    }
  }
  throw new Error(`Map data unavailable (${lastErr?.message ?? 'network error'}). Try again shortly.`);
}

/** Elevations for [{lat,lng}...] via Open-Elevation, with an Open Topo Data
 *  fallback. Returns metres (null where unavailable). */
async function fetchElevations(points) {
  const out = new Array(points.length).fill(null);
  const CHUNK = 100;
  for (let i = 0; i < points.length; i += CHUNK) {
    const chunk = points.slice(i, i + CHUNK);
    try {
      const res = await fetch('https://api.open-elevation.com/api/v1/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          locations: chunk.map((p) => ({ latitude: p.lat, longitude: p.lng })),
        }),
      });
      if (!res.ok) throw new Error(`open-elevation ${res.status}`);
      const data = await res.json();
      data.results.forEach((r, j) => { out[i + j] = r.elevation; });
    } catch {
      try {
        const locs = chunk.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join('|');
        const res = await fetch(`https://api.opentopodata.org/v1/srtm90m?locations=${locs}`);
        if (!res.ok) throw new Error(`opentopodata ${res.status}`);
        const data = await res.json();
        data.results.forEach((r, j) => { out[i + j] = r.elevation; });
        await new Promise((r) => setTimeout(r, 1100)); // opentopodata: 1 req/s
      } catch {
        /* leave nulls — scoring degrades gracefully */
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Candidate extraction
 * ------------------------------------------------------------------ */

function elementPoint(el) {
  if (el.type === 'node') return { lat: el.lat, lng: el.lon };
  if (el.center) return { lat: el.center.lat, lng: el.center.lon };
  return null;
}

function parseCandidates(data, centre) {
  const candidates = [];
  for (const el of data.elements || []) {
    const t = el.tags || {};
    const kind =
      t.tourism === 'viewpoint' ? 'viewpoint' :
      t.natural === 'peak' ? 'peak' :
      (t.parking === 'layby' || t.highway === 'rest_area') ? 'layby' : null;
    const pt = elementPoint(el);
    if (!kind || !pt) continue;
    candidates.push({
      id: `${el.type}/${el.id}`,
      kind,
      ...pt,
      tags: t,
      distFromUserM: haversineM(centre, pt),
    });
  }
  return candidates;
}

function parseContext(data) {
  const benches = [], parking = [], roads = [];
  for (const el of data.elements || []) {
    if (el.type === 'way' && el.geometry?.length > 1) {
      // roads are the only elements returned with full geometry
      roads.push(el.geometry.map((g) => ({ lat: g.lat, lng: g.lon })));
    } else if (el.tags?.amenity === 'parking') {
      const pt = elementPoint(el);
      if (pt) parking.push(pt);
    } else if (el.type === 'node') {
      benches.push({ lat: el.lat, lng: el.lon }); // skel nodes = benches
    }
  }
  return { benches, parking, roads };
}

/** Drop laybys/rest areas that sit right next to a tagged viewpoint — the
 *  viewpoint entry already gets the pull-over bonus, no need to list both. */
function dedupeCandidates(candidates) {
  const viewpoints = candidates.filter((c) => c.kind === 'viewpoint');
  return candidates.filter((c) =>
    c.kind !== 'layby' ||
    !viewpoints.some((v) => haversineM(c, v) < 250));
}

function nearestRoadDistM(pt, roads) {
  let best = Infinity;
  for (const line of roads) {
    for (let i = 0; i < line.length - 1; i++) {
      // cheap bbox reject before the exact segment distance
      if (Math.abs(line[i].lat - pt.lat) > 0.05) continue;
      const d = pointToSegmentM(pt, line[i], line[i + 1]);
      if (d < best) best = d;
    }
  }
  return best;
}

function nearestM(pt, points) {
  let best = Infinity;
  for (const p of points) {
    const d = haversineM(pt, p);
    if (d < best) best = d;
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * Scoring
 * ------------------------------------------------------------------ */

const CARDINALS = {
  N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
  S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
};

const angularDiff = (a, b) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/** Does a viewpoint's `direction` tag cover the sunset azimuth (±60°)?
 *  Returns true / false / null (no usable tag). Handles "W", "270",
 *  "225-315" and ";"-separated lists. */
function directionCoversAzimuth(tagValue, azimuth) {
  if (!tagValue) return null;
  let any = false;
  for (const part of String(tagValue).toUpperCase().split(';')) {
    const v = part.trim();
    if (!v || v === '360') continue;
    const range = v.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/);
    if (range) {
      any = true;
      let [, lo, hi] = range.map(Number);
      const inside = lo <= hi
        ? azimuth >= lo - 20 && azimuth <= hi + 20
        : azimuth >= lo - 20 || azimuth <= hi + 20; // wraps through north
      if (inside) return true;
      continue;
    }
    const deg = v in CARDINALS ? CARDINALS[v] : (isNaN(Number(v)) ? null : Number(v));
    if (deg === null) continue;
    any = true;
    if (angularDiff(deg, azimuth) <= 60) return true;
  }
  return any ? false : null;
}

/**
 * Score a candidate out of ~100. Components:
 *  - access (0–30): distance from the nearest road; roadside is best,
 *    anything past EXCLUDE_ROAD_DIST_M has already been excluded
 *  - pull-over (0–10): is it a layby, or is there parking close by?
 *  - bench (0–8)
 *  - pedigree (0–15): mappers already tagged it a viewpoint (or it's a peak)
 *  - facing (−4–6): viewpoint direction tag vs sunset azimuth
 *  - elevation (0–12): height relative to the other candidates found
 *  - sunset horizon (−6–20): does the terrain fall away towards the sun?
 */
function scoreCandidate(c, ctx) {
  const parts = {};

  const rd = c.roadDistM;
  parts.access =
    rd <= 75 ? 30 :
    rd <= 200 ? 26 :
    rd <= 500 ? 20 :
    rd <= 1000 ? 12 :
    5; // up to EXCLUDE_ROAD_DIST_M — a proper walk

  parts.pullOver = c.kind === 'layby' ? 10 : c.parkingDistM <= PARKING_RANGE_M ? 8 : 0;
  parts.bench = c.benchDistM <= BENCH_RANGE_M ? 8 : 0;
  parts.pedigree = c.kind === 'viewpoint' ? 15 : c.kind === 'peak' ? 8 : 0;

  const facing = directionCoversAzimuth(c.tags.direction, ctx.sunsetAzimuth);
  parts.facing = facing === true ? 6 : facing === false ? -4 : 0;

  if (c.elevation !== null && ctx.elevSpread > 0) {
    parts.elevation = Math.round(12 * (c.elevation - ctx.elevMin) / ctx.elevSpread);
  } else {
    parts.elevation = 0;
  }

  // Horizon angle towards the sunset: the steepest upward angle to any of the
  // sampled terrain points along the sunset bearing. Negative = land falls
  // away = open view; strongly positive = a hill is in the way.
  if (c.horizonDeg !== null) {
    parts.sunsetView =
      c.horizonDeg <= -1.0 ? 20 :
      c.horizonDeg <= 0 ? 14 :
      c.horizonDeg <= 1.5 ? 6 :
      c.horizonDeg <= 3 ? 0 :
      -6;
  } else {
    parts.sunsetView = 8; // unknown terrain — neutral-ish
  }

  return { total: Object.values(parts).reduce((a, b) => a + b, 0), parts };
}

/* ------------------------------------------------------------------ *
 * Main search flow
 * ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

const state = {
  map: null,
  markerLayer: null,
  rayLayer: null,
  spots: [],
  searching: false,
};

function setStatus(msg, kind = 'info') {
  const el = $('status');
  if (!msg) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = msg;
  el.dataset.kind = kind;
}

function fmtDist(m) {
  if (m == null || !isFinite(m)) return '?';
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1609.34).toFixed(1)} mi`;
}

function fmtTime(d) {
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function compass(azimuth) {
  const names = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return names[Math.round(azimuth / 22.5) % 16];
}

async function runSearch(centre, label) {
  if (state.searching) return;
  state.searching = true;
  $('results').innerHTML = '';
  $('sun-banner').hidden = true;
  state.markerLayer.clearLayers();
  state.rayLayer.clearLayers();

  try {
    if (!inUK(centre)) {
      throw new Error('That location is outside the UK — this first version is UK only.');
    }

    // Tonight's sunset (or tomorrow's if it has already set).
    let sunsetDate = new Date();
    let sunsetAt = Sun.sunset(sunsetDate, centre.lat, centre.lng);
    if (sunsetAt && sunsetAt < new Date()) {
      sunsetDate = new Date(Date.now() + 86400000);
      sunsetAt = Sun.sunset(sunsetDate, centre.lat, centre.lng);
    }
    if (!sunsetAt) throw new Error('No sunset found for this location/date.');
    const sunsetAzimuth = Sun.position(sunsetAt, centre.lat, centre.lng).azimuth;

    $('sunset-time').textContent = fmtTime(sunsetAt);
    $('sunset-az').textContent = `${compass(sunsetAzimuth)} (${Math.round(sunsetAzimuth)}°)`;
    $('sunset-date').textContent = sunsetAt.toLocaleDateString('en-GB', {
      weekday: 'short', day: 'numeric', month: 'short',
    });
    $('sun-banner').hidden = false;

    state.map.setView([centre.lat, centre.lng], 11);
    L.circleMarker([centre.lat, centre.lng], {
      radius: 7, color: '#fff', weight: 2, fillColor: '#3b82f6', fillOpacity: 1,
      bubblingMouseEvents: false, // clicking the pin must not start a new search
    }).bindPopup(`<b>${label}</b>`).addTo(state.markerLayer);

    const radiusM = Number($('radius-input').value) * 1000;
    setStatus('Searching OpenStreetMap for viewpoints, peaks and laybys…');
    const rawCands = await fetchOverpass(candidatesQuery(centre, radiusM));
    let spots = dedupeCandidates(parseCandidates(rawCands, centre));
    if (!spots.length) {
      throw new Error('No viewpoints, peaks or laybys found here — try a bigger radius.');
    }

    // Cap before the heavier lookups: prefer tagged viewpoints, then peaks,
    // then laybys; closer first within each tier.
    const tier = { viewpoint: 0, peak: 1, layby: 2 };
    spots.sort((a, b) => (tier[a.kind] - tier[b.kind]) || (a.distFromUserM - b.distFromUserM));
    spots = spots.slice(0, MAX_CANDIDATES);

    setStatus(`Checking road access for ${spots.length} spots…`);
    const rawCtx = await fetchOverpass(contextQuery(spots));
    const { benches, parking, roads } = parseContext(rawCtx);
    for (const c of spots) {
      c.roadDistM = nearestRoadDistM(c, roads);
      c.benchDistM = nearestM(c, benches);
      c.parkingDistM = nearestM(c, parking);
    }

    // The hard rule: a great view you can't reasonably get to is no good.
    const reachable = spots.filter((c) => c.roadDistM <= EXCLUDE_ROAD_DIST_M);
    const excluded = spots.length - reachable.length;
    spots = reachable;
    if (!spots.length) {
      throw new Error('Every spot found here is too far from a road. Try a bigger radius.');
    }

    setStatus(`Checking elevation and the western horizon for ${spots.length} spots…`);
    const elevPoints = [];
    for (const c of spots) {
      elevPoints.push({ lat: c.lat, lng: c.lng });
      for (const d of VIEW_SAMPLE_DISTS_M) elevPoints.push(destination(c, sunsetAzimuth, d));
    }
    const elevs = await fetchElevations(elevPoints);
    const stride = 1 + VIEW_SAMPLE_DISTS_M.length;
    spots.forEach((c, i) => {
      const base = elevs[i * stride];
      c.elevation = base;
      c.horizonDeg = null;
      if (base !== null) {
        let maxAngle = -Infinity;
        VIEW_SAMPLE_DISTS_M.forEach((d, j) => {
          const sample = elevs[i * stride + 1 + j];
          if (sample === null) return;
          maxAngle = Math.max(maxAngle, toDeg(Math.atan2(sample - (base + EYE_HEIGHT_M), d)));
        });
        if (isFinite(maxAngle)) c.horizonDeg = maxAngle;
      }
    });

    const withElev = spots.filter((c) => c.elevation !== null).map((c) => c.elevation);
    const ctx = {
      sunsetAzimuth,
      elevMin: Math.min(...withElev),
      elevSpread: Math.max(...withElev) - Math.min(...withElev),
    };
    for (const c of spots) {
      const { total, parts } = scoreCandidate(c, ctx);
      c.score = total;
      c.parts = parts;
    }
    spots.sort((a, b) => b.score - a.score);
    state.spots = spots;

    renderResults(spots, sunsetAzimuth, excluded);
    setStatus(null);
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    state.searching = false;
  }
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

const KIND_LABEL = { viewpoint: 'Viewpoint', peak: 'Peak', layby: 'Layby' };
const KIND_ICON = { viewpoint: '🔭', peak: '⛰️', layby: '🚗' };

function spotName(c) {
  return c.tags.name || `${KIND_LABEL[c.kind]}${c.tags.ele ? ` (${Math.round(c.tags.ele)} m)` : ''}`;
}

function scoreColour(score, best) {
  const t = Math.max(0, Math.min(1, score / Math.max(best, 1)));
  return t > 0.85 ? '#f97316' : t > 0.6 ? '#fbbf24' : '#94a3b8';
}

function renderResults(spots, sunsetAzimuth, excludedCount) {
  const list = $('results');
  list.innerHTML = '';
  const shown = spots.slice(0, 15);
  const best = shown[0]?.score ?? 1;
  const bounds = [];

  shown.forEach((c, i) => {
    const colour = scoreColour(c.score, best);
    const marker = L.circleMarker([c.lat, c.lng], {
      radius: i === 0 ? 10 : 8,
      color: '#1e293b', weight: 1.5,
      fillColor: colour, fillOpacity: 0.95,
      bubblingMouseEvents: false, // selecting a spot must not start a new search
    }).addTo(state.markerLayer);
    marker.bindPopup(`<b>${i + 1}. ${spotName(c)}</b><br>${KIND_LABEL[c.kind]} · score ${c.score}`);
    marker.on('click', () => selectSpot(c, sunsetAzimuth));
    bounds.push([c.lat, c.lng]);

    const chips = [
      `${KIND_ICON[c.kind]} ${KIND_LABEL[c.kind]}`,
      `🛣️ ${fmtDist(c.roadDistM)} to road`,
    ];
    if (c.kind === 'layby') chips.push('🅿️ pull right over');
    else if (c.parts.pullOver > 0) chips.push(`🅿️ parking ${fmtDist(c.parkingDistM)}`);
    if (c.parts.bench > 0) chips.push('🪑 bench');
    if (c.elevation !== null) chips.push(`⛰️ ${Math.round(c.elevation)} m`);
    if (c.horizonDeg !== null) {
      chips.push(c.horizonDeg <= 0 ? '🌇 open sunset horizon'
        : c.horizonDeg <= 1.5 ? '🌤️ mostly open west'
        : '⚠️ hill blocks the sunset');
    }

    const li = document.createElement('li');
    li.className = 'spot';
    li.innerHTML = `
      <div class="spot-head">
        <span class="rank" style="background:${colour}">${i + 1}</span>
        <span class="spot-name">${escapeHtml(spotName(c))}</span>
        <span class="spot-score">${c.score}</span>
      </div>
      <div class="chips">${chips.map((t) => `<span class="chip">${t}</span>`).join('')}</div>
      <div class="spot-links">
        <a href="https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lng}"
           target="_blank" rel="noopener">Directions</a>
        <a href="https://www.openstreetmap.org/${c.id}" target="_blank" rel="noopener">OSM</a>
        <span class="away">${fmtDist(c.distFromUserM)} away</span>
      </div>`;
    li.addEventListener('click', (ev) => {
      if (ev.target.tagName === 'A') return;
      selectSpot(c, sunsetAzimuth);
      marker.openPopup();
    });
    list.appendChild(li);
  });

  if (excludedCount > 0) {
    const note = document.createElement('li');
    note.className = 'excluded-note';
    note.textContent = `${excludedCount} spot${excludedCount === 1 ? '' : 's'} skipped — more than ${fmtDist(EXCLUDE_ROAD_DIST_M)} from the nearest road.`;
    list.appendChild(note);
  }

  if (bounds.length) state.map.fitBounds(bounds, { padding: [40, 40], maxZoom: 13 });
  if (shown[0]) selectSpot(shown[0], sunsetAzimuth);
}

/** Highlight a spot: draw the ray it looks along towards the setting sun. */
function selectSpot(c, sunsetAzimuth) {
  state.rayLayer.clearLayers();
  const far = destination(c, sunsetAzimuth, 6000);
  L.polyline([[c.lat, c.lng], [far.lat, far.lng]], {
    color: '#f97316', weight: 3, dashArray: '6 8', opacity: 0.9,
    interactive: false, // the ray shouldn't swallow map clicks
  }).addTo(state.rayLayer);
  L.marker([far.lat, far.lng], {
    icon: L.divIcon({ className: 'sun-icon', html: '☀️', iconSize: [24, 24] }),
    interactive: false,
  }).addTo(state.rayLayer);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

/* ------------------------------------------------------------------ *
 * Bootstrap
 * ------------------------------------------------------------------ */

function init() {
  state.map = L.map('map', { zoomControl: true }).setView(UK_CENTRE, 6);
  const street = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(state.map);
  const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxZoom: 17,
    attribution: '© OpenStreetMap contributors, SRTM · © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
  });
  L.control.layers({ 'Street map': street, 'Terrain': topo }).addTo(state.map);
  state.markerLayer = L.layerGroup().addTo(state.map);
  state.rayLayer = L.layerGroup().addTo(state.map);

  // Click anywhere on the map to search from that point.
  state.map.on('click', async (e) => {
    if (state.searching) return;
    const p = { lat: e.latlng.lat, lng: e.latlng.lng };
    setStatus('Looking up that spot…');
    runSearch(p, await reverseLabel(p));
  });

  $('radius-input').addEventListener('input', () => {
    $('radius-label').textContent = $('radius-input').value;
  });

  $('locate-btn').addEventListener('click', () => {
    if (!navigator.geolocation) {
      setStatus('Geolocation is not available in this browser.', 'error');
      return;
    }
    setStatus('Getting your location…');
    navigator.geolocation.getCurrentPosition(
      (pos) => runSearch(
        { lat: pos.coords.latitude, lng: pos.coords.longitude }, 'Your location'),
      (err) => setStatus(`Couldn't get your location: ${err.message}`, 'error'),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 },
    );
  });

  const doSearch = async () => {
    const q = $('place-input').value.trim();
    if (!q) return;
    try {
      setStatus(`Looking up “${q}”…`);
      const hit = await geocodeUK(q);
      runSearch(hit, hit.label);
    } catch (err) {
      setStatus(err.message, 'error');
    }
  };
  $('search-btn').addEventListener('click', doSearch);
  $('place-input').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') doSearch();
  });
}

init();
