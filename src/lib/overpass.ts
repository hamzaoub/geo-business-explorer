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

export async function discoverBusinesses(
  polygon: Position[],
  bounds: Bounds,
  category: Category,
): Promise<{ businesses: Business[]; truncated: boolean }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 40_000);
  let response: Response;
  try {
    response = await fetch(process.env.OVERPASS_URL || OVERPASS_DEFAULT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "GeoBusinessExplorer/0.1 (contact: " +
          (process.env.OVERPASS_CONTACT_EMAIL || "set-OVERPASS_CONTACT_EMAIL") + ")",
      },
      body: new URLSearchParams({ data: buildOverpassQuery(bounds, category) }),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch {
    throw new UpstreamError("The live map data service did not respond. Please try again.", 503);
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const message = response.status === 429
      ? "OpenStreetMap's public search service is rate-limiting requests. Please retry later."
      : "The map data service is temporarily unavailable.";
    throw new UpstreamError(message, response.status === 429 ? 429 : 502);
  }
  let data: { elements?: OsmElement[]; remark?: string };
  try {
    data = await response.json();
  } catch {
    throw new UpstreamError("The map data service returned an invalid response.", 502);
  }
  if (!Array.isArray(data.elements)) {
    throw new UpstreamError("The map data service did not return business records.", 502);
  }
  if (data.remark?.toLowerCase().includes("error")) {
    throw new UpstreamError("The map data search could not be completed.", 503);
  }
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
