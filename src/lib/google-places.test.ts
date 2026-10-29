import assert from "node:assert/strict";
import test from "node:test";
import { googleNearbyRequest, googleSearchCircle, googlePlaceToBusiness,
  discoverGooglePlaces, googleLiveSearchPlan, GOOGLE_NEARBY_URL, GOOGLE_MAX_RESULTS } from "./google-places";
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
test("maps Google places without email and does not use Google's coordinates for polygon clipping", () => {
  const record=googlePlaceToBusiness(place,polygon);
  assert.equal(record?.source,"google_places");
  assert.equal(record?.name,"Harbour Coffee");
  assert.equal(record?.website,"https://harbour.example/");
  assert.equal(record?.phone,"+17095550100");
  assert.equal(record?.email,null);
  assert.equal(record?.categoryGroup,"food");
  assert.equal(record?.city,null); // No structured locality was supplied.
  assert.ok(googlePlaceToBusiness({...place,location:{latitude:45,longitude:-52.71}},polygon));
});

test("extracts city from Google addressComponents, not guessed address fragments",()=>{
  const withCity={...place,addressComponents:[
    {longText:"St. John's",types:["locality","political"]},
    {longText:"Newfoundland and Labrador",shortText:"NL",types:["administrative_area_level_1"]},
  ]};
  assert.equal(googlePlaceToBusiness(withCity,polygon)?.city,"St. John's");
  assert.equal(googlePlaceToBusiness({...place,addressComponents:[
    {longText:"London",types:["postal_town"]},
  ]},polygon)?.city,"London");
  assert.equal(googlePlaceToBusiness({...place,addressComponents:[
    {longText:"Quebec",types:["administrative_area_level_1"]},
  ]},polygon)?.city,null);
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
  assert.match(mask,/places.addressComponents/);
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


test("expanded mode keeps a default budget but zero means finite auto-plan",()=>{
  assert.equal(googleLiveSearchPlan("all",false).length,1);
  assert.equal(googleLiveSearchPlan("all",true).length,6);
  assert.equal(googleLiveSearchPlan("all",true,0).length,18);
  assert.equal(googleLiveSearchPlan("all",true,12).length,12);
  assert.equal(googleLiveSearchPlan("all",true,999).length,18);
  assert.equal(googleLiveSearchPlan("all",true,3).length,3);
  assert.equal(googleLiveSearchPlan("food",true).length,4);
  assert.equal(googleLiveSearchPlan("food",true,0).length,4);
});
test("6 billable calls retrieve unique live results, never cache or export them",async()=>{
  const bodies: Array<{includedTypes?:string[]}>=[];
  const fetcher:typeof fetch=async(_input,init)=>{
    const data=JSON.parse(String(init?.body));
    bodies.push(data);
    const marker=bodies.length;
    return Response.json({places:[place,{
      ...place,id:"Google-"+marker,displayName:{text:"Place "+marker},
    }]});
  };
  const result=await discoverGooglePlaces(polygon,bounds,"all",{
    apiKey:"test", expanded:true,maxRequests:6,fetcher,
  });
  assert.equal(bodies.length,6);
  assert.equal(result.requestCount,6);
  assert.equal(result.businesses.length,7);
  assert.equal(new Set(result.businesses.map(p=>p.id)).size,7);
  assert.equal(result.truncated,true);
  assert.ok(bodies.some(x=>x.includedTypes?.includes("restaurant")));
});
test("quota stops scheduling extra Google requests",async()=>{
  let n=0;
  const fetcher:typeof fetch=async()=>{
    n++;
    return new Response("",{status:429});
  };
  await assert.rejects(()=>discoverGooglePlaces(polygon,bounds,"all",{
    apiKey:"test",expanded:true,maxRequests:6,fetcher,
  }),(e:unknown)=>e instanceof UpstreamError&&e.status===429);
  assert.ok(n<=2,"only the in-flight concurrent requests may complete after quota failure");
});


test("auto discovery performs a finite set of categories and deduplicates by Google ID",async()=>{
  const requestedTypes:string[]=[];
  const fetcher:typeof fetch=async (_input,init)=>{
    const body=JSON.parse(String(init?.body)) as {includedTypes?:string[]};
    requestedTypes.push((body.includedTypes||[]).join(","));
    return Response.json({places:[place]});
  };
  const result=await discoverGooglePlaces(polygon,bounds,"all",{
    apiKey:"test",expanded:true,maxRequests:0,fetcher,
  });
  assert.equal(result.requestCount,18);
  assert.equal(requestedTypes.length,18);
  assert.equal(new Set(requestedTypes).size,18);
  assert.equal(result.businesses.length,1);
  assert.equal(result.truncated,true);
});



test("IT employer goal targets all 16 types plus 10 relevant Text Search queries",()=>{
  const base = googleLiveSearchPlan("all",false,0,"it");
  assert.equal(base.length,1);
  assert.equal(base[0].mode,"nearby");
  if(base[0].mode!=="nearby")throw Error("Expected Nearby");
  assert.equal(base[0].types?.length,16);
  const plan=googleLiveSearchPlan("all",true,0,"it");
  assert.equal(plan.length,15);
  const nearby=plan.filter(job=>job.mode==="nearby");
  const text=plan.filter(job=>job.mode==="text");
  assert.equal(nearby.length,5);
  assert.equal(text.length,10);
  const all=new Set(nearby.slice(1).flatMap(item=>item.types||[]));
  assert.equal(all.size,16);
  for(const type of ["corporate_office","business_center","coworking_space",
    "marketing_consultant","research_institute","manufacturer","supplier",
    "bank","insurance_agency","telecommunications_service_provider","university",
    "educational_institution","hospital","shipping_service","real_estate_agency"]) {
    assert.ok(all.has(type),type);
  }
  assert.ok(text.some(job=>job.textQuery==="software development company"));
  assert.ok(text.some(job=>job.textQuery==="cybersecurity company"));
});
test("Google IT default expanded budget makes 5 Nearby and one topical Text Search call",async()=>{
  const urls:string[]=[];
  const fetcher:typeof fetch=async(input,init)=>{
    urls.push(String(input));
    const body=JSON.parse(String(init?.body)) as {includedTypes?:string[]; textQuery?:string};
    if(urls.length===1) assert.equal(body.includedTypes?.length,16);
    return Response.json({places:[place]});
  };
  const data=await discoverGooglePlaces(polygon,bounds,"all",{
    apiKey:"test",expanded:true,maxRequests:6,goal:"it",fetcher,
  });
  assert.equal(data.requestCount,6);
  assert.equal(data.nearbyRequestCount,5);
  assert.equal(data.textRequestCount,1);
  assert.equal(data.textQueryCount,1);
  assert.equal(urls.filter(url=>url===GOOGLE_NEARBY_URL).length,5);
  assert.equal(data.businesses.length,1);
  assert.equal(data.duplicatesRemoved,5);
  assert.equal(data.targetTypes.length,16);
});
test("Google IT auto discovery follows up to two Text Search pages per topic, never unlimited",async()=>{
  const calls:Array<{url:string;body:{textQuery?:string;pageToken?:string;pageSize?:number;
    locationRestriction?:{rectangle?:{low:{latitude:number;longitude:number};high:{latitude:number;longitude:number}}}}}>=[];
  const fetcher:typeof fetch=async(input,init)=>{
    const body=JSON.parse(String(init?.body));
    const url=String(input);
    calls.push({url,body});
    const token=body.pageToken as string|undefined;
    const pageNo=token==="page-2"?2:token==="page-3"?3:1;
    const name=body.textQuery?String(body.textQuery):"nearby";
    return Response.json({
      places:[{...place,id:"place-"+name+"-"+pageNo,
        displayName:{text:"Place "+name+" "+pageNo}}],
      ...(url.includes("searchText") && pageNo<3 ? {nextPageToken:"page-"+(pageNo+1)} : {}),
    });
  };
  const data=await discoverGooglePlaces(polygon,bounds,"all",{
    apiKey:"test",expanded:true,maxRequests:0,goal:"it",fetcher,
  });
  assert.equal(data.requestCount,35);
  assert.equal(data.nearbyRequestCount,5);
  assert.equal(data.textRequestCount,30);
  assert.equal(data.textQueryCount,10);
  assert.equal(data.businesses.length,31); // 1 Nearby + 3 unique pages × 10 topics
  assert.equal(data.duplicatesRemoved,4);
  const textCalls=calls.filter(x=>x.url.includes("searchText"));
  assert.equal(textCalls.length,30);
  const first=textCalls.find(x=>!x.body.pageToken);
  assert.deepEqual(first?.body.locationRestriction?.rectangle,{
    low:{latitude:bounds.south,longitude:bounds.west},
    high:{latitude:bounds.north,longitude:bounds.east},
  });
  assert.equal(first?.body.pageSize,20);
  assert.ok(textCalls.some(x=>x.body.pageToken==="page-3"));
});
test("Google IT never downloads another page without a provider page token",async()=>{
  let calls=0;
  const fetcher:typeof fetch=async()=>{calls++;return Response.json({places:[place]});};
  const result=await discoverGooglePlaces(polygon,bounds,"all",{
    apiKey:"test",goal:"it",expanded:true,maxRequests:0,fetcher,
  });
  assert.equal(calls,15);
  assert.equal(result.requestCount,15);
  assert.equal(result.textRequestCount,10);
});
