import type { Position } from "./types";

export class PolygonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolygonError";
  }
}

function samePoint(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

export function normalizePolygon(value: unknown): Position[] {
  if (!Array.isArray(value) || value.length < 3 || value.length > 121) {
    throw new PolygonError("Draw a polygon with 3 to 120 vertices.");
  }
  const points: Position[] = value.map((item: unknown) => {
    if (!Array.isArray(item) || item.length !== 2) {
      throw new PolygonError("Polygon coordinates must be [longitude, latitude].");
    }
    const [lon, lat] = item;
    if (
      typeof lon !== "number" || typeof lat !== "number" ||
      !Number.isFinite(lon) || !Number.isFinite(lat) ||
      lon < -180 || lon > 180 || lat < -90 || lat > 90
    ) {
      throw new PolygonError("The polygon contains invalid geographic coordinates.");
    }
    return [lon, lat];
  });
  if (samePoint(points[0], points[points.length - 1])) points.pop();
  if (points.length < 3 || new Set(points.map((p) => p.join(","))).size < 3) {
    throw new PolygonError("A polygon needs at least 3 distinct vertices.");
  }
  points.push([...points[0]]);
  return points;
}

export interface Bounds {
  south: number;
  west: number;
  north: number;
  east: number;
  approximateKm2: number;
}

export function polygonBounds(polygon: Position[]): Bounds {
  const latitudes = polygon.map((p) => p[1]);
  const longitudes = polygon.map((p) => p[0]);
  const south = Math.min(...latitudes);
  const north = Math.max(...latitudes);
  const west = Math.min(...longitudes);
  const east = Math.max(...longitudes);
  const latitudeKm = (north - south) * 111.2;
  const longitudeKm = (east - west) * 111.2 * Math.cos(((south + north) / 2) * Math.PI / 180);
  const approximateKm2 = Math.abs(latitudeKm * longitudeKm);
  if (latitudeKm < 0.05 || longitudeKm < 0.05) {
    throw new PolygonError("The selected area is too small. Draw a larger polygon.");
  }
  if (east - west > 180 || approximateKm2 > 1800) {
    throw new PolygonError("The area is too large for a live search (maximum bounding box 1,800 km²). Zoom in or select a smaller area.");
  }
  return { south, west, north, east, approximateKm2 };
}

function pointOnSegment(p: Position, a: Position, b: Position): boolean {
  const cross = (p[1] - a[1]) * (b[0] - a[0]) - (p[0] - a[0]) * (b[1] - a[1]);
  if (Math.abs(cross) > 1e-10) return false;
  const dot = (p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1]);
  const len2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
  return dot >= -1e-10 && dot <= len2 + 1e-10;
}

export function pointInPolygon(point: Position, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (pointOnSegment(point, a, b)) return true;
    const crosses = (a[1] > point[1]) !== (b[1] > point[1]) &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0];
    if (crosses) inside = !inside;
  }
  return inside;
}
