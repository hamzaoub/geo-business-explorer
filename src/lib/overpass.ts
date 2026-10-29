import { pointInPolygon, type Bounds } from "./geo";
import type { Business, Category, Position } from "./types";

type Tags = Record<string, string>;

interface OsmElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Tags;
}

const MAX_ELEMENTS = 4000;
const OVERPASS_DEFAULT = "https://overpass-api.de/api/interpreter";
const TAGS = ["shop", "amenity", "office", "craft", "tourism", "healthcare"] as const;
const FOOD = new Set(["restaurant", "cafe", "fast_food", "bar", "pub", "food_court", "ice_cream", "biergarten"]);
const HEALTH = new Set(["pharmacy", "clinic", "hospital", "doctors", "dentist", "veterinary"]);
const STAY = new Set(["hotel", "motel", "hostel", "guest_house", "apartment", "chalet", "camp_site"]);

export class UpstreamError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "UpstreamError";
  }
}

function categoryQueries(category: Category): string[] {
  if (category === "food") {
    return [
      '["amenity"~"^(restaurant|cafe|fast_food|bar|pub|food_court|ice_cream|biergarten)$"]',
      '["shop"~"^(bakery|coffee|confectionery|deli|butcher|seafood|beverages)$"]',
    ];
  }
  if (category === "retail") return ['["shop"]'];
  if (category === "services") return ['["office"]', '["craft"]'];
  if (category === "health") return ['["healthcare"]', '["amenity"~"^(pharmacy|clinic|hospital|doctors|dentist|veterinary)$"]'];
  if (category === "stay") return ['["tourism"~"^(hotel|motel|hostel|guest_house|apartment|chalet|camp_site)$"]'];
  return TAGS.map((tag) => '["' + tag + '"]');
}

export function buildOverpassQuery(bounds: Bounds, category: Category): string {
  const coords = [bounds.south, bounds.west, bounds.north, bounds.east]
    .map((n) => n.toFixed(6)).join(",");
  const selectors = categoryQueries(category)
    .map((filter) => '  nwr["name"]' + filter + '(' + coords + ');');
  return '[out:json][timeout:35];\n(\n' + selectors.join('\n') +
    '\n);\nout center ' + MAX_ELEMENTS + ';';
}

function normalizeWebsite(value?: string): string | null {
  if (!value?.trim()) return null;
  const raw = value.split(/[;,]/)[0].trim();
  if (raw.length > 300 || /\s/.test(raw)) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw);
    return ["http:", "https:"].includes(url.protocol) && url.hostname.includes(".")
      ? url.toString() : null;
  } catch {
    return null;
  }
}

function groupFor(tags: Tags): Business["categoryGroup"] {
  if (tags.shop) return "retail";
  if (FOOD.has(tags.amenity)) return "food";
  if (HEALTH.has(tags.amenity) || tags.healthcare) return "health";
  if (tags.tourism && STAY.has(tags.tourism)) return "stay";
  if (tags.office || tags.craft) return "services";
  return "other";
}

function normalizeElement(element: OsmElement, polygon: Position[]): Business | null {
  const tags = element.tags;
  if (!tags?.name?.trim()) return null;
  const longitude = element.lon ?? element.center?.lon;
  const latitude = element.lat ?? element.center?.lat;
  if (longitude === undefined || latitude === undefined ||
      !pointInPolygon([longitude, latitude], polygon)) return null;
  const category = TAGS.map((tag) => tags[tag]).find(Boolean) || "business";
  const addressParts = [
    [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" "),
    tags["addr:city"] || tags["addr:place"],
    tags["addr:province"] || tags["addr:state"],
    tags["addr:postcode"],
  ].filter(Boolean);
  const cleanText = (value?: string) => value?.trim().slice(0, 250) || null;
  return {
    id: element.type + "/" + element.id,
    name: tags.name.trim().slice(0, 250),
    category: category.replace(/_/g, " "),
    categoryGroup: groupFor(tags),
    website: normalizeWebsite(tags.website || tags["contact:website"] || tags.url),
    phone: cleanText(tags.phone || tags["contact:phone"] || tags["phone:mobile"]),
    email: cleanText(tags.email || tags["contact:email"]),
    address: addressParts.length ? addressParts.join(", ") : null,
    city: cleanText(tags["addr:city"]),
    location: { latitude, longitude },
    source: "openstreetmap",
    sourceUrl: "https://www.openstreetmap.org/" + element.type + "/" + element.id,
    sources: ["openstreetmap"],
    confidence: null,
  };
}

/**
 * Public Overpass servers can be busy or temporarily unreachable. Retry a failed
 * network / 5xx response once against a different operator. Do not bypass 429
 * rate limits, and never silently move a custom private endpoint to a public
 * operator unless an explicit fallback is supplied.
 */
