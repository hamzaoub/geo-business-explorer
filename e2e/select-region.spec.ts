import { expect, test } from "@playwright/test";

test("drag anywhere over the map to select and automatically see JSON results", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  let requestBody: { polygon?: [number, number][]; category?: string } | undefined;
  await page.route("**/api/search", async (route) => {
    requestBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        businesses: [{
          id: "node/123",
          name: "Harbour Coffee",
          category: "cafe",
          categoryGroup: "food",
          website: "https://example.com",
          phone: "+1-709-555-0100",
          email: null,
          address: "1 Water Street",
          city: "St. John's",
          location: { latitude: 47.57, longitude: -52.7 },
          source: "openstreetmap",
          sourceUrl: "https://www.openstreetmap.org/node/123",
          sources: ["openstreetmap"],
          confidence: null,
        }],
        count: 1,
        truncated: false,
        searchedAt: new Date().toISOString(),
        provider: "osm",
        sources: [{
          name: "OpenStreetMap", license: "ODbL 1.0",
          attribution: "© OpenStreetMap contributors",
          url: "https://www.openstreetmap.org/copyright",
        }],
        warnings: [],
      }),
    });
  });

  await page.goto("/");
  const canvas = page.locator(".leaflet-host");
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveClass(/leaflet-container/, { timeout: 15_000 });
  await expect(page.getByRole("button", { name: /Select area/i })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".leaflet-draw-toolbar")).toHaveCount(0);

  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (!box) throw new Error("Map did not render a draggable area");
  const x1 = box.x + box.width * 0.25;
  const y1 = box.y + box.height * 0.28;
  const x2 = box.x + box.width * 0.62;
  const y2 = box.y + box.height * 0.69;

  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move(x2, y2, { steps: 15 });
  await expect(page.locator(".map-feedback")).toContainText("Release to search this region");
  await page.mouse.up();

  await expect(page.locator(".map-feedback")).toContainText("1 businesses found");
  await expect.poll(() => requestBody?.polygon?.length).toBe(5);
  expect(requestBody?.category).toBe("all");
  expect(pageErrors).toEqual([]);

  await page.getByRole("button", { name: /View JSON/i }).click();
  await expect(page.getByLabel("Business search JSON preview")).toContainText("Harbour Coffee");
  await expect(page.getByLabel("Business search JSON preview")).toContainText("https://example.com");
});

test("move-map mode does not start a selection", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/search", async (route) => {
    calls++;
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.goto("/");
  const canvas = page.locator(".leaflet-host");
  await expect(canvas).toHaveClass(/leaflet-container/, { timeout: 15_000 });
  await page.getByRole("button", { name: /Move map/i }).click();
  await expect(page.getByRole("button", { name: /Move map/i })).toHaveAttribute("aria-pressed", "true");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Map has no interaction area");
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.65, { steps: 8 });
  await page.mouse.up();
  expect(calls).toBe(0);
  await expect(page.locator(".map-feedback")).toContainText("Drag to move the map");
});


