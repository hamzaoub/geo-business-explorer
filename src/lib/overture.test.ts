import assert from "node:assert/strict";
import test from "node:test";
import { normalizeOvertureRow } from "./overture";
import { normalizePolygon } from "./geo";

const polygon = normalizePolygon([[-53, 47.4], [-52.5, 47.4], [-52.5, 47.9], [-53, 47.9]]);
const sample = {
  id: "abcdef", name: "Harbour Coffee", category: "coffee_shop",
  latitude: 47.56, longitude: -52.71, website: "coffeeshop.example",
  phone: "709-123-4567", email: null, address: "100 Water St",
  city: "St. John's", confidence: 0.9,
};
test("normalizes a business and validates its website", () => {
  const result = normalizeOvertureRow(sample, polygon, "food");
  assert.equal(result?.id, "overture/abcdef");
  assert.equal(result?.website, "https://coffeeshop.example/");
  assert.equal(result?.categoryGroup, "food");
});
test("excludes records outside selected polygon", () => {
  assert.equal(normalizeOvertureRow({ ...sample, latitude: 50 }, polygon, "all"), null);
});
test("applies category filtering", () => {
  assert.equal(normalizeOvertureRow(sample, polygon, "health"), null);
});
