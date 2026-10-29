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


import { fetchOverpassPayload, overpassEndpoints, UpstreamError } from "./overpass";

test("uses a secondary public provider when the default is unavailable", () => {
  assert.deepEqual(overpassEndpoints("https://overpass-api.de/api/interpreter", undefined), [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
  ]);
  assert.deepEqual(overpassEndpoints("https://private.example/api/interpreter", undefined), [
    "https://private.example/api/interpreter",
  ]);
});

test("network failure triggers exactly one fallback, yielding real records", async () => {
  const visited: string[] = [];
  const payload = await fetchOverpassPayload("test", {
    endpoints: ["https://a.example/interpreter", "https://b.example/interpreter"],
    fetcher: (async (url: RequestInfo | URL) => {
      visited.push(String(url));
      if (visited.length === 1) throw new Error("ECONNRESET");
      return Response.json({ elements: [{
        type: "node", id: 8, tags: { name: "Test Cafe", amenity: "cafe" }, lat: 47.57, lon: -52.7,
      }] });
    }) as typeof fetch,
    timeoutMs: 1000,
  });
  assert.equal(visited.length, 2);
  assert.equal(payload.elements[0].id, 8);
});

test("upstream 503 triggers a fallback", async () => {
  let count = 0;
  const payload = await fetchOverpassPayload("test", {
    endpoints: ["https://a.example/interpreter", "https://b.example/interpreter"],
    fetcher: (async () => {
      count++;
      return count === 1 ? new Response("busy", { status: 503 }) :
        Response.json({ elements: [] });
    }) as typeof fetch,
    timeoutMs: 1000,
  });
  assert.equal(count, 2);
  assert.deepEqual(payload.elements, []);
});

test("invalid JSON from one provider falls back to another", async () => {
  let count = 0;
  const payload = await fetchOverpassPayload("test", {
    endpoints: ["https://a.example/interpreter", "https://b.example/interpreter"],
    fetcher: (async () => {
      count++;
      return count === 1 ? new Response("<html>upstream error</html>") :
        Response.json({ elements: [] });
    }) as typeof fetch,
    timeoutMs: 1000,
  });
  assert.equal(count, 2);
  assert.equal(payload.elements.length, 0);
});

test("does not evade a public operator's 429 rate limit", async () => {
  let count = 0;
  await assert.rejects(
    () => fetchOverpassPayload("test", {
      endpoints: ["https://a.example/interpreter", "https://b.example/interpreter"],
      fetcher: (async () => { count++; return new Response("slow down", { status: 429 }); }) as typeof fetch,
      timeoutMs: 1000,
    }),
    (error: unknown) => error instanceof UpstreamError && error.status === 429,
  );
  assert.equal(count, 1);
});

test("all unavailable servers return clear 503", async () => {
  await assert.rejects(
    () => fetchOverpassPayload("test", {
      endpoints: ["https://a.example/interpreter", "https://b.example/interpreter"],
      fetcher: (async () => new Response("unavailable", { status: 503 })) as typeof fetch,
      timeoutMs: 1000,
    }),
    (error: unknown) => error instanceof UpstreamError && error.status === 503,
  );
});
