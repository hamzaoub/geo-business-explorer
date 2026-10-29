import { NextRequest, NextResponse } from "next/server";
import { normalizePolygon, polygonBounds, PolygonError } from "@/lib/geo";
import { discoverBusinesses, UpstreamError } from "@/lib/overpass";
import { discoverOverture } from "@/lib/overture";
import { mergeBusinesses } from "@/lib/merge";
import type { Category, DataAttribution, SearchProvider, SearchResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CATEGORIES = new Set<Category>(["all", "food", "retail", "services", "health", "stay"]);
const PROVIDERS = new Set<SearchProvider>(["osm", "overture", "both"]);
const cooldowns = new Map<string, number>();

const ATTRIBUTION: Record<"osm" | "overture", DataAttribution> = {
  osm: {
    name: "OpenStreetMap",
    license: "ODbL 1.0",
    attribution: "© OpenStreetMap contributors",
    url: "https://www.openstreetmap.org/copyright",
  },
  overture: {
    name: "Overture Maps",
    license: "Source-dependent; review Overture Places licenses",
    attribution: "© Overture Maps Foundation and its data providers",
    url: "https://docs.overturemaps.org/guides/places/",
  },
};

function respondError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: NextRequest) {
  // Prototype-only per-process throttle, NOT a production distributed rate limiter.
  const key = (request.headers.get("x-forwarded-for") || "anonymous").split(",")[0].trim();
  const now = Date.now();
  if (cooldowns.size > 2000) {
    for (const [id, at] of cooldowns) if (now - at > 60_000) cooldowns.delete(id);
  }
  if (now - (cooldowns.get(key) ?? 0) < 12_000) {
    return respondError("Please wait 12 seconds before starting another search.", 429);
  }

  try {
    const raw = await request.text();
    if (raw.length > 20_000) return respondError("Request is too large.", 413);
    const body: unknown = JSON.parse(raw);
    if (!body || typeof body !== "object") return respondError("Invalid search request.", 400);
    const input = body as Record<string, unknown>;
    const category = (input.category ?? "all") as Category;
    const provider = (input.provider ?? "osm") as SearchProvider;
    if (!CATEGORIES.has(category)) return respondError("Unknown business category.", 400);
    if (!PROVIDERS.has(provider)) return respondError("Unknown data provider.", 400);
    if (provider !== "osm" && !process.env.OVERTURE_SERVICE_URL) {
      return respondError("Overture is not configured. Set OVERTURE_SERVICE_URL on the server.", 503);
    }
    const polygon = normalizePolygon(input.polygon);
    const bounds = polygonBounds(polygon);
    if (provider !== "osm" && bounds.approximateKm2 > 200) {
      return respondError("Overture preview searches are limited to 200 km². Select a smaller area or use OpenStreetMap.", 400);
    }
    cooldowns.set(key, now);
    const requested = provider === "both" ? ["osm", "overture"] as const : [provider] as const;
    const outcomes = await Promise.allSettled(requested.map((p) => p === "osm"
      ? discoverBusinesses(polygon, bounds, category)
      : discoverOverture(polygon, bounds, category)));
    const warnings: string[] = [];
    const groups = [];
    const sources: DataAttribution[] = [];
    let truncated = false;
    let firstError: unknown;
    for (let i = 0; i < outcomes.length; i++) {
      const outcome = outcomes[i];
      if (outcome.status === "fulfilled") {
        groups.push(outcome.value.businesses);
        truncated = truncated || outcome.value.truncated;
        sources.push(ATTRIBUTION[requested[i]]);
      } else {
        firstError ??= outcome.reason;
        warnings.push(requested[i].toUpperCase() + " data could not be retrieved.");
      }
    }
    if (sources.length === 0) {
      const upstream = firstError instanceof UpstreamError ? firstError : null;
      return respondError(upstream?.message || "All business data sources failed.", upstream?.status || 502);
    }
    if (warnings.length) truncated = true;
    const businesses = mergeBusinesses(groups);
    const payload: SearchResponse = {
      businesses,
      count: businesses.length,
      truncated,
      searchedAt: new Date().toISOString(),
      provider,
      sources,
      warnings,
    };
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof PolygonError || error instanceof SyntaxError) {
      return respondError(error instanceof PolygonError ? error.message : "Invalid JSON request.", 400);
    }
    if (error instanceof UpstreamError) return respondError(error.message, error.status);
    console.error("Business search failed", error);
    return respondError("Unable to complete your search.", 500);
  }
}
