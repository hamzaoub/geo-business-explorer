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
