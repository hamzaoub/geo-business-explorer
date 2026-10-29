import assert from "node:assert/strict";
import test from "node:test";
import { googleNearbyRequest, googleSearchCircle, googlePlaceToBusiness,
  discoverGooglePlaces, GOOGLE_NEARBY_URL, GOOGLE_MAX_RESULTS } from "./google-places";
import { normalizePolygon } from "./geo";
import { UpstreamError } from "./overpass";

const bounds = { south: 47.55, north: 47.58, west: -52.74, east: -52.69, approximateKm2: 16 };
const polygon = normalizePolygon([
  [bounds.west,bounds.south],[bounds.east,bounds.south],
  [bounds.east,bounds.north],[bounds.west,bounds.north],
]);

test("uses one circle covering corners and at most 20 places", () => {
  const circle = googleSearchCircle(bounds);
  assert.equal(circle.center.latitude, (bounds.north+bounds.south)/2);
  assert.ok(circle.radius > 1000 && circle.radius < 50000);
  const body = googleNearbyRequest(bounds, "all") as {
    maxResultCount: number; includedTypes?: string[];
    locationRestriction: {circle: {radius:number}};
  };
  assert.equal(body.maxResultCount, GOOGLE_MAX_RESULTS);
  assert.equal(body.includedTypes, undefined);
  assert.ok(body.locationRestriction.circle.radius >= circle.radius);
});

test("category selection constrains supported Google types", () => {
  const food = googleNearbyRequest(bounds,"food") as {includedTypes?:string[]};
  assert.deepEqual(food.includedTypes,["restaurant","cafe","bakery","bar"]);
});

test("refuses oversized areas before charging the user", () => {
  const huge = { south: 40, north: 45, west: -76, east: -70, approximateKm2: 100000 };
  assert.throws(() => googleNearbyRequest(huge, "all"),
    (error: unknown) => error instanceof UpstreamError && error.status === 400);
});

const place = {
  id: "ChIJExample",
  displayName: {text:"Harbour Coffee"},
  formattedAddress: "12 Water Street, St John's, NL, Canada",
  location: {latitude:47.56,longitude:-52.71},
  primaryType: "cafe",
  googleMapsUri: "https://maps.google.com/?cid=123",
  websiteUri: "https://harbour.example",
  internationalPhoneNumber: "+17095550100",
};
test("maps Google places without email and rejects out-of-polygon results", () => {
  const record=googlePlaceToBusiness(place,polygon);
  assert.equal(record?.source,"google_places");
  assert.equal(record?.name,"Harbour Coffee");
  assert.equal(record?.website,"https://harbour.example/");
  assert.equal(record?.phone,"+17095550100");
  assert.equal(record?.email,null);
  assert.equal(record?.categoryGroup,"food");
  assert.equal(googlePlaceToBusiness({...place,location:{latitude:45,longitude:-52.71}},polygon),null);
});

test("does not request Enterprise phone/website fields unless explicitly enabled",async()=>{
  const requests: Array<{url:string;headers:Headers;body:string}> = [];
  const mocked:typeof fetch=async(input,init)=>{
    requests.push({url:String(input),headers:new Headers(init?.headers),body:String(init?.body)});
    return Response.json({places:[place]});
  };
  const data=await discoverGooglePlaces(polygon,bounds,"all",{
    apiKey:"test-secret", includeContacts:false,fetcher:mocked,
  });
  assert.equal(data.businesses.length,1);
  assert.equal(data.truncated,false);
  assert.equal(requests[0].url,GOOGLE_NEARBY_URL);
  assert.equal(requests[0].headers.get("x-goog-api-key"),"test-secret");
  const mask=requests[0].headers.get("x-goog-fieldmask")!;
  assert.match(mask,/places.displayName/);
  assert.doesNotMatch(mask,/places.websiteUri|places.internationalPhoneNumber/);
  assert.equal(JSON.parse(requests[0].body).maxResultCount,20);
});

test("including contacts is explicit and triggers higher billing fields",async()=>{
  let mask="";
  await discoverGooglePlaces(polygon,bounds,"all",{
    apiKey:"test-secret",includeContacts:true,
    fetcher: (async(_input,init)=>{
      mask=new Headers(init?.headers).get("x-goog-fieldmask")||"";
      return Response.json({});
    }) as typeof fetch,
  });
  assert.match(mask,/places.websiteUri/);
  assert.match(mask,/places.internationalPhoneNumber/);
});

test("429 quota is reported, not retried or silently ignored",async()=>{
  await assert.rejects(()=>discoverGooglePlaces(polygon,bounds,"all",{
    apiKey:"test-secret",
    fetcher:(async()=>new Response("",{status:429})) as typeof fetch,
  }), (error:unknown)=>error instanceof UpstreamError&&error.status===429);
});
