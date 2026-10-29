import type { Business, Category, DataAttribution, SearchResponse, SourceName } from "./types";

/** Parse a user-selected JSON file in memory, without calls to any Places provider. */
const LIMIT = 50_000;
const SUPPORTED_SOURCES: ReadonlySet<string> = new Set([
  "google_places", "geoapify", "openstreetmap", "overture",
]);
const CATEGORIES: ReadonlySet<string> = new Set(["food","retail","services","health","stay","other"]);

function object(value: unknown): Record<string,unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string,unknown> : null;
}
function string(value: unknown, limit = 400): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0,limit) : null;
}
function safeUrl(value: unknown): string | null {
  const input=string(value,2400);
  if (!input) return null;
  try {
    const url=new URL(input);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch { return null; }
}
function sourceName(value: unknown, id: string): SourceName | null {
  if (SUPPORTED_SOURCES.has(String(value))) return value as SourceName;
  if (id.startsWith("google/")) return "google_places";
  if (id.startsWith("geoapify/")) return "geoapify";
  if (id.startsWith("overture/")) return "overture";
  if (id.startsWith("node/") || id.startsWith("way/") || id.startsWith("relation/")) {
    return "openstreetmap";
  }
  return null;
}
export interface ImportedBusinesses {
  response: SearchResponse;
  rejected: number;
  duplicateIds: number;
  hasGoogleContent: boolean;
}
const SOURCE_ATTRIBUTION: Record<SourceName,DataAttribution> = {
  google_places: {
    name:"Google Maps",license:"Google Maps Platform terms; saved Places content is restricted",
    attribution:"Google Maps",
    url:"https://developers.google.com/maps/documentation/places/web-service/policies",
  },
  geoapify:{
    name:"Geoapify Places",license:"Geoapify terms and underlying data licenses apply",
    attribution:"Powered by Geoapify · © OpenStreetMap contributors",
    url:"https://www.geoapify.com/terms-and-conditions/",
  },
  openstreetmap:{
    name:"OpenStreetMap",license:"ODbL 1.0",
    attribution:"© OpenStreetMap contributors",
    url:"https://www.openstreetmap.org/copyright",
  },
  overture:{
    name:"Overture Maps",license:"Source-dependent; review Overture Places licenses",
    attribution:"© Overture Maps Foundation and data providers",
    url:"https://docs.overturemaps.org/guides/places/",
  },
};

export function parseSavedBusinesses(input: unknown): ImportedBusinesses {
  const root=object(input);
  if (!root || !Array.isArray(root.businesses)) {
    throw new Error('Invalid file: expected a JSON object with a "businesses" array.');
  }
  if (root.businesses.length > LIMIT) {
    throw new Error("This JSON file has more than 50,000 businesses. Split it into smaller files.");
  }
  const seen=new Set<string>();
  const businesses: Business[]=[];
  let rejected=0;
  let duplicateIds=0;
  for (const item of root.businesses) {
    const raw=object(item),id=string(raw?.id,350),name=string(raw?.name,250);
    const loc=object(raw?.location);
    const lat=loc?.latitude,lon=loc?.longitude;
    const source=id ? sourceName(raw?.source,id) : null;
    if (!raw || !id || !name || !source ||
      typeof lat !== "number" || typeof lon !== "number" ||
      !Number.isFinite(lat) || !Number.isFinite(lon) ||
      lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      rejected++;
      continue;
    }
    if (seen.has(id)) { duplicateIds++;continue; }
    seen.add(id);
    const group=string(raw.categoryGroup,32);
    const categoryGroup:Business["categoryGroup"] =
      group && CATEGORIES.has(group) ? group as Business["categoryGroup"] : "other";
    const rawSources=Array.isArray(raw.sources)?raw.sources:[source];
    const sources=[...new Set(rawSources.map(x=>sourceName(x,id)).filter(
      (x):x is SourceName=>Boolean(x),
    ))];
    if (!sources.includes(source)) sources.unshift(source);
    const category=string(raw.category,120)??"unknown";
    const website=safeUrl(raw.website);
    const sourceUrl=safeUrl(raw.sourceUrl) ??
      (source==="google_places"
        ? "https://www.google.com/maps/place/?q=place_id:"+encodeURIComponent(id.replace(/^google\//,""))
        : source==="openstreetmap" ? "https://www.openstreetmap.org/" + encodeURIComponent(id)
        : SOURCE_ATTRIBUTION[source].url);
    businesses.push({
      id,name,category,categoryGroup,website,
      phone:string(raw.phone,200),
      email:string(raw.email,350),
      address:string(raw.address,500),
      city:string(raw.city,150),
      location:{latitude:lat,longitude:lon},
      source,sourceUrl,sources,confidence:typeof raw.confidence==="number" &&
        Number.isFinite(raw.confidence)?raw.confidence:null,
    });
  }
  const uniqueSources=[...new Set(businesses.flatMap(b=>b.sources))];
  const hasGoogleContent=uniqueSources.includes("google_places");
  const provider:SearchResponse["provider"]=hasGoogleContent?"google":
    uniqueSources.length > 1?"both":
      uniqueSources[0]==="geoapify"?"geoapify":
      uniqueSources[0]==="overture"?"overture":"osm";
  const warnings:string[]=[];
  if (hasGoogleContent) warnings.push(
    "This file contains stored Google Places business details. Google's terms generally restrict " +
    "saving or rehosting those details. This viewer does not export Google data, " +
    "save it to search history, or place Google markers on OpenStreetMap.",
  );
  if (rejected)warnings.push(rejected+" invalid record(s) were skipped.");
  if (duplicateIds)warnings.push(duplicateIds+" duplicate ID(s) were skipped.");
  return {
    response:{
      businesses,count:businesses.length,truncated:Boolean(root.truncated),
      searchedAt:string(root.searchedAt,100)??new Date().toISOString(),
      provider,
      sources:uniqueSources.map(source=>SOURCE_ATTRIBUTION[source]),
      warnings,
    },
    rejected,duplicateIds,hasGoogleContent,
  };
}
