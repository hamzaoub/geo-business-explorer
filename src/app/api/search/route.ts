import { NextRequest, NextResponse } from "next/server";
import { normalizePolygon, polygonBounds, PolygonError } from "@/lib/geo";
import { discoverBusinesses, UpstreamError } from "@/lib/overpass";
import { discoverOverture } from "@/lib/overture";
import { discoverGeoapify } from "@/lib/geoapify";
import { discoverGooglePlaces } from "@/lib/google-places";
import { mergeBusinesses } from "@/lib/merge";
import type { Category, DataAttribution, SearchGoal, SearchProvider, SearchResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CATEGORIES = new Set<Category>(["all", "food", "retail", "services", "health", "stay"]);
const PROVIDERS = new Set<SearchProvider>(["osm", "overture", "both", "geoapify", "google"]);
const cooldowns = new Map<string, number>();

const ATTRIBUTION: Record<"osm" | "overture" | "geoapify" | "google", DataAttribution> = {
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
  geoapify: {
    name: "Geoapify Places",
    license: "OpenStreetMap ODbL 1.0; Geoapify terms and attribution apply",
    attribution: "Powered by Geoapify · © OpenStreetMap contributors",
    url: "https://www.geoapify.com/terms-and-conditions/",
  },
  google: {
    name: "Google Maps",
    license: "Google Maps Platform Terms; no bulk extraction, storage or independent exports",
    attribution: "Google Maps",
    url: "https://developers.google.com/maps/documentation/places/web-service/policies",
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
  if (now - (cooldowns.get(key) ?? 0) < 6_000) {
    return respondError("Please wait a few seconds before starting another search.", 429);
  }

  try {
    const raw = await request.text();
    if (raw.length > 20_000) return respondError("Request is too large.", 413);
    const body: unknown = JSON.parse(raw);
    if (!body || typeof body !== "object") return respondError("Invalid search request.", 400);
    const input = body as Record<string, unknown>;
    const category = (input.category ?? "all") as Category;
    const provider = (input.provider ?? "osm") as SearchProvider;
    const goal = (input.goal ?? "general") as SearchGoal;
    if (!CATEGORIES.has(category)) return respondError("Unknown business category.", 400);
    if (!PROVIDERS.has(provider)) return respondError("Unknown data provider.", 400);
    if (goal !== "general" && goal !== "it") return respondError("Unknown search goal.", 400);
    if (goal === "it" && (provider !== "google" || category !== "all")) {
      return respondError("IT employer preset requires Google Places with All businesses.", 400);
    }
    if ((provider === "overture" || provider === "both") && !process.env.OVERTURE_SERVICE_URL) {
      return respondError("Overture is not configured. Set OVERTURE_SERVICE_URL on the server.", 503);
    }
    const polygon = normalizePolygon(input.polygon);
    const bounds = polygonBounds(polygon);
    if ((provider === "overture" || provider === "both") && bounds.approximateKm2 > 200) {
      return respondError("Overture preview searches are limited to 200 km². Select a smaller area or use OpenStreetMap.", 400);
    }
    if (provider === "google" && !process.env.GOOGLE_PLACES_API_KEY) {
      return respondError("Add GOOGLE_PLACES_API_KEY to .env.local to enable Google Places.", 503);
    }
    cooldowns.set(key, now);
    type DataProvider = "osm" | "overture" | "geoapify" | "google";
    const requested: DataProvider[] = provider === "both" ? ["osm", "overture"] : [provider];
    async function searchSource(p: DataProvider) {
      if (p === "overture") {
        return { result: await discoverOverture(polygon, bounds, category), source: p, fallback: false };
      }
      if (p === "geoapify") {
        return { result: await discoverGeoapify(polygon, bounds, category), source: p, fallback: false };
      }
      if (p === "google") {
        return {
          result: await discoverGooglePlaces(polygon, bounds, category, {
            expanded: input.googleExpanded === true,
            goal,
          }),
          source: p,
          fallback: false,
        };
      }
      try {
        return { result: await discoverBusinesses(polygon, bounds, category), source: p, fallback: false };
      } catch (error) {
        // An independently hosted Places API can save searches when public Overpass is down.
        // Never evade a 429 rate limit with a fallback provider.
        if (!process.env.GEOAPIFY_API_KEY || !(error instanceof UpstreamError) || error.status === 429) {
          throw error;
        }
        return {
          result: await discoverGeoapify(polygon, bounds, category),
          source: "geoapify" as const,
          fallback: true,
        };
      }
    }
    const outcomes = await Promise.allSettled(requested.map(searchSource));
    const warnings: string[] = [];
    const groups = [];
    const sources: DataAttribution[] = [];
    let truncated = false;
    let googleRequestCount: number | undefined;
    let firstError: unknown;
    for (let i = 0; i < outcomes.length; i++) {
      const outcome = outcomes[i];
      if (outcome.status === "fulfilled") {
        groups.push(outcome.value.result.businesses);
        truncated = truncated || outcome.value.result.truncated;
        if (outcome.value.source === "google" && "requestCount" in outcome.value.result) {
          googleRequestCount = outcome.value.result.requestCount as number;
        }
        if ("warning" in outcome.value.result && typeof outcome.value.result.warning === "string") {
          warnings.push(outcome.value.result.warning);
        }
        if (!sources.some((s) => s.name === ATTRIBUTION[outcome.value.source].name)) {
          sources.push(ATTRIBUTION[outcome.value.source]);
        }
        if (outcome.value.fallback) warnings.push(
          "Public Overpass was unavailable; results came from Geoapify Places.",
        );
      } else {
        firstError ??= outcome.reason;
        warnings.push(requested[i].toUpperCase() + " data could not be retrieved.");
      }
    }
    if (sources.length === 0) {
      const upstream = firstError instanceof UpstreamError ? firstError : null;
      const hint = provider === "osm" && !process.env.GEOAPIFY_API_KEY && upstream?.status === 503
        ? " To use an independent search provider, add GEOAPIFY_API_KEY to .env.local and restart."
        : "";
      return respondError((upstream?.message || "All business data sources failed.") + hint, upstream?.status || 502);
    }
    if (warnings.length) truncated = true;
    // Google is deliberately a separate live-view provider, never merged with OSM
    // or Overture and never cached by the business search implementation.
    if (provider === "google") {
      warnings.push(
        "Google returns at most 20 places per Nearby Search request. " +
        "Opt-in multi-category live lookups can show more distinct places, but cannot enumerate " +
        "all businesses. The search circle may extend beyond your drawn rectangle. " +
        "Google results are not stored or exportable.",
      );
    }
    const businesses = provider === "google" ? groups.flat() : mergeBusinesses(groups);
    const payload: SearchResponse = {
      businesses,
      count: businesses.length,
      truncated,
      searchedAt: new Date().toISOString(),
      provider,
      sources,
      warnings,
      ...(provider === "google" && googleRequestCount
        ? { requestCount: googleRequestCount }
        : {}),
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
