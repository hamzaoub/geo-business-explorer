import assert from "node:assert/strict";
import test from "node:test";
import { HISTORY_KEY, SNAPSHOT_TTL_MS, HISTORY_TTL_MS,
  readSearchHistory, recordSearchHistory, reusableSnapshot, removeSearchHistory,
  searchIdentityKey, type SearchIdentity } from "./search-history";
import type { SearchResponse } from "./types";

function memoryStorage(): Storage {
  const data=new Map<string,string>();
  return {
    getItem:(key:string)=>data.get(key)??null,
    setItem:(key:string,value:string)=>{data.set(key,value)},
    removeItem:(key:string)=>{data.delete(key)},
    clear:()=>data.clear(),
    key:(i:number)=>[...data.keys()][i]??null,
    get length(){return data.size},
  };
}
const polygon: SearchIdentity["polygon"]=[
  [-52.8,47.5],[-52.6,47.5],[-52.6,47.65],[-52.8,47.65],[-52.8,47.5],
];
const identity:SearchIdentity={
  polygon, provider:"geoapify", category:"all", goal:"it", googleExpanded:false,
};
const business={
  id:"geoapify/abc",name:"Historic Software Company",category:"office",
  categoryGroup:"services" as const,website:"https://example.com",phone:null,email:null,
  address:"123 King Street",city:"Toronto",
  location:{latitude:47.57,longitude:-52.7},
  source:"geoapify" as const,sourceUrl:"https://www.geoapify.com/",
  sources:["geoapify" as const],confidence:null,
};
const result:SearchResponse={
  businesses:[business],count:1,truncated:false,searchedAt:"2026-10-29T00:00:00.000Z",
  provider:"geoapify",sources:[],warnings:[],
};
test("non-Google history reuses exact saved result without API",()=>{
  const store=memoryStorage(),now=Date.now();
  const entries=recordSearchHistory(identity,result,store,now);
  assert.equal(entries[0].snapshot?.businesses[0].name,"Historic Software Company");
  assert.deepEqual(reusableSnapshot(identity,store,now+1000),result);
  assert.equal(readSearchHistory(store,now+1000).length,1);
  const reversed={...identity,polygon:[...polygon].reverse()};
  assert.equal(searchIdentityKey(reversed),searchIdentityKey(identity));
  assert.deepEqual(reusableSnapshot(reversed,store,now+1000),result);
  assert.equal(reusableSnapshot({...identity,category:"health"},store,now+1000),null);
});
test("Google history stores only IDs and search settings, never business names or contacts",()=>{
  const store=memoryStorage();
  const googleIdentity={...identity,provider:"google" as const,goal:"it" as const};
  const googleResponse={...result,provider:"google" as const,
    businesses:[{...business,id:"google/ChIJprivate",name:"Sensitive Google Company",
      website:"https://sensitive.example.com",phone:"+1555000",source:"google_places" as const,
      sources:["google_places" as const]}]};
  const history=recordSearchHistory(googleIdentity,googleResponse,store);
  assert.deepEqual(history[0].googlePlaceIds,["ChIJprivate"]);
  assert.equal(history[0].snapshot,undefined);
  assert.equal(reusableSnapshot(googleIdentity,store),null);
  const raw=store.getItem(HISTORY_KEY)||"";
  assert.ok(raw.includes("ChIJprivate"));
  assert.ok(!raw.includes("Sensitive Google Company"));
  assert.ok(!raw.includes("+1555000"));
  assert.ok(!raw.includes("sensitive.example"));
});
test("snapshot TTL 24h, metadata TTL 30d and delete work",()=>{
  const store=memoryStorage(),now=Date.now();
  recordSearchHistory(identity,result,store,now);
  assert.equal(reusableSnapshot(identity,store,now+SNAPSHOT_TTL_MS+1),null);
  assert.equal(readSearchHistory(store,now+SNAPSHOT_TTL_MS+1).length,1);
  assert.equal(readSearchHistory(store,now+HISTORY_TTL_MS+1).length,0);
  assert.equal(removeSearchHistory(searchIdentityKey(identity),store).length,0);
  recordSearchHistory(identity,result,store,now);
  assert.equal(removeSearchHistory(null,store).length,0);
  assert.equal(store.getItem(HISTORY_KEY),null);
});
test("large snapshots do not exceed storage budget or leak Google content",()=>{
  const store=memoryStorage();
  const long={...business,name:"A".repeat(2500)};
  recordSearchHistory(identity,{...result,businesses:Array.from({length:2500},(_,i)=>({...long,id:"geoapify/"+i}))},store);
  const raw=store.getItem(HISTORY_KEY)||"";
  assert.ok(raw.length<=2_800_000);
  assert.equal(readSearchHistory(store).length,1);
});
