import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(
    { providers: { osm: true, overture: Boolean(process.env.OVERTURE_SERVICE_URL) },
      geocoder: Boolean(process.env.GEOCODER_CONTACT_EMAIL) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
