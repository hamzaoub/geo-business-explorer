import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(
    { providers: { osm: true, overture: Boolean(process.env.OVERTURE_SERVICE_URL), geoapify: Boolean(process.env.GEOAPIFY_API_KEY) },
      geocoder: Boolean(process.env.GEOCODER_CONTACT_EMAIL) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
