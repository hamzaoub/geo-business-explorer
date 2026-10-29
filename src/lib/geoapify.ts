import { pointInPolygon, type Bounds } from "./geo";
import type { Business, Category, Position } from "./types";
import { UpstreamError } from "./overpass";

const API_URL = "https://api.geoapify.com/v2/places";
const PAGE_SIZE = 500;
const CATEGORIES: Record<Category, string> = {
  all: "commercial,catering,office,service,healthcare,accommodation",
  food: "catering",
  retail: "commercial",
  services: "office,service",
  health: "healthcare",
  stay: "accommodation",
};
interface GeoapifyFeature {
  properties?: {
    name?: unknown; place_id?: unknown; categories?: unknown; formatted?: unknown;
    address_line1?: unknown; street?: unknown; housenumber?: unknown;
    city?: unknown; lon?: unknown; lat?: unknown; website?: unknown;
    phone?: unknown; email?: unknown;
    contact?: { website?: unknown; phone?: unknown; email?: unknown };
  };
  geometry?: { type?: string; coordinates?: unknown };
}
interface GeoapifyResponse { features?: GeoapifyFeature[]; }

function clean(value: unknown, max = 300): string | null {
  return typeof value === "string" ? value.trim().slice(0, max) || null : null;
}
function webUrl(value: unknown): string | null {
  const raw = clean(value);
  if (!raw || /\s/.test(raw)) return null;
  try {
    const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw);
    return ["http:", "https:"].includes(parsed.protocol) && parsed.hostname.includes(".")
      ? parsed.toString() : null;
  } catch { return null; }
}
function groupFor(category: string): Business["categoryGroup"] {
  if (category.startsWith("catering")) return "food";
  if (category.startsWith("commercial")) return "retail";
  if (category.startsWith("healthcare")) return "health";
  if (category.startsWith("accommodation")) return "stay";
  if (category.startsWith("office") || category.startsWith("service")) return "services";
  return "other";
}

export function buildGeoapifyUrl(bounds: Bounds, category: Category, key: string): URL {
  const url = new URL(API_URL);
  url.searchParams.set("categories", CATEGORIES[category]);
  url.searchParams.set("filter", "rect:" + [
    bounds.west, bounds.south, bounds.east, bounds.north,
  ].join(","));
  url.searchParams.set("limit", String(PAGE_SIZE));
  url.searchParams.set("apiKey", key);
  return url;
}

export function normalizeGeoapifyFeature(feature: GeoapifyFeature, polygon: Position[]): Business | null {
  const props = feature?.properties;
  const name = clean(props?.name, 250);
  const placeId = clean(props?.place_id, 200);
  if (!name || !placeId) return null;
  const coordinates = feature?.geometry?.coordinates;
  const lon = Array.isArray(coordinates) && typeof coordinates[0] === "number"
    ? coordinates[0] : props?.lon;
  const lat = Array.isArray(coordinates) && typeof coordinates[1] === "number"
    ? coordinates[1] : props?.lat;
  if (typeof lon !== "number" || typeof lat !== "number" ||
      !Number.isFinite(lon) || !Number.isFinite(lat) ||
      !pointInPolygon([lon, lat], polygon)) return null;
  const cats = Array.isArray(props?.categories)
    ? props.categories.filter((c): c is string => typeof c === "string")
    : [];
  const categoryName = cats.find((c) => c.includes(".")) || cats[0] || "business";
  const shortStreet = [clean(props?.housenumber), clean(props?.street)]
    .filter(Boolean).join(" ");
  const address = clean(props?.address_line1) || shortStreet ||
    clean(props?.formatted) || null;
  return {
    id: "geoapify/" + placeId,
    name,
    category: categoryName.replace(/[._]/g, " "),
    categoryGroup: groupFor(categoryName),
    website: webUrl(props?.website || props?.contact?.website),
    phone: clean(props?.phone || props?.contact?.phone),
    email: clean(props?.email || props?.contact?.email),
    address, city: clean(props?.city),
    location: { latitude: lat, longitude: lon },
    source: "geoapify",
    sourceUrl: "https://www.openstreetmap.org/copyright",
    sources: ["geoapify"],
    confidence: null,
  };
}

export async function discoverGeoapify(
  polygon: Position[], bounds: Bounds, category: Category,
  options: { apiKey?: string; fetcher?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ businesses: Business[]; truncated: boolean }> {
  const key = options.apiKey || process.env.GEOAPIFY_API_KEY?.trim();
  if (!key) throw new UpstreamError(
    "Geoapify Places is not configured. Add GEOAPIFY_API_KEY to .env.local and restart the server.", 503,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(buildGeoapifyUrl(bounds, category, key), {
      signal: controller.signal, cache: "no-store",
      headers: { "Accept": "application/json" },
    });
  } catch {
    throw new UpstreamError("Geoapify Places did not respond. Check your connection and try again.", 503);
  } finally {
    clearTimeout(timeout);
  }
  if (response.status === 401 || response.status === 403) {
    throw new UpstreamError("Geoapify API key is invalid or not permitted for Places API.", 502);
  }
  if (response.status === 429) {
    throw new UpstreamError("Geoapify rate limit reached. Wait and retry; check your usage quota.", 429);
  }
  if (!response.ok) {
    throw new UpstreamError("Geoapify Places returned HTTP " + response.status + ".", 503);
  }
  let data: GeoapifyResponse;
  try { data = await response.json(); }
  catch { throw new UpstreamError("Geoapify Places returned invalid JSON.", 502); }
  if (!Array.isArray(data?.features)) {
    throw new UpstreamError("Geoapify Places returned an unexpected response.", 502);
  }
  const found = new Map<string, Business>();
  for (const feature of data.features) {
    const item = normalizeGeoapifyFeature(feature, polygon);
    if (item) found.set(item.id, item);
  }
  return {
    businesses: [...found.values()].sort((a, b) => a.name.localeCompare(b.name)),
    truncated: data.features.length >= PAGE_SIZE,
  };
}
