# GeoScout — Map-based business discovery MVP

A standalone Next.js application for geographical business discovery. Draw a polygon or rectangle around a location, discover businesses mapped in OpenStreetMap, filter results and download a JSON or CSV file with available websites, phones, addresses and source records.

**This prototype does not scrape Google Maps**. It uses OpenStreetMap (OSM) data through the Overpass API. The map starts in St. John's, Newfoundland, but you can navigate anywhere.

## How to use screenshot-style region selection

This is **geographic selection, not image recognition**: the rectangle you drag on the map is converted to latitude/longitude boundaries. The backend searches geographic business databases and checks whether each record's mapped point is inside the selection.

1. Open the map, scroll to zoom, or choose **Move map** to pan.
2. With **Select area** (the default), simply press and drag anywhere over the map, like cropping a screenshot. There is **no drawing toolbar or extra activation step**.
3. Release the mouse. GeoScout displays **Searching…** in the map and starts geographic discovery.
4. The map shows the number of businesses found or a clear error. Click **View JSON ↓** to jump to the results.
5. The **JSON preview** tab displays the first 25 entries; **↓ JSON** downloads all returned records with provenance. The table and CSV export are also available.
6. To search a new area, drag another rectangle. Click **Move map** whenever you want to pan; click **Select area** to return to crop-style selection.

The default **All businesses** category includes names, phone numbers, websites, email addresses, addresses and geographic coordinates when the provider has these fields. Missing data is represented by `null`. This is not a guarantee that every Google Maps business or every real business in the area will be found. Large or dense areas can be truncated; the UI reports this. Avoid claiming complete geographic coverage from a single query.

### API / export behavior

`POST /api/search` accepts a GeoJSON-style coordinate ring (longitude first), e.g.
`"polygon": [[-52.75,47.55],[-52.70,47.55],[-52.70,47.59],[-52.75,47.59]]`.
The response includes `businesses`, `count`, `sources`, `truncated`, and `warnings`.

The JSON download adds `schemaVersion`, `selection` as a GeoJSON Polygon, `exportedAt`, and `completeness`, alongside the full business array. The in-app preview samples only 25 businesses; it is not a separate query or a truncation of the downloaded output.

## Quick start

Requirements: Node.js 20.9+ and npm.

~~~bash
git clone https://github.com/hamzaoub/geo-business-explorer.git
cd geo-business-explorer
npm install
npm run dev
~~~

Open http://localhost:3000.

Drag directly on the map to draw a rectangle. Release to search automatically, then view the JSON or table and export. Use the two-state **Select area / Move map** control to navigate; the app no longer requires Leaflet Draw.

Optional configuration: copy .env.example to .env.local and set OVERPASS_URL to your own or contracted Overpass server; provide OVERPASS_CONTACT_EMAIL for service identification.

## Commands

~~~bash
npm run dev        # local development
npm run typecheck  # TypeScript checks
npm test           # geometry and query unit tests
npm run build      # production build
npm start          # serve built app
~~~

## What is included

- Direct pointer-drag geographic rectangle selection with no drawing plugin or toolbar; clear-and-redraw support.
- Real server-side Overpass search across named shops, amenities, offices, crafts, healthcare and tourism features.
- Bounding-box query followed by exact polygon filtering against mapped feature coordinates.
- Business name, category, phone, website, email, available address, coordinates, and direct OSM source link.
- Category and website availability filters; paged table, summary statistics, map markers.
- JSON/CSV export. JSON includes the selected polygon and license/source metadata.
- URL protocol validation, output escaping, basic CSV formula sanitization, polygon limits, request caps and best-effort cooldowns.
- Automated unit tests for geometry and Overpass query generation.

## API

POST /api/search

~~~json
{
  "category": "all",
  "polygon": [
    [-52.81, 47.55],
    [-52.70, 47.55],
    [-52.70, 47.62],
    [-52.81, 47.62]
  ]
}
~~~

Categories: all, food, retail, services, health, stay.

Response includes businesses, count, truncated, searchedAt, the selected provider, a list of source attributions, and warnings. Set `provider` to `osm` (default), `overture`, or `both`. Errors return an error field with an appropriate HTTP code.

## Overture Maps: optional second data source (v0.2)

Overture Places is available through a **separate Python worker** that reads Overture's public GeoParquet, using the latest release announced by its STAC catalog. This is an opt-in preview and is **not enabled automatically** by npm install.

~~~bash
# Terminal 1 — run the worker
cd geo-business-explorer/worker
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export OVERTURE_WORKER_KEY="use-a-long-random-secret"
uvicorn app:app --host 127.0.0.1 --port 8787

# Terminal 2 — run the web app
cd geo-business-explorer
cp .env.example .env.local
# Set OVERTURE_SERVICE_URL=http://127.0.0.1:8787 and the same OVERTURE_WORKER_KEY
npm install && npm run dev
~~~

