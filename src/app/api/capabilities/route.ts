import { NextResponse } from "next/server";
import { googleLiveSearchPlan, GOOGLE_DEFAULT_MAX_REQUESTS } from "@/lib/google-places";

export const runtime = "nodejs";

export async function GET() {
  const maxRequests = Number(process.env.GOOGLE_PLACES_MAX_REQUESTS ?? GOOGLE_DEFAULT_MAX_REQUESTS);
  return NextResponse.json(
    { providers: { osm: true, overture: Boolean(process.env.OVERTURE_SERVICE_URL), geoapify: Boolean(process.env.GEOAPIFY_API_KEY), google: Boolean(process.env.GOOGLE_PLACES_API_KEY) },
      geocoder: Boolean(process.env.GEOCODER_CONTACT_EMAIL),
      google: {
        includeContacts: process.env.GOOGLE_PLACES_INCLUDE_CONTACTS === "true",
        requestBudget: googleLiveSearchPlan("all",true,maxRequests).length,
        automatic: maxRequests === 0,
      } },
    { headers: { "Cache-Control": "no-store" } },
  );
}
