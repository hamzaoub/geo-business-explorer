import type { Business, SourceName } from "./types";

function normalizedName(name: string): string {
  return name.normalize("NFKD").toLocaleLowerCase()
    .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function distanceMeters(a: Business, b: Business): number {
  const lat1 = a.location.latitude * Math.PI / 180;
  const lat2 = b.location.latitude * Math.PI / 180;
  const dLat = lat2 - lat1;
  const dLon = (b.location.longitude - a.location.longitude) * Math.PI / 180;
  const arc = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 12742000 * Math.asin(Math.min(1, Math.sqrt(arc)));
}

function shouldMerge(a: Business, b: Business): boolean {
  if (normalizedName(a.name) !== normalizedName(b.name)) return false;
  if (normalizedName(a.name).length < 3) return false;
  // Keep distinct branches of a chain separate.
  return distanceMeters(a, b) <= 45;
}

function mergePair(a: Business, b: Business): Business {
  const primary = a.confidence !== null && a.confidence >= (b.confidence ?? -1)
    ? a : b;
  const secondary = primary === a ? b : a;
  const sources = [...new Set<SourceName>([...a.sources, ...b.sources])];
  return {
    ...primary,
    website: primary.website || secondary.website,
    phone: primary.phone || secondary.phone,
    email: primary.email || secondary.email,
    address: primary.address || secondary.address,
    city: primary.city || secondary.city,
    category: primary.category === "business" ? secondary.category : primary.category,
    categoryGroup: primary.categoryGroup === "other" ? secondary.categoryGroup : primary.categoryGroup,
    sources,
    confidence: a.confidence === null ? b.confidence : b.confidence === null
      ? a.confidence : Math.max(a.confidence, b.confidence),
  };
}

export function mergeBusinesses(groups: Business[][]): Business[] {
  const output: Business[] = [];
  // Build a coarse grid index to reduce nearby duplicate comparisons.
  const buckets = new Map<string, number[]>();
  const key = (lat: number, lon: number) => Math.floor(lat * 1000) + ":" + Math.floor(lon * 1000);
  for (const business of groups.flat()) {
    if (!Number.isFinite(business.location.latitude) ||
        !Number.isFinite(business.location.longitude)) continue;
    const { latitude, longitude } = business.location;
    const y = Math.floor(latitude * 1000), x = Math.floor(longitude * 1000);
    let matchingIndex = -1;
    for (let dy = -1; dy <= 1 && matchingIndex === -1; dy++) {
      for (let dx = -1; dx <= 1 && matchingIndex === -1; dx++) {
        for (const index of buckets.get((y + dy) + ":" + (x + dx)) ?? []) {
          if (shouldMerge(output[index], business)) {
            matchingIndex = index;
            break;
          }
        }
      }
    }
    if (matchingIndex !== -1) {
      output[matchingIndex] = mergePair(output[matchingIndex], business);
    } else {
      const index = output.push(business) - 1;
      const cell = key(latitude, longitude);
      buckets.set(cell, [...(buckets.get(cell) || []), index]);
    }
  }
  return output.sort((a, b) => a.name.localeCompare(b.name));
}
