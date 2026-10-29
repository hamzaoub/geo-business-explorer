import assert from "node:assert/strict";
import test from "node:test";
import { normalizePolygon, pointInPolygon, polygonBounds } from "./geo";

const square = normalizePolygon([[0, 0], [2, 0], [2, 2], [0, 2]]);

test("normalizes and closes an unclosed polygon", () => {
  assert.deepEqual(square[0], square[square.length - 1]);
  assert.equal(square.length, 5);
});
test("accepts closed polygon without double-closing", () => {
  assert.equal(normalizePolygon(square).length, 5);
});
test("checks point in polygon and boundary", () => {
  assert.equal(pointInPolygon([1, 1], square), true);
  assert.equal(pointInPolygon([3, 1], square), false);
  assert.equal(pointInPolygon([0, 1], square), true);
});
test("rejects invalid coordinates and excessive vertex counts", () => {
  assert.throws(() => normalizePolygon([[200, 10], [1, 1], [2, 1]]));
  assert.throws(() => normalizePolygon(Array.from({ length: 125 }, (_, i) => [i, i])));
});
test("prevents broad live searches", () => {
  assert.throws(() => polygonBounds(square), /too large/);
});
