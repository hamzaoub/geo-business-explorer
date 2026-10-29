import assert from "node:assert/strict";
import test from "node:test";
import { mergeBusinesses } from "./merge";
import type { Business } from "./types";

function business(id: string, lat: number, lon: number): Business {
  return {
    id, name: "Northside Coffee", category: "cafe", categoryGroup: "food",
    website: null, phone: null, email: null, address: null, city: null,
    location: { latitude: lat, longitude: lon },
    source: "openstreetmap", sourceUrl: "https://www.openstreetmap.org",
    sources: ["openstreetmap"], confidence: null,
  };
}
test("combines a nearby duplicate and keeps available fields", () => {
  const osm = business("n/1", 47.561, -52.713);
  const overture = {
    ...business("o/3", 47.5611, -52.7131),
    source: "overture" as const,
    sources: ["overture" as const],
    website: "https://coffee.example",
    confidence: 0.8,
  };
  const merged = mergeBusinesses([[osm], [overture]]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].website, "https://coffee.example");
  assert.deepEqual(merged[0].sources, ["openstreetmap", "overture"]);
});
test("keeps separate branches of a chain apart", () => {
  const merged = mergeBusinesses([[business("a", 47.561, -52.713),
    business("b", 47.57, -52.713)]]);
  assert.equal(merged.length, 2);
});
test("same coordinates with different names do not merge", () => {
  const a = business("a", 47.561, -52.713);
  const b = { ...business("b", 47.561, -52.713), name: "Different Coffee" };
  assert.equal(mergeBusinesses([[a, b]]).length, 2);
});
