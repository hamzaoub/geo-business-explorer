import { pointInPolygon, type Bounds } from "./geo";
import { UpstreamError } from "./overpass";
import type { Business, Category, Position } from "./types";

// Google Places API (New): one explicitly user-initiated nearby search per
// selection. No automatic crawling, pagination, persistence or export.
export const GOOGLE_NEARBY_URL = "https://places.googleapis.com/v1/places:searchNearby";
export const GOOGLE_MAX_RESULTS = 20;
export const GOOGLE_FIELD_MASK_BASE = [
  "places.id", "places.displayName", "places.formattedAddress",
  "places.location", "places.primaryType", "places.types",
  "places.googleMapsUri", "places.attributions",
].join(",");
const CONTACT_FIELDS = ",places.internationalPhoneNumber,places.websiteUri";
const CATEGORY_TYPES: Partial<Record<Category, string[]>> = {
  food: ["restaurant", "cafe", "bakery", "bar"],
  retail: ["store"],
  health: ["hospital", "pharmacy", "doctor", "dentist"],
  stay: ["hotel", "motel"],
};

interface GooglePlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  primaryType?: string;
  types?: string[];
  googleMapsUri?: string;
  websiteUri?: string;
  internationalPhoneNumber?: string;
  attributions?: Array<{ provider?: string; providerUri?: string }>;
}

