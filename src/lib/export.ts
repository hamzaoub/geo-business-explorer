import type { Business, Position, SearchResponse } from "./types";

/**
 * Export only source data that permits downloadable datasets.
 * Google Places business details are live-only and cannot be exported.
 */
export function assertExportable(businesses: Business[], search: SearchResponse): void {
  if (search.provider === "google" ||
      search.sources.some(source => source.name === "Google Maps") ||
      businesses.some(b => b.source === "google_places" || b.sources.includes("google_places"))) {
    throw new Error(
      "Google Places business details cannot be exported. Search the selected area with an exportable source such as OpenStreetMap, Geoapify or an appropriately licensed Overture dataset.",
    );
  }
}

function download(text: string, name: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function exportFilename(search: SearchResponse, count: number, ext: "json" | "csv"): string {
  const date = new Date().toISOString().slice(0, 10);
  const provider = search.provider.replace(/[^a-z0-9-]/gi, "-");
  return "geoscout-" + provider + "-" + date + "-" + count + "-businesses." + ext;
}

/** One canonical export schema for both the in-app JSON viewer and downloads. */
export function buildJsonPayload(
  businesses: Business[],
  polygon: Position[] | null,
  search: SearchResponse,
) {
  assertExportable(businesses, search);
  return {
    schemaVersion: "1.1",
    exportedAt: new Date().toISOString(),
    searchedAt: search.searchedAt,
    count: businesses.length,
    completeness: search.truncated ? "partial" : "source-limited",
    truncated: search.truncated,
    provider: search.provider,
    sources: search.sources,
    warnings: search.warnings,
    selection: polygon ? { type: "Polygon" as const, coordinates: [polygon] } : null,
    businesses,
  };
}

export function exportJson(
  businesses: Business[],
  polygon: Position[] | null,
  search: SearchResponse,
) {
  download(
    JSON.stringify(buildJsonPayload(businesses, polygon, search), null, 2),
    exportFilename(search, businesses.length, "json"),
    "application/json;charset=utf-8",
  );
}

function quoteCsv(value: string | number | null): string {
  let text = String(value ?? "");
  // Prevent spreadsheet formula execution on opening CSV exports.
  if (typeof value === "string" && /^\s*[=+\-@]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

export const CSV_COLUMNS = [
  "id", "name", "category", "category_group", "website", "phone", "email",
  "address", "city", "latitude", "longitude", "source", "sources", "confidence",
  "source_url",
] as const;

/** Pure serializer: every supplied record, not merely the visible 25-row page. */
export function buildCsv(businesses: Business[], search: SearchResponse): string {
  assertExportable(businesses, search);
  const lines = [
    CSV_COLUMNS.map(quoteCsv).join(","),
    ...businesses.map(b => [
      b.id, b.name, b.category, b.categoryGroup, b.website, b.phone, b.email,
      b.address, b.city, b.location.latitude, b.location.longitude,
      b.source, b.sources.join(" + "), b.confidence, b.sourceUrl,
    ].map(quoteCsv).join(",")),
  ];
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}

export function exportCsv(businesses: Business[], search: SearchResponse) {
  download(
    buildCsv(businesses, search),
    exportFilename(search, businesses.length, "csv"),
    "text/csv;charset=utf-8",
  );
}