test("Google Places can be selected without exporting or plotting Google data on OSM", async ({page}) => {
  await page.route("**/api/capabilities", async route => {
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({providers:{osm:true,geoapify:true,overture:false,google:true},geocoder:false}),
    });
  });
  let requestedProvider: string | undefined;
  let expandedOption: boolean | undefined;
  await page.route("**/api/search", async route => {
    const request = route.request().postDataJSON();
    requestedProvider = request.provider;
    expandedOption = request.googleExpanded;
    const isGeoapify = requestedProvider === "geoapify";
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        businesses: isGeoapify ? Array.from({length:35}, (_,i)=>({
          id:"geoapify/"+i, name:"Geoapify Business "+i, category:"cafe",
          categoryGroup:"food", website:null, phone:null, email:null, address:"Water Street",
          city:null, location:{latitude:47.57,longitude:-52.7}, source:"geoapify",
          sourceUrl:"https://www.geoapify.com/places-api/",sources:["geoapify"],confidence:null,
        })) : [{
          id:"google/Example", name:"Google Example Cafe", category:"cafe",
          categoryGroup:"food", website:null, phone:null, email:null,
          address:"12 Water St, St John's, NL",
          city:null, location:{latitude:47.57,longitude:-52.7},
          source:"google_places", sourceUrl:"https://www.google.com/maps/place/?q=place_id:Example",
          sources:["google_places"],confidence:null,
        }],
        count:isGeoapify?35:1,truncated:false,searchedAt:new Date().toISOString(),
        provider:isGeoapify?"geoapify":"google",
        sources:isGeoapify ? [{
          name:"Geoapify Places",license:"ODbL",
          attribution:"Powered by Geoapify · © OpenStreetMap contributors",
          url:"https://www.geoapify.com/terms-and-conditions/",
        }] : [{
          name:"Google Maps",license:"Google Maps Platform Terms",
          attribution:"Google Maps",url:"https://developers.google.com/maps/documentation/places/web-service/policies",
        }],
        warnings:["Nearby search results are limited to 20 per request."],
      }),
    });
  });
  await page.goto("/");
  await expect(page.locator(".leaflet-host")).toHaveClass(/leaflet-container/,{timeout:15000});
  await expect(page.locator("input[name='source']").nth(2)).toBeEnabled();
  await page.locator("input[name='source']").nth(2).check();
  await expect(page.getByLabel("Expanded Google live search")).not.toBeChecked();
  await page.getByLabel("Expanded Google live search").check();
  const map=page.locator(".leaflet-host");
  // Selecting a source in the sidebar scrolls the viewport down.
  // Bring the map back onscreen before issuing mouse coordinates.
  await map.scrollIntoViewIfNeeded();
  const box=await map.boundingBox();
  if (!box) throw new Error("Map missing");
  await page.mouse.move(box.x+box.width*0.3,box.y+box.height*0.3);
  await page.mouse.down();
  await page.mouse.move(box.x+box.width*0.65,box.y+box.height*0.7,{steps:10});
  await page.mouse.up();
  await expect(page.getByText("Google Example Cafe")).toBeVisible();
  await expect(page.locator(".google-maps-attribution")).toHaveText("Google Maps");
  expect(requestedProvider).toBe("google");
  expect(expandedOption).toBe(true);
  await expect(page.getByRole("button",{name:"↓ JSON"})).toBeDisabled();
  await expect(page.getByRole("button",{name:"↓ CSV"})).toBeDisabled();
  await expect(page.getByLabel("Business search JSON preview")).toHaveCount(0);
  // The area selection rectangle is permitted, but no Google business markers
  // may be rendered on the OpenStreetMap base map.
  await expect(page.locator(".leaflet-marker-pane .leaflet-marker-icon")).toHaveCount(0);
  await page.getByRole("button",{name:/Find more businesses with Geoapify/i}).click();
  await expect(page.getByLabel("Business search JSON preview")).toContainText("Geoapify Business 20");
  await expect(page.locator(".results-count")).toHaveText("35");
  await expect(page.getByRole("button",{name:"↓ JSON"})).toBeEnabled();
  await expect(page.getByRole("button",{name:"↓ CSV"})).toBeEnabled();
  expect(requestedProvider).toBe("geoapify");
});


