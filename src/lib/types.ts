export type Position = [longitude: number, latitude: number];
export type Category = "all" | "food" | "retail" | "services" | "health" | "stay";
export type WebsiteFilter = "all" | "with" | "without";
export type SearchProvider = "osm" | "overture" | "both" | "geoapify";
export type SourceName = "openstreetmap" | "overture" | "geoapify";

export interface Business {
  id: string;
  name: string;
  category: string;
  categoryGroup: Exclude<Category, "all"> | "other";
  website: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  location: { latitude: number; longitude: number };
  source: SourceName;
  sourceUrl: string;
  sources: SourceName[];
  confidence: number | null;
}

export interface DataAttribution {
  name: string;
  license: string;
  attribution: string;
  url: string;
}

export interface SearchResponse {
  businesses: Business[];
  count: number;
  truncated: boolean;
  searchedAt: string;
  provider: SearchProvider;
  sources: DataAttribution[];
  warnings: string[];
}