export function overpassEndpoints(
  primary = process.env.OVERPASS_URL?.trim() || OVERPASS_DEFAULT,
  fallback = process.env.OVERPASS_FALLBACK_URL?.trim(),
): string[] {
  const secondary = fallback === "none" ? null
    : fallback || (primary === OVERPASS_DEFAULT
      ? "https://overpass.private.coffee/api/interpreter" : null);
  return secondary && secondary !== primary ? [primary, secondary] : [primary];
}

type OverpassPayload = { elements: OsmElement[]; remark?: string };

export async function fetchOverpassPayload(
  query: string,
  options: {
    endpoints?: string[];
    fetcher?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<OverpassPayload> {
  const endpoints = options.endpoints ?? overpassEndpoints();
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 22_000;
  if (!endpoints.length) throw new UpstreamError("No Overpass server configured.", 503);
  const formData = new URLSearchParams({ data: query });
  for (let i = 0; i < endpoints.length; i++) {
    const endpoint = endpoints[i];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let reason = "unreachable";
    try {
      const response = await fetcher(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept": "application/json",
          "User-Agent": "GeoScout/0.3 (contact: " +
            (process.env.OVERPASS_CONTACT_EMAIL || "configure-OVERPASS_CONTACT_EMAIL") + ")",
        },
        body: formData.toString(),
        signal: controller.signal,
        cache: "no-store",
      });
      if (response.status === 429) {
        // Respect the server's rate limit: do not use another server to evade it.
        throw new UpstreamError(
          "OpenStreetMap's search service is rate limiting requests. Wait a moment and try a smaller region.",
          429,
        );
      }
      if (response.status === 400 || response.status === 422) {
        throw new UpstreamError(
          "The map data service rejected the query. Try a smaller region or report this error.",
          502,
        );
      }
      if (!response.ok) {
        reason = "HTTP " + response.status;
      } else {
        try {
          const body: unknown = await response.json();
          if (body && typeof body === "object" && "elements" in body &&
              Array.isArray((body as { elements: unknown }).elements) &&
              (body as { elements: unknown[] }).elements.length <= 5000 &&
              !("remark" in body &&
                typeof (body as { remark: unknown }).remark === "string" &&
                /(?:runtime|parse|error|timeout)/i.test(
                  (body as { remark: string }).remark))) {
            return body as OverpassPayload;
          }
          reason = "invalid or incomplete Overpass data";
        } catch {
          reason = "invalid JSON response";
        }
      }
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      reason = controller.signal.aborted ? "timed out" :
        error instanceof Error ? error.name : "network failure";
    } finally {
      clearTimeout(timer);
    }
    // Log only the operator hostname, never the selected user coordinates.
    try {
      console.warn("Overpass provider unavailable", {
        host: new URL(endpoint).hostname,
        reason,
        fallbackRemaining: i < endpoints.length - 1,
      });
    } catch { console.warn("Overpass provider unavailable", { reason }); }
  }
  throw new UpstreamError(
    "Both public OpenStreetMap search servers are busy or unreachable. Try a smaller area or retry later. You can also configure a dedicated Overpass server.",
    503,
  );
}

const CACHE_TTL_MS = 2 * 60_000;
const queryCache = new Map<string, {
  expiresAt: number;
  request: Promise<OverpassPayload>;
}>();

function cachedQuery(query: string, timeoutMs: number): Promise<OverpassPayload> {
  const now = Date.now();
  const cached = queryCache.get(query);
  if (cached && cached.expiresAt > now) return cached.request;
  if (queryCache.size > 100) {
    for (const [key, value] of queryCache) {
      if (value.expiresAt <= now) queryCache.delete(key);
    }
    if (queryCache.size > 100) queryCache.clear();
  }
  const request = fetchOverpassPayload(query, { timeoutMs });
  queryCache.set(query, { expiresAt: now + CACHE_TTL_MS, request });
  // Errors must not be cached: the next attempt should be able to retry.
  void request.catch(() => {
    if (queryCache.get(query)?.request === request) queryCache.delete(query);
  });
  return request;
}

export async function discoverBusinesses(
  polygon: Position[],
  bounds: Bounds,
  category: Category,
): Promise<{ businesses: Business[]; truncated: boolean }> {
  const query = buildOverpassQuery(bounds, category);
  const data = await cachedQuery(query, bounds.approximateKm2 > 150 ? 30_000 : 22_000);
  const unique = new Map<string, Business>();
  for (const element of data.elements) {
    const item = normalizeElement(element, polygon);
    if (!item) continue;
    // Collapse common node/way duplicates for the same establishment.
    const key = item.name.toLocaleLowerCase() + "|" +
      item.location.latitude.toFixed(4) + "|" + item.location.longitude.toFixed(4);
    const prior = unique.get(key);
    if (!prior || (!prior.website && item.website)) unique.set(key, item);
  }
  return {
    businesses: [...unique.values()].sort((a, b) => a.name.localeCompare(b.name)),
    truncated: data.elements.length >= MAX_ELEMENTS,
  };
}
