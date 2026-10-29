import assert from "node:assert/strict";
import test from "node:test";
import { assertExportable, buildCsv, buildJsonPayload, CSV_COLUMNS } from "./export";
import type { Business, SearchResponse } from "./types";

const row: Business = {
  id: "geoapify/001", name: "A, \"Quoted\" Company",
  category: "software", categoryGroup: "services",
  website: "https://example.com", phone: "+1 514 555 0123",
  email: "work@example.com", address: "123 King St\nSuite 2",
  city: "Montréal", location: { latitude: 45.5, longitude: -73.57 },
  source: "geoapify", sourceUrl: "https://www.geoapify.com/places-api/",
  sources: ["geoapify"], confidence: null,
};
const search: SearchResponse = {
  businesses: [row], count: 1, truncated: false,
  searchedAt: "2026-10-29T08:00:00.000Z",
  provider: "geoapify",
  sources: [{
    name: "Geoapify Places", license: "ODbL 1.0",
    attribution: "Powered by Geoapify · © OpenStreetMap contributors",
    url: "https://www.geoapify.com/terms-and-conditions/",
  }], warnings: [],
};

test("JSON exports every matching row with selection, schema and attribution", () => {
  const rows = Array.from({length: 35}, (_,i)=>({...row,id:"geoapify/"+i,name:"Company "+i}));
  const polygon: [number,number][] = [[-74,45],[-73,45],[-73,46],[-74,46],[-74,45]];
  const data = buildJsonPayload(rows, polygon, {...search,businesses:rows,count:35});
  assert.equal(data.businesses.length,35);
  assert.equal(data.businesses[34].name,"Company 34");
  assert.equal(data.schemaVersion,"1.0");
  assert.equal(data.selection?.coordinates[0].length,5);
  assert.equal(data.sources[0].name,"Geoapify Places");
  assert.equal(data.count,35);
});

test("CSV includes complete columns, all supplied rows and Excel BOM",()=>{
  const rows=Array.from({length:35},(_,i)=>({...row,id:"geoapify/"+i,name:"Company "+i}));
  const csv=buildCsv(rows,search);
  assert.equal(csv.charCodeAt(0),0xFEFF);
  assert.equal(csv.trimEnd().split("\r\n").length,36);
  assert.ok(csv.includes('"Company 34"'));
  for(const col of CSV_COLUMNS) assert.ok(csv.split("\r\n")[0].includes('"'+col+'"'));
  assert.ok(csv.includes('"Montréal"'));
  assert.ok(csv.includes('"https://example.com"'));
});

test("CSV quotes dangerous formulas, embedded commas, quotes and newlines",()=>{
  const csv=buildCsv([{...row,name:'=IMPORTXML("https://example.com","/")'}],search);
  assert.ok(csv.includes('"\'=IMPORTXML(""https://example.com"",""/"")"'));
  assert.ok(csv.includes('"123 King St\nSuite 2"'));
  const more=buildCsv([row],search);
  assert.ok(more.includes('"A, ""Quoted"" Company"'));
});

test("Google Places data cannot be exported even if UI or search provider is spoofed",()=>{
  const googleSearch={...search,provider:"google" as const};
  assert.throws(()=>buildCsv([row],googleSearch),/cannot be exported/);
  assert.throws(()=>buildJsonPayload([row],null,googleSearch),/cannot be exported/);
  const googleRow:Business={...row,id:"google/abc",source:"google_places",sources:["google_places"]};
  assert.throws(()=>buildCsv([googleRow],search),/cannot be exported/);
  assert.throws(()=>assertExportable([googleRow],search),/cannot be exported/);
  assert.throws(()=>buildCsv([row],{...search,sources:[{...search.sources[0],name:"Google Maps"}]}),
    /cannot be exported/);
});

test("legally exportable empty dataset produces a valid CSV header",()=>{
  const csv=buildCsv([],search);
  assert.equal(csv.trimEnd().split("\r\n").length,1);
});
