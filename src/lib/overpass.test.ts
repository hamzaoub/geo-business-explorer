import assert from "node:assert/strict";
import test from "node:test";
import { buildOverpassQuery } from "./overpass";

const bounds = { south: 47.5, west: -52.8, north: 47.6, east: -52.7, approximateKm2: 83 };

test("formats a valid geographic bounding box", () => {
  const query = buildOverpassQuery(bounds, "all");
  assert.match(query, /\(47\.500000,-52\.800000,47\.600000,-52\.700000\)/);
  assert.match(query, /nwr\["name"\]\["shop"\]/);
  assert.match(query, /out center 4000;/);
});
test("uses a narrower selector for coffee shops and food", () => {
  const query = buildOverpassQuery(bounds, "food");
  assert.match(query, /fast_food/);
  assert.doesNotMatch(query, /\["office"\]/);
});
