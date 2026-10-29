import assert from "node:assert/strict";
import test from "node:test";
import { parseSavedBusinesses } from "./saved-json";
import { assertExportable } from "./export";

const google = {
  id:"google/ChIJtRLzl9ejDEsRBVbLM-ep9VM",
  name:"Quidi Vidi Brewery",
  category:"brewery",
  categoryGroup:"other",
  website:"http://www.quidividibrewery.ca/",
  phone:"+1 709-738-4040",
  email:null,
  address:"35 Barrows Rd, St. John's, NL",
  city:"St. John's",
  location:{latitude:47.5814765,longitude:-52.6760882},
  source:"google_places",
  sourceUrl:"https://maps.google.com/?cid=6049928484913632773",
  sources:["google_places"],
  confidence:null,
};
test("imports user's nested businesses file with complete fields and Google attribution",()=>{
  const result=parseSavedBusinesses({businesses:[google],searchedAt:"2026-10-29"});
  assert.equal(result.response.count,1);
  assert.equal(result.response.businesses[0].name,"Quidi Vidi Brewery");
  assert.equal(result.response.businesses[0].categoryGroup,"other");
  assert.equal(result.response.businesses[0].website,"http://www.quidividibrewery.ca/");
  assert.equal(result.response.businesses[0].phone,"+1 709-738-4040");
  assert.equal(result.response.businesses[0].email,null);
  assert.equal(result.response.businesses[0].city,"St. John's");
  assert.equal(result.response.provider,"google");
  assert.equal(result.response.sources[0].attribution,"Google Maps");
  assert.equal(result.hasGoogleContent,true);
  assert.throws(()=>assertExportable(result.response.businesses,result.response),
    /cannot be exported/);
});
test("rejects malformed JSON structures and invalid records, removes duplicate IDs",()=>{
  assert.throws(()=>parseSavedBusinesses([]),/expected/);
  assert.throws(()=>parseSavedBusinesses({businesses:"not array"}),/expected/);
  const out=parseSavedBusinesses({businesses:[
    google,google,{...google,id:"",name:"Anonymous"},
    {...google,id:"geoapify/x",source:"geoapify",location:{latitude:200,longitude:1}},
  ]});
  assert.equal(out.response.count,1);
  assert.equal(out.duplicateIds,1);
  assert.equal(out.rejected,2);
  assert.match(out.response.warnings.join(" "),/skipped/);
});
test("normalizes safe links, category group and non-Google source for independent licensed files",()=>{
  const source={...google,id:"geoapify/x",source:"geoapify",sources:["geoapify"],
    website:"javascript:alert(1)",sourceUrl:"https://geoapify.com/x",categoryGroup:"unknown",
  };
  const out=parseSavedBusinesses({businesses:[source]});
  assert.equal(out.response.provider,"geoapify");
  assert.equal(out.response.businesses[0].website,null);
  assert.equal(out.response.businesses[0].categoryGroup,"other");
  assert.doesNotThrow(()=>assertExportable(out.response.businesses,out.response));
});
test("prevents renaming Google place IDs to an exportable provider",()=>{
  const out=parseSavedBusinesses({businesses:[{
    ...google,source:"geoapify",sources:["geoapify"],
  }]});
  assert.equal(out.response.provider,"google");
  assert.equal(out.response.businesses[0].source,"google_places");
  assert.throws(()=>assertExportable(out.response.businesses,out.response));
});
test("protects UI from excessively large local files",()=>{
  assert.throws(()=>parseSavedBusinesses({businesses:Array(50_001).fill(google)}),/50,000/);
});
