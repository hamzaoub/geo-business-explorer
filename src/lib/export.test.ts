import assert from "node:assert/strict";
import test from "node:test";
import { buildJsonPayload } from "./export";
import type { Business, SearchResponse } from "./types";

const business: Business = {
  id: "node/123",
  name: "Sample Local Company",
  category: "office",
  categoryGroup: "services",
  website: "https://example.org",
  phone: "+1-709-555-0100",
  email: null,
  address: "12 Example Avenue, St. John's",
  city: "St. John's",
  location: { latitude: 47.56, longitude: -52.71 },
  source: "openstreetmap",
  sourceUrl: "https://www.openstreetmap.org/node/123",
  sources: ["openstreetmap"],
  confidence: null,
};

const result: SearchResponse = {
  businesses: [business], count: 1, truncated: false,
  searchedAt: "2026-10-29T00:00:00.000Z", provider: "osm",
  sources: [{
    name: "OpenStreetMap",
    license: "ODbL 1.0",
    attribution: "© OpenStreetMap contributors",
    url: "https://www.openstreetmap.org/copyright",
  }],
  warnings: [],
};

test("JSON payload includes all business fields and selected coordinates", () => {
  const polygon: [number, number][] = [
    [-52.75, 47.54], [-52.7, 47.54], [-52.7, 47.6], [-52.75, 47.54],
  ];
  const output = buildJsonPayload([business], polygon, result);
  assert.equal(output.count, 1);
  assert.equal(output.schemaVersion, "1.0");
  assert.equal(output.selection?.type, "Polygon");
  assert.equal(output.businesses[0].name, "Sample Local Company");
  assert.equal(output.businesses[0].website, "https://example.org");
  assert.equal(output.businesses[0].phone, "+1-709-555-0100");
  assert.equal(output.businesses[0].email, null);
  assert.equal(output.businesses[0].location.longitude, -52.71);
  assert.equal(output.sources[0].license, "ODbL 1.0");
});

test("JSON payload warns about partial discovery", () => {
  const output = buildJsonPayload([business], null,
    { ...result, truncated: true });
  assert.equal(output.completeness, "partial");
  assert.equal(output.selection, null);
});
