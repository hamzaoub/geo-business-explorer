import type { Business, Position, SearchResponse } from "./types";

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

/** One canonical export schema for both the in-app JSON viewer and downloads. */
export function buildJsonPayload(
  businesses: Business[],
  polygon: Position[] | null,
  search: SearchResponse,
) {
  return {
    schemaVersion: "1.0",
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
    "geo-businesses.json",
    "application/json;charset=utf-8",
  );
}

function quoteCsv(value: string | number | null): string {
  let text = String(value ?? "");
  // Prevent formula execution when opening CSV data in spreadsheet programs.
  if (typeof value === "string" && /^\s*[=+\-@]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

export function exportCsv(businesses: Business[]) {
  const headers = ["name", "category", "website", "phone", "email", "address",
    "city", "latitude", "longitude", "sources", "confidence", "source_url"];
  const lines = [
    headers.map(quoteCsv).join(","),
    ...businesses.map((b) => [
      b.name, b.category, b.website, b.phone, b.email, b.address, b.city,
      b.location.latitude, b.location.longitude, b.sources.join(" + "), b.confidence, b.sourceUrl,
    ].map(quoteCsv).join(",")),
  ];
  download(lines.join("\r\n"), "geo-businesses.csv", "text/csv;charset=utf-8");
}
