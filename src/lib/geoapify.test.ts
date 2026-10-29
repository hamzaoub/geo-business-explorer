import assert from "node:assert/strict";
import test from "node:test";
import { buildGeoapifyUrl, discoverGeoapify, normalizeGeoapifyFeature } from "./geoapify";
import { normalizePolygon } from "./geo";
import { UpstreamError } from "./overpass";

const polygon = normalizePolygon([
  [-52.8, 47.5], [-52.6, 47.5], [-52.6, 47.65], [-52.8, 47.65],
]);
const bounds = { west: -52.8, south: 47.5, east: -52.6, north: 47.65, approximateKm2: 190 };
const feature = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [-52.7, 47.56] },
  properties: {
    place_id: "sample-place-id", name: "Harbour Cafe", categories: ["catering.cafe"],
    address_line1: "22 Water Street", city: "St. John's",
    contact: { website: "harbour.example", phone: "+1 709 555 0140", email: "hello@harbour.example" },
  },
};

test("Geoapify query uses the correct rectangular coordinate order and category", () => {
  const url = buildGeoapifyUrl(bounds, "food", "a-test-key");
  assert.equal(url.hostname, "api.geoapify.com");
  assert.equal(url.searchParams.get("filter"), "rect:-52.8,47.5,-52.6,47.65");
  assert.equal(url.searchParams.get("categories"), "catering");
  assert.equal(url.searchParams.get("limit"), "500");
});

test("Geoapify feature provides all available details", () => {
  const result = normalizeGeoapifyFeature(feature, polygon);
  assert.equal(result?.name, "Harbour Cafe");
  assert.equal(result?.categoryGroup, "food");
  assert.equal(result?.website, "https://harbour.example/");
  assert.equal(result?.phone, "+1 709 555 0140");
  assert.equal(result?.email, "hello@harbour.example");
  assert.equal(result?.address, "22 Water Street");
  assert.equal(result?.source, "geoapify");
});

test("Geoapify excludes points outside the screenshot selection", () => {
  assert.equal(normalizeGeoapifyFeature({
    ...feature, geometry: { type: "Point", coordinates: [-52.7, 50] },
  }, polygon), null);
});

test("Geoapify returns usable records even if Overpass is down", async () => {
  const fetcher = (async () => Response.json({ type: "FeatureCollection", features: [feature] })) as typeof fetch;
  const result = await discoverGeoapify(polygon, bounds, "all", { apiKey: "test", fetcher });
  assert.equal(result.businesses.length, 1);
  assert.equal(result.truncated, false);
});

test("Geoapify rejects invalid keys with an actionable error", async () => {
  const fetcher = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;
  await assert.rejects(() => discoverGeoapify(polygon, bounds, "all", {
    apiKey: "bad", fetcher,
  }), (error: unknown) => error instanceof UpstreamError && error.message.includes("API key"));
});

test("Geoapify respects rate limits and does not silently return empty records", async () => {
  const fetcher = (async () => new Response("limited", { status: 429 })) as typeof fetch;
  await assert.rejects(() => discoverGeoapify(polygon, bounds, "all", {
    apiKey: "test", fetcher,
  }), (error: unknown) => error instanceof UpstreamError && error.status === 429);
});


function makePage(count: number, offset = 0) {
  return Array.from({length:count}, (_, i) => ({
    ...feature,
    properties: {...feature.properties,place_id:"place-"+(offset+i),name:"Business "+(offset+i)},
  }));
}

test("Geoapify requests subsequent pages and keeps all distinct businesses", async () => {
  const offsets: number[] = [];
  const fetcher:typeof fetch = async input => {
    const offset = Number(new URL(String(input)).searchParams.get("offset"));
    offsets.push(offset);
    const features = offset === 0 ? makePage(500) : makePage(25,500);
    return Response.json({type:"FeatureCollection",features});
  };
  const result = await discoverGeoapify(polygon,bounds,"all",{
    apiKey:"test",maxPages:8,fetcher,
  });
  assert.deepEqual(offsets,[0,500]);
  assert.equal(result.businesses.length,525);
  assert.equal(result.truncated,false);
  assert.equal(result.warning,undefined);
});

test("deduplicates Geoapify places by stable place_id across pages", async () => {
  const fetcher:typeof fetch = async input => {
    const offset = Number(new URL(String(input)).searchParams.get("offset"));
    const features = offset === 0 ? makePage(500) :
      [{...feature,properties:{...feature.properties,place_id:"place-0",name:"Repeated"}}];
    return Response.json({features});
  };
  const result = await discoverGeoapify(polygon,bounds,"all",{
    apiKey:"test",maxPages:3,fetcher,
  });
  assert.equal(result.businesses.length,500);
  assert.equal(result.truncated,false);
});

test("returns flagged partial results at configured page limit", async () => {
  const offsets:number[]=[];
  const fetcher:typeof fetch=async input=>{
    offsets.push(Number(new URL(String(input)).searchParams.get("offset")));
    return Response.json({features:makePage(500,offsets.length*500)});
  };
  const result=await discoverGeoapify(polygon,bounds,"all",{apiKey:"test",maxPages:2,fetcher});
  assert.equal(result.businesses.length,1000);
  assert.deepEqual(offsets,[0,500]);
  assert.equal(result.truncated,true);
  assert.match(result.warning||"",/page limit reached/);
});

test("retains previously fetched businesses but flags a second-page quota error", async () => {
  let requestCount=0;
  const fetcher:typeof fetch=async()=>{
    requestCount++;
    return requestCount===1 ? Response.json({features:makePage(500)}) :
      new Response("",{status:429});
  };
  const result=await discoverGeoapify(polygon,bounds,"all",{apiKey:"test",maxPages:4,fetcher});
  assert.equal(requestCount,2);
  assert.equal(result.businesses.length,500);
  assert.equal(result.truncated,true);
  assert.match(result.warning||"",/quota/);
});
