import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface NominatimResult {
  display_name?: string;
  lat?: string;
  lon?: string;
  boundingbox?: string[];
}

const cache = new Map<string, { at: number; data: unknown }>();
let lastRequestAt = 0;
let busy = false;

export async function GET(request: NextRequest) {
  const contact = process.env.GEOCODER_CONTACT_EMAIL;
  if (!contact) {
    return NextResponse.json({ error: "Geocoding is not configured." }, { status: 503 });
  }
  const query = (request.nextUrl.searchParams.get("q") || "").trim();
  if (query.length < 3 || query.length > 120 || /[\x00-\x1f]/.test(query)) {
    return NextResponse.json({ error: "Enter a city or location (3–120 characters)." }, { status: 400 });
  }
  const key = query.toLocaleLowerCase();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < 86400000) return NextResponse.json(cached.data);
  // Prototype-only per-process global ceiling; deploy a shared limiter/cache for production.
  if (busy || Date.now() - lastRequestAt < 1200) {
    return NextResponse.json({ error: "Location search is busy. Try again in a moment." }, { status: 429 });
  }
  busy = true;
  lastRequestAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const url = new URL("/search", process.env.NOMINATIM_URL || "https://nominatim.openstreetmap.org");
    url.searchParams.set("q", query);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "1");
    url.searchParams.set("addressdetails", "0");
    const res = await fetch(url.toString(), {
      headers: {
        "User-Agent": "GeoScout/0.2 (contact: " + contact + ")",
        "Accept": "application/json",
      },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) throw new Error("Location provider unavailable");
    const items: NominatimResult[] = await res.json();
    const item = items[0];
    if (!item || !item.lat || !item.lon) {
      return NextResponse.json({ error: "No matching location found." }, { status: 404 });
    }
    const latitude = Number(item.lat);
    const longitude = Number(item.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new Error("Invalid location coordinates");
    }
    const data = {
      label: item.display_name ?? query,
      latitude,
      longitude,
      boundingbox: Array.isArray(item.boundingbox) ? item.boundingbox.map(Number) : null,
      attribution: "© OpenStreetMap contributors · Nominatim",
    };
    if (cache.size > 100) cache.clear();
    cache.set(key, { at: Date.now(), data });
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Unable to find that location right now." }, { status: 503 });
  } finally {
    clearTimeout(timer);
    busy = false;
  }
}
