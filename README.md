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

### Browser interaction regression tests

To test the real browser dragging interaction locally (requires Chromium):

~~~bash
npm install
npm run build
npx playwright install chromium
npm run test:e2e
~~~

GitHub Actions runs the same browser tests after the production build. The tests mock the business-search response to verify region-selection behavior without using public Overpass quotas; **live data coverage still needs a separate integration test**.


## Overpass connectivity and 503 errors

If selecting a map region returns HTTP 503, the **external Overpass search endpoint** may be unavailable, overloaded, blocked by your network, or unable to finish a large query. This is unrelated to browser extensions or the rectangle-selection UI.

GeoScout now uses two globally covering public Overpass endpoints for a small number of interactive searches: the default `overpass-api.de`, then `overpass.private.coffee` **only after** network failure, a server-side 5xx response, invalid data, or timeout. A 429 rate-limit response is respected and does **not** trigger an alternate request. Requests have per-operator deadlines, and successful bounding-box queries are cached in memory for two minutes to reduce load.

Customize your operator via `OVERPASS_URL`; set `OVERPASS_FALLBACK_URL` explicitly for a second provider. If you configure your own private `OVERPASS_URL`, there is **no silent automatic public fallback**; specify a backup deliberately. Set `OVERPASS_FALLBACK_URL=none` to disable fallback entirely.

For local debugging, stop and restart `npm run dev` after changing `.env.local`; Next.js does not automatically adopt all environment changes. Check your server terminal for `Overpass provider unavailable` logs. These report the failing operator and status/timeout reason without logging the selected coordinates.

The app displays an error when both providers fail; it never fabricates businesses. Public servers are intended for moderate, respectful use. For production reliability, deploy an indexed OSM/Overture source or use a contracted API. See the OpenStreetMap wiki's Overpass API server list.

Browser extension warning messages with `contentscript.js`, `ObjectMultiplex` or `data-lt-installed` usually originate outside the application. Test in a private browser window with extensions disabled. GeoScout suppresses root-element hydration warnings but does not alter any extension.

## Independent Geoapify Places provider (recommended for Overpass 503 failures)

Public Overpass availability is not guaranteed. GeoScout now supports Geoapify's **Places API** with a rectangle filter, as an independent provider. A free key is available from https://myprojects.geoapify.com/ (plan limits and credit usage apply). Set **GEOAPIFY_API_KEY** in **.env.local**, then restart **npm run dev**.

When the key is configured, Geoapify becomes the automatically selected provider. You can still choose OpenStreetMap; if public Overpass fails with a server error or timeout, GeoScout falls back to Geoapify. Rate limits (429) are not bypassed.

Geoapify returns places as GeoJSON. GeoScout checks every feature against your exact selected polygon, shows names, addresses, categories and any available website/phone/email fields, and preserves source attribution in JSON/CSV exports. The first 500 places are returned; if that cap is reached, the response is explicitly marked **partial**. This is not an exhaustive company registry. Per Geoapify's terms, display **Geoapify and OpenStreetMap attribution** whenever Geoapify records are used, and comply with ODbL for OpenStreetMap-derived data. Do not publish your server-side key in client code.

## Google Places API (New) — live option

GeoScout optionally supports the **Places API (New)**, using the official Nearby Search REST endpoint. In Google Cloud Console create a billing-enabled project, enable **Places API (New)** and create an API key restricted to that API:
- Setup: https://developers.google.com/maps/documentation/places/web-service/get-api-key
- Google Cloud credentials: https://console.cloud.google.com/apis/credentials
- Enable Places (New): https://console.cloud.google.com/apis/library/places.googleapis.com

In the project root create `.env.local` and add `GOOGLE_PLACES_API_KEY=YOUR_KEY`, then restart the Next.js server. The **Google Places** radio option becomes available automatically. To include phone numbers and website URLs, opt in to **GOOGLE_PLACES_INCLUDE_CONTACTS=true**; these fields increase the Google Places billing SKU (Nearby Search Enterprise rather than Pro). Google does not provide email addresses via Nearby Search.

Nearby Search (New) uses a **circle**, not a polygon: GeoScout derives a circle covering the selected rectangle, requests up to 20 Google Places and then filters locations to the exact selected area. There is one paid API request per explicit drag/re-search action. Results are **not exhaustive** and should never be treated as a complete business registry. Very large selections (>50 km circle radius) are rejected.

**Google Places data is presented in a separate live table-only view**, never as points on an OpenStreetMap map, because Google requires its Places content on Google maps if plotted on a map. GeoScout does not cache or store Google Places results, merge them with OSM records, or permit JSON/CSV downloads of Google's content. Display attribution **Google Maps** with the results. This matters because Google's Maps Platform terms restrict content storage, bulk extraction and reuse. Only place IDs have the specified caching exception. See https://developers.google.com/maps/documentation/places/web-service/policies and https://cloud.google.com/maps-platform/terms.

A commercial launch will also require compliant terms/privacy pages and potentially an official Google Maps logo asset in the results view. For bulk business-lead CSV exports, keep using OSM / Overture / appropriately licensed providers, not Google Places.
