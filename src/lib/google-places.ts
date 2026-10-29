import type { Bounds } from "./geo";
import { UpstreamError } from "./overpass";
import type { Business, Category, Position } from "./types";

// Google Places API (New): bounded, user-opted-in multi-category live discovery.
// No grid harvesting, prefetch, persistence, cross-provider mixing or export.
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
  services: ["corporate_office", "lawyer", "consultant", "insurance_agency", "real_estate_agency", "marketing_consultant"],
  health: ["hospital", "pharmacy", "doctor", "dentist"],
  stay: ["hotel", "motel", "hostel", "guest_house"],
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

export function googleNearbyRequest(bounds: Bounds, category: Category, types?: string[]): object {
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
  if (types) body.includedTypes = types;
  else if (CATEGORY_TYPES[category]) body.includedTypes = CATEGORY_TYPES[category];
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
  place: GooglePlace, _polygon: Position[],
): Business | null {
  const lat = place.location?.latitude;
  const lon = place.location?.longitude;
  if (!place.id || !place.displayName?.text ||
      typeof lat !== "number" || typeof lon !== "number" ||
      !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const type = place.primaryType || "business";
  const categoryGroup: Business["categoryGroup"] =
    /restaurant|cafe|bakery|bar|food|meal/.test(type) ? "food" :
    /hospital|pharmacy|doctor|dentist|clinic|medical/.test(type) ? "health" :
    /hotel|motel|lodging|hostel/.test(type) ? "stay" :
    /store|shop|supermarket|mall/.test(type) ? "retail" :
    /lawyer|accounting|agency|office|service|consultant/.test(type) ? "services" : "other";
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


export const GOOGLE_MAX_LIVE_REQUESTS = 6;
type GoogleRequestPlan = { category: Category; types?: string[]; label: string };

export function googleLiveSearchPlan(
  category: Category,
  expanded = false,
  maxRequests = GOOGLE_MAX_LIVE_REQUESTS,
): GoogleRequestPlan[] {
  const base: GoogleRequestPlan = { category, label: "Nearby places" };
  if (!expanded) return [base];
  // Different place categories are genuine separate user-visible discovery
  // intents. No geographic grid, recursive splitting or automatic harvesting.
  const extra: GoogleRequestPlan[] = category === "all"
    ? (["food", "retail", "services", "health", "stay"] as const)
        .map(item => ({ category: item, label: item }))
    : category === "food"
      ? [{category,types:["restaurant","cafe"],label:"Restaurants and cafés"},
         {category,types:["bakery","bar"],label:"Bakeries and bars"}]
    : category === "retail"
      ? [{category,types:["store"],label:"Retail stores"},
         {category,types:["shopping_mall"],label:"Shopping centres"}]
    : category === "services"
      ? [{category,types:["lawyer","insurance_agency"],label:"Professional services"},
         {category,types:["real_estate_agency","corporate_office"],label:"Business offices"}]
    : category === "health"
      ? [{category,types:["hospital","pharmacy"],label:"Hospitals and pharmacies"},
         {category,types:["doctor","dentist"],label:"Doctors and dentists"}]
    : [{category,types:["hotel","motel"],label:"Hotels and motels"},
       {category,types:["hostel","guest_house"],label:"Hostels and guest houses"}];
  const limit = Number.isFinite(maxRequests)
    ? Math.max(1, Math.min(GOOGLE_MAX_LIVE_REQUESTS, Math.floor(maxRequests)))
    : 1;
  return [base, ...extra].slice(0, limit);
}

export interface GoogleLiveResult {
  businesses: Business[];
  truncated: boolean;
  requestCount: number;
  warning?: string;
}

export async function discoverGooglePlaces(
  polygon: Position[], bounds: Bounds, category: Category,
  options: {
    apiKey?: string;
    includeContacts?: boolean;
    fetcher?: typeof fetch;
    expanded?: boolean;
    maxRequests?: number;
  } = {},
): Promise<GoogleLiveResult> {
  const key = options.apiKey ?? process.env.GOOGLE_PLACES_API_KEY?.trim();
  if (!key) throw new UpstreamError("Google Places API key is not configured.", 503);
  const includeContacts = options.includeContacts ??
    process.env.GOOGLE_PLACES_INCLUDE_CONTACTS === "true";
  const requestedMax = options.maxRequests ??
    Number(process.env.GOOGLE_PLACES_MAX_REQUESTS || GOOGLE_MAX_LIVE_REQUESTS);
  const plan = googleLiveSearchPlan(category, options.expanded === true, requestedMax);
  const fetcher = options.fetcher ?? fetch;
  const found = new Map<string, Business>();
  let cursor = 0;
  let requestCount = 0;
  let failedCount = 0;
  let fullCount = 0;
  let stopped = false;
  let failure: UpstreamError | null = null;

  const worker = async () => {
    while (!stopped && cursor < plan.length) {
      const job = plan[cursor++];
      requestCount++;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 16000);
      let response: Response;
      try {
        response = await fetcher(GOOGLE_NEARBY_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": key,
            "X-Goog-FieldMask": GOOGLE_FIELD_MASK_BASE + (includeContacts ? CONTACT_FIELDS : ""),
          },
          body: JSON.stringify(googleNearbyRequest(bounds, job.category, job.types)),
          signal: controller.signal,
          cache: "no-store",
        });
      } catch {
        failedCount++;
        failure ??= new UpstreamError("Google Places did not respond.", 503);
        continue;
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        failedCount++;
        const status = response.status === 429 ? 429 :
          response.status === 400 ? 400 : 503;
        failure ??= new UpstreamError(
          response.status === 429
            ? "Google Places quota exhausted; additional searches stopped."
            : response.status === 401 || response.status === 403
              ? "Google Places key/billing is invalid or unauthorized."
              : "Google Places search failed (HTTP " + response.status + ").",
          status,
        );
        // Stop additional calls on quota, bad API key, or invalid request;
        // do not retry through extra queries or change endpoints.
        if ([400, 401, 403, 429].includes(response.status)) stopped = true;
        continue;
      }

      let body: { places?: GooglePlace[] };
      try { body = await response.json(); }
      catch {
        failedCount++;
        failure ??= new UpstreamError("Google Places returned invalid JSON.", 502);
        continue;
      }
      if (!body || typeof body !== "object" ||
          (body.places !== undefined && !Array.isArray(body.places))) {
        failedCount++;
        failure ??= new UpstreamError("Google Places returned an unexpected response.", 502);
        continue;
      }
      const places = body.places ?? [];
      if (places.length >= GOOGLE_MAX_RESULTS) fullCount++;
      for (const place of places) {
        // Unique within this *live request*, not cached, saved or exported.
        // Google Places coordinates must not be used for polygon analysis.
        const record = googlePlaceToBusiness(place, polygon);
        if (record) found.set(record.id, record);
      }
    }
  };

  // At most two simultaneous paid calls, only after the user opts in.
  await Promise.all(Array.from({length: Math.min(2,plan.length)}, () => worker()));
  if (failure && failedCount === requestCount) throw failure;
  const truncated = fullCount > 0 || failedCount > 0 || plan.length > 1;
  const warning = failedCount > 0
    ? "Only " + (requestCount - failedCount) + " of " + requestCount +
      " Google searches succeeded. Live results are incomplete."
    : undefined;
  return {
    businesses: [...found.values()],
    truncated,
    requestCount,
    ...(warning ? { warning } : {}),
  };
}