The web app's data source selector will enable **Overture Maps** and **Combine both** only after OVERTURE_SERVICE_URL is configured and the Next.js server is restarted. Choose a polygon bounding box <= 200 km² for Overture. The worker reads up to 2,001 rows per query and returns at most 2,000, with a truncated flag if more are available. Its first run may install DuckDB's httpfs extension and scan remote files, which can be slow. It is intentionally separate from the Vercel/Next.js process; host it on an appropriate Python service, not as a short-lived serverless function.

The worker requires Python 3.11+, FastAPI, and DuckDB. By default it discovers the release at `https://stac.overturemaps.org/catalog.json`; use `OVERTURE_RELEASE=2026-10-21.0` to pin a version. For local Parquet test data, set `OVERTURE_PARQUET_GLOB`. Run worker unit tests from its folder with `python -m unittest -v`.

**Private network / security:** Bind to 127.0.0.1 for development. For deployment set a strong shared OVERTURE_WORKER_KEY, restrict network access, HTTPS between services, durable rate limits and monitoring. The worker's in-process lock limits concurrency to one request. The application will warn and show partial results if one of two sources fails.

**Important data licensing:** Overture Places contains multiple contributing sources whose licenses can differ, while OSM is subject to ODbL. Combined/derived exports may become subject to ODbL obligations; check each provider's licenses before commercial reuse. GeoScout is not a Google Maps scraper.

## City / place search: optional

Set `GEOCODER_CONTACT_EMAIL` in `.env.local` to enable the explicit city search button. GeoScout uses the public Nominatim service with a contact-identifying User-Agent, caches successful searches for 24h and throttles requests per Node.js instance. **This is only suitable for light local testing**, and public Nominatim limits *the whole application* to max 1 request/second. We do not implement autocomplete. Before public launch move to a dedicated/contracted geocoder and shared distributed caching/rate limiting. Set `NOMINATIM_URL` to your self-hosted or licensed compatible endpoint.

## Limitations and compliance

- **Not exhaustive:** OSM entries may be missing, duplicated, outdated or lack websites and phones. These exports are not a comprehensive business registry.
- **Search volume:** Each public Overpass query covers a bounding box of at most approximately 1,800 km² and returns a maximum of 4,000 raw features. If truncated=true, subdivide the area. The coordinate for an OSM way or relation is its Overpass center, which can lie outside an irregular shape even when the shape overlaps it.
- **Public API use:** Public Overpass is a shared resource suitable for light prototype queries, not sustained commercial bulk harvesting. Use a dedicated/contracted service or indexed Overture data for production.
- **Attribution and licensing:** © OpenStreetMap contributors. OSM data is licensed under ODbL 1.0. Follow attribution and database share-alike obligations when redistributing data. OpenStreetMap standard tiles have their own usage policy; use a commercial or self-hosted tile provider as traffic increases. See https://www.openstreetmap.org/copyright.
- **Rate limiting:** The app includes only a per-process IP cooldown. In production put durable rate limiting and abuse protection at the edge, avoid trusting arbitrary X-Forwarded-For headers, add user authentication and background processing.
- **No website crawling yet:** The website column is sourced from OSM tags, not scraped from websites.

## Production roadmap

1. Index Overture Maps Places locally in DuckDB/GeoParquet or PostGIS for fast large-area discovery.
2. Improve source-aware record merging/deduplication, attribution and confidence fields.
3. Persistence, saved polygons, asynchronous large-area searches and job progress.
4. Opt-in enrichment of public business websites with robots.txt, rate limiting and contact privacy safeguards.
5. Auth, quota management, billing, monitoring, API tests and managed map tiles.

## Project structure

~~~text
src/app/page.tsx                  Explorer UI
src/components/MapCanvas.tsx      Leaflet drawing and markers
src/app/api/search/route.ts       Validated search API
src/lib/overpass.ts               OSM discovery and normalization
src/lib/geo.ts                    Polygon validation and point containment
src/lib/export.ts                 JSON and CSV downloads
~~~

This project lives at the root of its own repository, separate from the original Ai-Starter codebase.

### CI status

The repository includes a GitHub Actions workflow that runs TypeScript checks, unit tests, a Next.js build, and Python worker tests. If GitHub Actions fails before executing steps (for example due to runner availability or billing/account restrictions), the check does **not** validate the code. Run commands locally before deployment.

### Troubleshooting UI errors

- The map no longer imports `leaflet-draw`: the previous `L.Draw.Event` error is removed at the source. The map starts in **Select area** mode; dragging pans only in **Move map** mode.
- The React hydration warning about `className=\"kapture-loaded\"` is caused by a browser extension modifying the body before hydration. `suppressHydrationWarning` is scoped to the body attribute to avoid a misleading warning; disable the extension when debugging unrelated issues.
- A browser extension's `Could not establish connection. Receiving end does not exist` is unrelated to GeoScout.
- Favicon is included in `public/favicon.svg`.
- The search may fail because the public Overpass instance is overloaded; errors are shown on the map and results panel.
