# Sunset Spots

A single-page web app that finds the best **drive-up sunset viewpoints** near a
UK location. Give it a place name (or let it use your browser location) and it
ranks nearby spots for tonight's sunset, favouring places you can actually get
to: roadside pull-overs beat long hikes, and a bench nearby earns bonus points.

UK only for this first version.

**Live site: <https://danielsamuels.github.io/sunset-spots/>**

## Running it locally

It's a static app — no build, no backend, no API keys. Open `index.html` in a
browser, or serve the directory:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

Browser geolocation requires a secure context, so "Use my location" works on
the live HTTPS site and `http://localhost`, but not plain `file://` / LAN-IP
HTTP. The place search works anywhere.

## Deploying

The site is served by GitHub Pages from the **`gh-pages` branch** (root). To
publish the current state of `main`:

```sh
git push origin main:gh-pages
```

## How it works

1. **Location** — browser geolocation, or Nominatim place search restricted to
   `countrycodes=gb`. Locations outside a UK bounding box are rejected.
2. **Sunset** — tonight's sunset time and azimuth (compass direction of the
   setting sun) are computed locally with the standard SunCalc formulas. If the
   sun has already set, it plans for tomorrow instead.
3. **Candidates** — one cheap Overpass (OpenStreetMap) query pulls everything
   plausible within the search radius: tagged viewpoints (`tourism=viewpoint`),
   peaks (`natural=peak`) and roadside laybys/rest areas (`parking=layby`,
   `highway=rest_area`). Laybys sitting right next to a tagged viewpoint are
   deduplicated. Capped at the best 60 before the heavier lookups.
4. **Context** — a second Overpass query fetches benches (within 250 m),
   parking (within 600 m) and road geometry (within 2.5 km) around just those
   candidates. Motorways are ignored — being near one doesn't mean you can
   stop. Distance to the nearest road is computed client-side against the road
   geometry.
5. **Terrain** — for each candidate, elevation is fetched (Open-Elevation,
   falling back to Open Topo Data) for the spot itself plus three sample
   points at 600 m / 1.5 km / 3 km **along the sunset bearing**. The steepest
   upward angle to those samples approximates the western horizon: negative
   means the land falls away towards the sun (great), strongly positive means
   a hill is in the way.

## Scoring (out of ~100)

| Component      | Points | Notes |
| -------------- | ------ | ----- |
| Road access    | 5–30   | ≤75 m = roadside (30) … ≤2 km = a proper walk (5). **Anything beyond 2 km from a road is excluded outright.** |
| Pull-over      | 0–10   | It *is* a layby (10), or there's parking within 600 m (8) |
| Bench          | 0 / 8  | Bench within 250 m |
| Pedigree       | 0–15   | Mappers tagged it `tourism=viewpoint` (15) or it's a named peak (8) |
| Facing         | −4–6   | Viewpoint `direction` tag covers the sunset azimuth (+6) or faces away (−4) |
| Elevation      | 0–12   | Height relative to the other candidates found |
| Sunset horizon | −6–20  | Terrain falls away towards the sun (+20) … a hill blocks it (−6) |

## Services used (all free, no keys)

- [Overpass API](https://overpass-api.de) (with the Kumi mirror as fallback) — OSM data
- [Open-Elevation](https://open-elevation.com) / [Open Topo Data](https://www.opentopodata.org) — elevation
- [Nominatim](https://nominatim.org) — geocoding
- OpenStreetMap / OpenTopoMap tiles, [Leaflet](https://leafletjs.com) for the map

These are public rate-limited services: fine for personal use, not for heavy
traffic. Overpass 429s are retried automatically across mirrors.

## Ideas for later

- Cloud-cover forecast for tonight (Open-Meteo) folded into the score
- A real viewshed (line-of-sight over a DEM) instead of three-sample horizon
- Date picker for planning ahead; golden-hour window rather than the instant of sunset
- Expand beyond the UK (mostly: drop the bounding box, localise units)