test("IT employer preset searches all Google employer types, and history keeps Place IDs only", async ({ page }) => {
  await page.route("**/api/capabilities",async route=>route.fulfill({
    status:200,contentType:"application/json",
    body:JSON.stringify({providers:{osm:true,google:true,geoapify:false,overture:false},
      google:{requestBudget:6,automatic:false,includeContacts:false},geocoder:false}),
  }));
  let received: Record<string, unknown>|null=null;
  let calls=0;
  await page.route("**/api/search",async route=>{
    received=route.request().postDataJSON();
    calls++;
    await route.fulfill({status:200,contentType:"application/json",
      body:JSON.stringify({
        businesses:[{
          id:"google/ChIJTestingOnly",name:"Software Hiring Company",
          category:"corporate office",categoryGroup:"services",
          website:null,phone:null,email:null,address:"Main Street",
          city:"Toronto",location:{latitude:47.57,longitude:-52.7},
          source:"google_places",sourceUrl:"https://www.google.com/maps/",
          sources:["google_places"],confidence:null,
        }],
        count:1,truncated:false,requestCount:5,
        searchedAt:new Date().toISOString(),provider:"google",
        sources:[{name:"Google Maps",license:"Google Maps Platform Terms",
          attribution:"Google Maps",url:"https://developers.google.com/maps/documentation/places/web-service/policies"}],
        warnings:[],
      }),
    });
  });
  await page.goto("/");
  await expect(page.locator(".leaflet-host")).toHaveClass(/leaflet-container/,{timeout:15000});
  await page.getByRole("button",{name:/IT employers/i}).click();
  await expect(page.locator(".target-chip-list span")).toHaveCount(16);
  await page.getByLabel("Expanded Google live search").check();
  const map=page.locator(".leaflet-host");
  await map.scrollIntoViewIfNeeded();
  const box=await map.boundingBox();
  if (!box) throw new Error("Map missing");
  await page.mouse.move(box.x+box.width*.2,box.y+box.height*.22);
  await page.mouse.down();
  await page.mouse.move(box.x+box.width*.65,box.y+box.height*.65,{steps:12});
  await page.mouse.up();
  await expect(page.getByText("Software Hiring Company")).toBeVisible();
  expect(received).toMatchObject({provider:"google",goal:"it",category:"all",googleExpanded:true});
  await expect(page.locator(".history-entry")).toHaveCount(1);
  const stored=await page.evaluate(()=>localStorage.getItem("geoscout:search-history:v1"));
  expect(stored).toContain("ChIJTestingOnly");
  expect(stored).not.toContain("Software Hiring Company");
  await page.locator(".history-entry").getByRole("button",{name:"Open"}).click();
  await expect(page.getByText(/Saved Google Maps Place IDs/)).toBeVisible();
  expect(calls).toBe(1);
});

test("reopening a saved OSM search avoids a second API request",async({page})=>{
  let calls=0;
  await page.route("**/api/search",async route=>{
    calls++;
    await route.fulfill({status:200,contentType:"application/json",
      body:JSON.stringify({
        businesses:[{
          id:"node/4321",name:"Existing Café",category:"cafe",categoryGroup:"food",
          website:"https://example.com",phone:null,email:null,address:"123 Harbour Road",
          city:"St. John's",location:{latitude:47.57,longitude:-52.7},
          source:"openstreetmap",sourceUrl:"https://www.openstreetmap.org/node/4321",
          sources:["openstreetmap"],confidence:null,
        }],
        count:1,truncated:false,searchedAt:new Date().toISOString(),
        provider:"osm",sources:[{name:"OpenStreetMap",license:"ODbL 1.0",
          attribution:"© OpenStreetMap contributors",url:"https://www.openstreetmap.org/copyright"}],
        warnings:[],
      }),
    });
  });
  await page.goto("/");
  const canvas=page.locator(".leaflet-host");
  await expect(canvas).toHaveClass(/leaflet-container/,{timeout:15000});
  const box=await canvas.boundingBox();
  if(!box)throw Error("map missing");
  await page.mouse.move(box.x+box.width*.2,box.y+box.height*.2);
  await page.mouse.down();
  await page.mouse.move(box.x+box.width*.6,box.y+box.height*.6,{steps:10});
  await page.mouse.up();
  await expect(page.locator(".results-count")).toHaveText("1");
  await expect(page.locator(".history-entry")).toHaveCount(1);
  expect(calls).toBe(1);
  await page.locator(".history-entry").getByRole("button",{name:"Open"}).click();
  await expect(page.getByText(/Restored from your browser/)).toBeVisible();
  await expect(page.getByLabel("Business search JSON preview")).toContainText("Existing Café");
  expect(calls).toBe(1);
  await page.locator(".history-entry").getByRole("button",{name:/Refresh/i}).click();
  await expect.poll(()=>calls).toBe(2);
});