function metersBetween(a: {latitude:number; longitude:number}, b: {latitude:number; longitude:number}): number {
  const radians = Math.PI / 180;
  const latA = a.latitude * radians, latB = b.latitude * radians;
  const dLat = (b.latitude - a.latitude) * radians;
  const dLon = (b.longitude - a.longitude) * radians;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(latA) * Math.cos(latB) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function googleSearchCircle(bounds: Bounds): {
  center: { latitude: number; longitude: number };
  radius: number;
} {
  const center = {
    latitude: (bounds.north + bounds.south) / 2,
    longitude: (bounds.west + bounds.east) / 2,
  };
  const corners = [
    { latitude: bounds.north, longitude: bounds.east },
    { latitude: bounds.north, longitude: bounds.west },
    { latitude: bounds.south, longitude: bounds.east },
    { latitude: bounds.south, longitude: bounds.west },
  ];
  const radius = Math.ceil(Math.max(...corners.map(corner => metersBetween(center, corner))) + 10);
  if (radius > 50000) {
    throw new UpstreamError(
      "Google Places Nearby Search supports a circle of up to 50 km radius. Select a smaller area.",
      400,
    );
  }
  return { center, radius: Math.max(1, radius) };
}

export function googleNearbyRequest(bounds: Bounds, category: Category): object {
  const body: {
    locationRestriction: {circle: ReturnType<typeof googleSearchCircle>};
    maxResultCount: number;
    rankPreference: "POPULARITY";
    includedTypes?: string[];
  } = {
    locationRestriction: { circle: googleSearchCircle(bounds) },
    maxResultCount: GOOGLE_MAX_RESULTS,
    rankPreference: "POPULARITY",
  };
  if (CATEGORY_TYPES[category]) body.includedTypes = CATEGORY_TYPES[category];
  return body;
}

function safeLink(value: string | undefined, id: string): string {
  try {
    if (value) {
      const parsed = new URL(value);
      if (parsed.protocol === "https:" && (
        parsed.hostname === "google.com" ||
        parsed.hostname === "www.google.com" ||
        parsed.hostname === "maps.google.com" ||
        parsed.hostname.endsWith(".google.com")
      )) return parsed.toString();
    }
  } catch { /* return canonical Google Maps link */ }
  return "https://www.google.com/maps/place/?q=place_id:" + encodeURIComponent(id);
}

export function googlePlaceToBusiness(
  place: GooglePlace, polygon: Position[],
): Business | null {
  const lat = place.location?.latitude;
  const lon = place.location?.longitude;
  if (!place.id || !place.displayName?.text ||
      typeof lat !== "number" || typeof lon !== "number" ||
      !Number.isFinite(lat) || !Number.isFinite(lon) ||
      !pointInPolygon([lon, lat], polygon)) return null;
  const type = place.primaryType || "business";
  const categoryGroup: Business["categoryGroup"] =
    /restaurant|cafe|bakery|bar|food|meal/.test(type) ? "food" :
    /hospital|pharmacy|doctor|dentist|clinic|medical/.test(type) ? "health" :
    /hotel|motel|lodging|hostel/.test(type) ? "stay" :
    /store|shop|supermarket|mall/.test(type) ? "retail" :
    /lawyer|accounting|agency|office|service/.test(type) ? "services" : "other";
  const website = place.websiteUri;
  let safeWebsite: string | null = null;
  try {
    if (website && /^https?:\/\//i.test(website)) {
      const parsed = new URL(website);
      if (parsed.hostname) safeWebsite = parsed.toString();
    }
  } catch { /* no website */ }
  return {
    id: "google/" + place.id,
    name: place.displayName.text.slice(0, 250),
    category: type.replaceAll("_", " "),
    categoryGroup,
    website: safeWebsite,
    phone: place.internationalPhoneNumber?.slice(0, 250) || null,
    email: null, // The Places Nearby API does not return business emails.
    address: place.formattedAddress?.slice(0, 300) || null,
    city: null,
    location: { latitude: lat, longitude: lon },
    source: "google_places",
    sourceUrl: safeLink(place.googleMapsUri, place.id),
    sources: ["google_places"],
    confidence: null,
  };
}

export async function discoverGooglePlaces(
  polygon: Position[], bounds: Bounds, category: Category,
  options: { apiKey?: string; includeContacts?: boolean; fetcher?: typeof fetch } = {},
): Promise<{ businesses: Business[]; truncated: boolean }> {
  const key = options.apiKey ?? process.env.GOOGLE_PLACES_API_KEY?.trim();
  if (!key) throw new UpstreamError("Google Places API key is not configured.", 503);
  const includeContacts = options.includeContacts ??
    process.env.GOOGLE_PLACES_INCLUDE_CONTACTS === "true";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 16000);
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(GOOGLE_NEARBY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": GOOGLE_FIELD_MASK_BASE + (includeContacts ? CONTACT_FIELDS : ""),
      },
      body: JSON.stringify(googleNearbyRequest(bounds, category)),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch {
    throw new UpstreamError("Google Places did not respond. Check network or API setup.", 503);
  } finally {
    clearTimeout(timeout);
  }
  if (response.status === 400) {
    throw new UpstreamError(
      "Google Places rejected the search request. Check Places API (New) enablement and selection size.", 400,
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new UpstreamError(
      "Google Places API key or billing is not enabled or authorized. Check Google Cloud credentials.", 503,
    );
  }
  if (response.status === 429) {
    throw new UpstreamError("Google Places quota exceeded. Check Google Cloud quotas and billing.", 429);
  }
  if (!response.ok) throw new UpstreamError("Google Places returned HTTP " + response.status + ".", 503);
  let body: { places?: GooglePlace[] };
  try { body = await response.json(); } catch {
    throw new UpstreamError("Google Places returned invalid JSON.", 502);
  }
  // Google may return an empty object when zero places match.
  if (!body || typeof body !== "object" ||
      (body.places !== undefined && !Array.isArray(body.places))) {
    throw new UpstreamError("Google Places returned an unexpected response.", 502);
  }
  const places = body.places ?? [];
  const found = new Map<string, Business>();
  for (const item of places) {
    const normalized = googlePlaceToBusiness(item, polygon);
    if (normalized) found.set(normalized.id, normalized);
  }
  return { businesses: [...found.values()], truncated: places.length >= GOOGLE_MAX_RESULTS };
}
