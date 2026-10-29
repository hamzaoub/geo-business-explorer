import { pointInPolygon, type Bounds } from "./geo";
import type { Business, Category, Position } from "./types";
import { UpstreamError } from "./overpass";

interface OvertureRow {
  id: string;
  name: string;
  category: string | null;
  website: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  latitude: number;
  longitude: number;
  confidence: number | null;
}

interface OverturePayload {
  businesses: OvertureRow[];
  truncated: boolean;
  release: string;
}

const CATEGORY_TESTS: Record<Exclude<Category, "all">, RegExp> = {
  food: /restaurant|caf[eé]|coffee|bakery|bar|pub|diner|food|pizz|beverage|tea|dessert|catering/i,
  retail: /shop|store|retail|market|supermarket|grocery|boutique|bakery|pharmacy/i,
  services: /salon|hair|beauty|repair|consult|office|agency|account|lawyer|plumb|electric|service|software|marketing|spa/i,
  health: /clinic|hospital|doctor|dentist|pharmacy|medical|health|veterinar|optometr/i,
  stay: /hotel|motel|inn|hostel|lodg|accommodation|guest.house|resort/i,
};

function cleanText(value: unknown): string | null {
  return typeof value === "string" ? value.trim().slice(0, 300) || null : null;
}

function cleanWebsite(value: unknown): string | null {
  const raw = cleanText(value);
  if (!raw || /\s/.test(raw)) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw);
    return ["http:", "https:"].includes(url.protocol) && url.hostname.includes(".")
      ? url.toString() : null;
  } catch { return null; }
}

function groupFor(category: string): Business["categoryGroup"] {
  if (CATEGORY_TESTS.food.test(category)) return "food";
  if (CATEGORY_TESTS.health.test(category)) return "health";
  if (CATEGORY_TESTS.stay.test(category)) return "stay";
  if (CATEGORY_TESTS.services.test(category)) return "services";
  if (CATEGORY_TESTS.retail.test(category)) return "retail";
  return "other";
}

export function normalizeOvertureRow(
  row: OvertureRow,
  polygon: Position[],
  category: Category,
): Business | null {
  if (!row || typeof row.id !== "string" || typeof row.name !== "string" ||
      !Number.isFinite(row.latitude) || !Number.isFinite(row.longitude) ||
      !pointInPolygon([row.longitude, row.latitude], polygon)) return null;
  const categoryName = cleanText(row.category) || "business";
  if (category !== "all" && !CATEGORY_TESTS[category].test(categoryName)) return null;
  return {
    id: "overture/" + row.id,
    name: row.name.trim().slice(0, 250),
    category: categoryName.replace(/_/g, " "),
    categoryGroup: groupFor(categoryName),
    website: cleanWebsite(row.website),
    phone: cleanText(row.phone),
    email: cleanText(row.email),
    address: cleanText(row.address),
    city: cleanText(row.city),
    location: { latitude: row.latitude, longitude: row.longitude },
    source: "overture",
    sourceUrl: "https://explore.overturemaps.org/",
    sources: ["overture"],
    confidence: typeof row.confidence === "number" &&
      row.confidence >= 0 && row.confidence <= 1 ? row.confidence : null,
  };
}

export async function discoverOverture(
  polygon: Position[],
  bounds: Bounds,
  category: Category,
): Promise<{ businesses: Business[]; truncated: boolean; release: string }> {
  const rawUrl = process.env.OVERTURE_SERVICE_URL;
  if (!rawUrl) {
    throw new UpstreamError(
      "Overture is not configured. Start the Overture worker and set OVERTURE_SERVICE_URL.",
      503,
    );
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55_000);
  let response: Response;
  try {
    response = await fetch(new URL("/search", rawUrl).toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.OVERTURE_WORKER_KEY
          ? { "X-Worker-Key": process.env.OVERTURE_WORKER_KEY } : {}),
      },
      body: JSON.stringify({ bounds, category }),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch {
    throw new UpstreamError("Overture search worker is unavailable or timed out.", 503);
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new UpstreamError(
      response.status === 401 ? "Overture worker authorization failed." :
      "Overture search failed; check the worker logs.", 503,
    );
  }
  let data: OverturePayload;
  try { data = await response.json(); }
  catch { throw new UpstreamError("Overture worker returned invalid JSON.", 502); }
  if (!data || !Array.isArray(data.businesses) || typeof data.truncated !== "boolean") {
    throw new UpstreamError("Overture worker returned an invalid search response.", 502);
  }
  const records = data.businesses
    .map((row) => normalizeOvertureRow(row, polygon, category))
    .filter((row): row is Business => row !== null);
  return {
    businesses: records,
    truncated: data.truncated,
    release: typeof data.release === "string" ? data.release : "unknown",
  };
}
