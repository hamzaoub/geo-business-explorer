"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { buildJsonPayload, exportCsv, exportJson } from "@/lib/export";
import type { Business, Category, Position, SearchGoal, SearchProvider, SearchResponse, WebsiteFilter } from "@/lib/types";
import { IT_EMPLOYER_TARGETS, IT_EMPLOYER_TYPES } from "@/lib/target-presets";
import { readSearchHistory, recordSearchHistory, reusableSnapshot,
  removeSearchHistory, type SearchHistoryEntry, type SearchIdentity } from "@/lib/search-history";

const MapCanvas = dynamic(() => import("@/components/MapCanvas"), {
  ssr: false,
  loading: () => <div className="map-loading">Initializing interactive map…</div>,
});

const CATEGORIES: { id: Category; label: string; icon: string }[] = [
  { id: "all", label: "All businesses", icon: "◈" },
  { id: "food", label: "Food & drink", icon: "◉" },
  { id: "retail", label: "Retail", icon: "▣" },
  { id: "services", label: "Professional services", icon: "◇" },
  { id: "health", label: "Health", icon: "✳" },
  { id: "stay", label: "Accommodation", icon: "⌂" },
];

export default function ExplorerPage() {
  const [polygon, setPolygon] = useState<Position[] | null>(null);
  const [category, setCategory] = useState<Category>("all");
  const [goal, setGoal] = useState<SearchGoal>("general");
  const [provider, setProvider] = useState<SearchProvider>("osm");
  const [overtureAvailable, setOvertureAvailable] = useState(false);
  const [geoapifyAvailable, setGeoapifyAvailable] = useState(false);
  const [googleAvailable, setGoogleAvailable] = useState(false);
  const [googleExpanded, setGoogleExpanded] = useState(false);
  const [googleContactsEnabled, setGoogleContactsEnabled] = useState(false);
  const [googleRequestBudget, setGoogleRequestBudget] = useState(6);
  const [googleItRequestBudget, setGoogleItRequestBudget] = useState(6);
  const [googleAutomatic, setGoogleAutomatic] = useState(false);
  const [geocoderAvailable, setGeocoderAvailable] = useState(false);
  const [placeQuery, setPlaceQuery] = useState("");
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [focusLocation, setFocusLocation] = useState<{
    latitude: number; longitude: number; boundingbox: number[] | null;
  } | null>(null);
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<SearchHistoryEntry[]>([]);
  const [historyPreview, setHistoryPreview] = useState<SearchHistoryEntry | null>(null);
  const [historyNotice, setHistoryNotice] = useState<string | null>(null);
  const [textFilter, setTextFilter] = useState("");
  const [websiteFilter, setWebsiteFilter] = useState<WebsiteFilter>("all");
  const [selectedBusinessId, setSelectedBusinessId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [viewMode, setViewMode] = useState<"table" | "json">("json");
  const activeRequest = useRef<AbortController | null>(null);
  const resultsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => () => { activeRequest.current?.abort(); }, []);
  useEffect(() => { setHistory(readSearchHistory()); }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/capabilities", { cache: "no-store" })
      .then((response) => response.json())
      .then((data: {
        providers?: { overture?: boolean; geoapify?: boolean; google?: boolean };
        google?: { includeContacts?: boolean; requestBudget?: number; itRequestBudget?: number; automatic?: boolean };
      }) => {
        if (!cancelled) {
          setOvertureAvailable(Boolean(data.providers?.overture));
          setGeoapifyAvailable(Boolean(data.providers?.geoapify));
          setGoogleAvailable(Boolean(data.providers?.google));
          setGoogleContactsEnabled(Boolean(data.google?.includeContacts));
          if (data.google?.requestBudget) setGoogleRequestBudget(data.google.requestBudget);
          if (data.google?.itRequestBudget) setGoogleItRequestBudget(data.google.itRequestBudget);
          setGoogleAutomatic(Boolean(data.google?.automatic));
          if (data.providers?.geoapify) setProvider("geoapify");
          setGeocoderAvailable(Boolean((data as { geocoder?: boolean }).geocoder));
        }
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const businesses = result?.businesses ?? [];
  const filtered = useMemo(() => businesses.filter((business) => {
    const text = textFilter.toLocaleLowerCase().trim();
    const matchesText = !text || [
      business.name, business.category, business.address, business.city,
    ].some((value) => value?.toLocaleLowerCase().includes(text));
    const matchesWebsite = websiteFilter === "all" ||
      (websiteFilter === "with" ? Boolean(business.website) : !business.website);
    return matchesText && matchesWebsite;
  }), [businesses, textFilter, websiteFilter]);

  const websites = businesses.filter((b) => Boolean(b.website)).length;
  const phones = businesses.filter((b) => Boolean(b.phone)).length;
  const pageSize = 25;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageResults = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  function cancelSearch() {
    activeRequest.current?.abort();
    activeRequest.current = null;
    setLoading(false);
  }

  async function runSearch(
    selectedArea: Position[] | null = polygon,
    selectedProvider: SearchProvider = provider,
    refresh = false,
    overrides: { goal?: SearchGoal; category?: Category; expanded?: boolean } = {},
  ) {
    if (!selectedArea) return;
    activeRequest.current?.abort();
    const selectedGoal = overrides.goal ?? goal;
    const selectedCategory = overrides.category ?? category;
    const expanded = overrides.expanded ?? googleExpanded;
    const identity: SearchIdentity = {
      polygon: selectedArea, provider: selectedProvider, category: selectedCategory,
      goal: selectedGoal, googleExpanded: expanded,
    };
    setResult(null);
    setError(null);
    setSelectedBusinessId(null);
    setHistoryPreview(null);
    setHistoryNotice(null);
    if (!refresh) {
      const cached = reusableSnapshot(identity);
      if (cached) {
        activeRequest.current = null;
        setLoading(false);
        setResult(cached);
        setTextFilter("");
        setWebsiteFilter("all");
        setPage(1);
        setViewMode("json");
        setHistoryNotice("Loaded recent saved results — no API request.");
        return;
      }
    }
    const controller = new AbortController();
    activeRequest.current = controller;
    setLoading(true);
    try {
      const response = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          polygon: selectedArea, category: selectedCategory, provider: selectedProvider,
          goal: selectedGoal,
          targetTypes: selectedGoal === "it" ? IT_EMPLOYER_TYPES : [],
          googleExpanded: selectedProvider === "google" && expanded,
        }),
        signal: controller.signal,
      });
      const json: unknown = await response.json();
      if (!response.ok) {
        const message = json && typeof json === "object" && "error" in json
          ? String(json.error) : "Search was unsuccessful.";
        throw new Error(message);
      }
      if (activeRequest.current !== controller) return;
      const data = json as SearchResponse;
      setResult(data);
      setHistory(recordSearchHistory(identity,data));
      setTextFilter("");
      setWebsiteFilter("all");
      setPage(1);
      setViewMode(selectedProvider === "google" ? "table" : "json");
    } catch (cause) {
      if (controller.signal.aborted || activeRequest.current !== controller) return;
      setError(cause instanceof Error ? cause.message : "Search failed.");
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        setLoading(false);
      }
    }
  }

  function openHistoryEntry(entry: SearchHistoryEntry, refresh = false) {
    cancelSearch();
    setProvider(entry.provider);
    setCategory(entry.category);
    setGoal(entry.goal);
    setGoogleExpanded(entry.googleExpanded);
    setPolygon(entry.polygon);
    setResult(null);
    setError(null);
    setHistoryPreview(null);
    setHistoryNotice(null);
    setTextFilter("");
    setWebsiteFilter("all");
    setPage(1);
    setSelectedBusinessId(null);
    const lng = entry.polygon.map(p=>p[0]),lat = entry.polygon.map(p=>p[1]);
    const west=Math.min(...lng),east=Math.max(...lng),south=Math.min(...lat),north=Math.max(...lat);
    setFocusLocation({
      latitude:(north+south)/2,longitude:(east+west)/2,
      boundingbox:[south,north,west,east],
    });
    if (refresh) {
      void runSearch(entry.polygon,entry.provider,true,{
        goal:entry.goal,category:entry.category,expanded:entry.googleExpanded,
      });
      return;
    }
    const saved = reusableSnapshot(entry);
    if (saved) {
      setResult(saved);
      setViewMode("json");
      setHistoryNotice("Restored from your browser — 0 API requests.");
    } else {
      setHistoryPreview(entry);
      setHistoryNotice(entry.provider === "google"
        ? "Google history keeps Place IDs and search settings only. Refresh for live business details."
        : "The older search has no reusable snapshot. Click Refresh for current results.");
    }
  }

  function selectGoal(next: SearchGoal) {
    cancelSearch();
    setGoal(next);
    setResult(null);
    setError(null);
    setHistoryPreview(null);
    setHistoryNotice(null);
    setSelectedBusinessId(null);
    if (next === "it") {
      setCategory("all");
      setProvider("google");
    }
  }

  async function locatePlace(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!geocoderAvailable || locating || placeQuery.trim().length < 3) return;
    setLocating(true);
    setLocationError(null);
    try {
      const response = await fetch("/api/geocode?q=" + encodeURIComponent(placeQuery.trim()));
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Location search failed.");
      setFocusLocation({
        latitude: data.latitude, longitude: data.longitude, boundingbox: data.boundingbox,
      });
    } catch (error) {
      setLocationError(error instanceof Error ? error.message : "Location unavailable.");
    } finally {
      setLocating(false);
    }
  }

  function selectCategory(next: Category) {
    cancelSearch();
    setCategory(next);
    setResult(null);
    setError(null);
    setSelectedBusinessId(null);
  }

  function selectProvider(next: SearchProvider) {
    cancelSearch();
    setProvider(next);
    if (next !== "google") setGoal("general");
    setResult(null);
    setError(null);
    setSelectedBusinessId(null);
  }

  function changePolygon(next: Position[] | null) {
    cancelSearch();
    setHistoryNotice(null);
    setPolygon(next);
    setResult(null);
    setError(null);
    setSelectedBusinessId(null);
    // The user's mouse release on the map starts discovery immediately.
    if (next) void runSearch(next);
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><span>✳</span></div>
          <span>geo<span className="brand-accent">scout</span></span>
          <span className="brand-badge">BETA</span>
        </div>
        <div className="topbar-right">
          <span className="nav-muted">Business intelligence, mapped.</span>
          <span className="source-badge"><span className="source-dot" /> {provider === "both" ? "OSM + Overture" : provider === "overture" ? "Overture Maps" : provider === "geoapify" ? "Geoapify Places" : provider === "google" ? "Google Maps Places" : "OpenStreetMap data"}</span>
        </div>
      </header>

      <main className="workspace">
        <aside className="sidebar">
          <div className="side-header">
            <span className="eyebrow">DISCOVER / EXPORT / GROW</span>
            <h1>Find your next<br /><em>opportunity.</em></h1>
            <p>Turn any area on the map into a list of real, publicly mapped businesses.</p>
          </div>

          <div className="steps">
            <div className="step-heading"><span className="step-number">01</span><strong>Select an area</strong></div>
            <p><strong>Drag directly on the map</strong> to select your area. The search starts when you release the mouse. Use Move map when you want to navigate.</p>
            <div className={"selection-indicator " + (polygon ? "active" : "")}>
              <span>{polygon ? "✓" : "⌖"}</span>
              <span>{loading ? "Scanning your selected area…" : polygon ? "Area selected · search automatic" : "No area selected yet"}</span>
            </div>
          </div>

          <div className="steps">
            <div className="step-heading"><span className="step-number">02</span><strong>What are you looking for?</strong></div>
            <div className="search-goals" role="group" aria-label="What are you looking for?">
              <button type="button" className={goal === "general" ? "selected" : ""}
                aria-pressed={goal === "general"} onClick={() => selectGoal("general")}>
                <strong>◈ Any business</strong><small>Standard discovery</small>
              </button>
              <button type="button" className={goal === "it" ? "selected" : ""}
                aria-pressed={goal === "it"} disabled={!googleAvailable}
                title={!googleAvailable ? "Connect Google Places to enable IT search" : ""}
                onClick={() => selectGoal("it")}>
                <strong>⌘ IT employers</strong><small>16 business types</small>
              </button>
            </div>
            {goal === "it" && (
              <div className="target-preview">
                <strong>{IT_EMPLOYER_TARGETS.length} IT employer target types</strong>
                <p>Potential employers, not verified job vacancies.
                  <strong> goal=it</strong> activates these targets; <strong>category=all</strong>
                  means no generic industry restriction.</p>
                <div className="target-chip-list">
                  {IT_EMPLOYER_TARGETS.map(item => (
                    <span key={item.type} title={item.type}>{item.label}</span>
                  ))}
                </div>
                <p>One lookup covers all types. Enable expanded Google search for broader coverage.</p>
              </div>
            )}
          </div>
          <div className="steps">
            <div className="step-heading"><span className="step-number">03</span><strong>Business category</strong></div>
            {goal === "it" ? (
              <p className="goal-category-note">All 16 IT employer types selected automatically.</p>
            ) : <div className="category-list" role="group" aria-label="Business category">
              {CATEGORIES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={"category-button " + (category === item.id ? "selected" : "")}
                  aria-pressed={category === item.id}
                  onClick={() => selectCategory(item.id)}
                >
                  <span className="category-icon">{item.icon}</span>
                  <span>{item.label}</span>
                  {category === item.id && <span className="category-check">✓</span>}
                </button>
              ))}
            </div>}
          </div>

          <div className="steps">
            <div className="step-heading"><span className="step-number">04</span><strong>Data sources</strong></div>
            <div className="source-list">
              <label className="source-option">
                <input type="radio" name="source" checked={provider === "osm"}
                  onChange={() => selectProvider("osm")} /> OpenStreetMap <span>Free · ready</span>
              </label>
              <label className="source-option">
                <input type="radio" name="source" disabled={!geoapifyAvailable}
                  checked={provider === "geoapify"} onChange={() => selectProvider("geoapify")} />
                Geoapify Places <span>{geoapifyAvailable ? "Connected · recommended" : "API key needed"}</span>
              </label>
              <label className="source-option">
                <input type="radio" name="source" disabled={!googleAvailable}
                  checked={provider === "google"} onChange={() => selectProvider("google")} />
                Google Places <span>{googleAvailable ? "Connected · live view" : "API key needed"}</span>
              </label>
              {provider === "google" && (
                <label className="google-expand-toggle">
                  <input type="checkbox" aria-label="Expanded Google live search"
                    checked={googleExpanded} onChange={e => {
                      cancelSearch();
                      setGoogleExpanded(e.target.checked);
                      setResult(null);
                      setError(null);
                    }} />
                  <span>
                    <strong>{goal === "it" ? "Nearby + tech company text search" : "Explore more Google categories"}</strong>
                    <small>Opt in: {googleAutomatic ? "auto mode" : "configured budget"} ·
                      up to {goal === "it" ? googleItRequestBudget : googleRequestBudget}
                      paid Google Places requests.
                      IT discovery uses 16 place types plus 10 tech-focused Text Search queries.
                      No guaranteed complete coverage or bulk export.</small>
                  </span>
                </label>
              )}
              <label className="source-option">
                <input type="radio" name="source" disabled={!overtureAvailable}
                  checked={provider === "overture"} onChange={() => selectProvider("overture")} />
                Overture Maps <span>{overtureAvailable ? "Connected" : "Worker needed"}</span>
              </label>
              <label className="source-option">
                <input type="radio" name="source" disabled={!overtureAvailable}
                  checked={provider === "both"} onChange={() => selectProvider("both")} />
                Combine both <span>{overtureAvailable ? "Recommended" : "Worker needed"}</span>
              </label>
            </div>
          </div>

          <div className="side-footer">
            <button
              type="button"
              className="search-button"
              onClick={() => void runSearch(polygon,provider,true)}
              disabled={!polygon || loading}
            >
              <span>{loading ? "Searching businesses…" : "Refresh live results"}</span>
              <span>{loading ? "◌" : "↗"}</span>
            </button>
            {error && <div className="error-notice" role="alert">{error}</div>}
            <p className="side-footnote">Search starts automatically when you release the mouse.
              Google Places results are live view-only and cannot be exported. Other sources support JSON/CSV.</p>
          </div>
          <div className="history-panel">
            <div className="history-heading">
              <strong>◷ Search history</strong>
              <span>{history.length} saved</span>
              {history.length > 0 && (
                <button type="button" onClick={() => {
                  setHistory(removeSearchHistory(null));
                  setHistoryPreview(null);
                  setHistoryNotice(null);
                }}>Clear all</button>
              )}
            </div>
            <p>Reuse recent searches on this device without making unnecessary API requests.</p>
            {history.length === 0 ? (
              <p className="history-empty">Draw a region to save your first search.</p>
            ) : (
              <div className="history-list">
                {history.slice(0,10).map(entry => (
                  <div className="history-entry" key={entry.key}>
                    <div className="history-entry-head">
                      <strong>{entry.goal === "it" ? "IT employers" : "All businesses"}
                        <small> · {entry.provider.toUpperCase()}</small></strong>
                      <button type="button" aria-label="Remove saved search"
                        onClick={() => setHistory(removeSearchHistory(entry.key))}>×</button>
                    </div>
                    <small>{entry.count} places · {new Date(entry.timestamp).toLocaleString()} ·
                      {entry.snapshot ? " reusable" : entry.provider === "google" ? " Place IDs only" : " metadata only"}</small>
                    <div className="history-actions">
                      <button type="button" onClick={() => openHistoryEntry(entry)}>Open</button>
                      <button type="button" onClick={() => openHistoryEntry(entry,true)}>Refresh ↗</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>

        <section className="content">
          <div className="content-heading">
            <div>
              <span className="section-kicker">LIVE GEOGRAPHIC DISCOVERY</span>
              <h2>Explore the map</h2>
            </div>
            <form className="location-search" onSubmit={(event) => void locatePlace(event)}>
              <input aria-label="Search for a city" value={placeQuery}
                onChange={(event) => setPlaceQuery(event.target.value)}
                placeholder={geocoderAvailable ? "Find a city or location…" : "City search needs configuration"}
                disabled={!geocoderAvailable || locating} />
              <button type="submit" disabled={!geocoderAvailable || locating || placeQuery.trim().length < 3}>
                {locating ? "Finding…" : "Find place ↗"}
              </button>
            </form>
          </div>
          {locationError && <div className="warning-notice" role="alert">{locationError}</div>}
          <div className="map-panel">
            <MapCanvas
              polygon={polygon}
              businesses={result?.provider === "google" ? [] : businesses}
              resultCount={businesses.length}
              googleResults={result?.provider === "google"}
              selectedBusinessId={selectedBusinessId}
              focusLocation={focusLocation}
              onPolygonChange={changePolygon}
              onSelectBusiness={setSelectedBusinessId}
              searchState={loading ? "searching" : error ? "error" : result ? "success" : "idle"}
              searchError={error}
              onViewResults={() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
            />
          </div>

          <div className="results" ref={resultsRef}>
            {historyNotice && <div className="history-loaded-notice" role="status">{historyNotice}</div>}
            {historyPreview?.provider === "google" && (
              <div className="google-history-ids">
                <strong>Saved Google Maps Place IDs ({historyPreview.googlePlaceIds?.length ?? 0})</strong>
                <p>Only Google Place IDs were retained. Refresh for current business details.
                  Opening a saved ID goes directly to Google Maps without a GeoScout API request.</p>
                <div className="history-id-links">
                  {(historyPreview.googlePlaceIds || []).slice(0,50).map(id => (
                    <a key={id} href={"https://www.google.com/maps/place/?q=place_id:" + encodeURIComponent(id)}
                      target="_blank" rel="noopener noreferrer">{id.slice(0,28)} ↗</a>
                  ))}
                </div>
                <button type="button" className="outline-button"
                  onClick={() => openHistoryEntry(historyPreview,true)}>Refresh Google search</button>
              </div>
            )}
            <div className="results-head">
              <div>
                <span className="section-kicker">YOUR DISCOVERY LIST</span>
                <h2>Business results <span className="results-count">{businesses.length}</span></h2>
              </div>
              <div className="export-actions" aria-label="Download search results">
                <button type="button" className="outline-button" disabled={!result || !filtered.length || result.provider === "google"}
                  title={result?.provider === "google" ? "Google Places business details cannot be exported. Use Geoapify or OSM." : "Download every currently filtered business as JSON"}
                  onClick={() => result && exportJson(filtered, polygon, result)}>↓ JSON</button>
                <button type="button" className="outline-button" disabled={!result || !filtered.length || result.provider === "google"}
                  title={result?.provider === "google" ? "Google Places business details cannot be exported. Use Geoapify or OSM." : "Download every currently filtered business as CSV"}
                  onClick={() => result && exportCsv(filtered, result)}>↓ CSV</button>
              </div>
            </div>

            {result && filtered.length > 0 && (
              <div className="export-guidance" role="note">
                {result.provider === "google" ? (
                  <>Google Places is a live-view source; its business details cannot be downloaded.
                    Use <strong>Geoapify Places</strong> or <strong>OpenStreetMap</strong> for an independent, exportable search of this area.</>
                ) : (
                  <>Export ready: <strong>{filtered.length.toLocaleString()}</strong> of
                    {" "}<strong>{businesses.length.toLocaleString()}</strong> discovered records.
                    JSON and CSV download <strong>all matching rows</strong>, not just the current table page.
                    Downloading or reopening saved results does not call the API again.</>
                )}
              </div>
            )}
            {result && (
              <div className="stat-row">
                <div><strong>{businesses.length.toLocaleString()}</strong><span>Businesses found</span></div>
                <div><strong>{websites.toLocaleString()}</strong><span>With websites</span></div>
                <div><strong>{phones.toLocaleString()}</strong><span>With phone numbers</span></div>
                <div><strong>{businesses.length - websites}</strong><span>No website listed</span></div>
              </div>
            )}

            {result && (
              <div className="filter-row">
                <input
                  className="filter-input"
                  aria-label="Filter businesses by name or location"
                  placeholder="Search by name, type, or address…"
                  value={textFilter}
                  onChange={(e) => { setTextFilter(e.target.value); setPage(1); }}
                />
                <select
                  className="filter-select"
                  aria-label="Filter by website availability"
                  value={websiteFilter}
                  onChange={(e) => { setWebsiteFilter(e.target.value as WebsiteFilter); setPage(1); }}
                >
                  <option value="all">All websites</option>
                  <option value="with">Has website</option>
                  <option value="without">No website listed</option>
                </select>
              </div>
            )}

            {result?.warnings.map((warning) => (
              <div key={warning} className="warning-notice">{warning}</div>
            ))}
            {result?.truncated && (
              <div className="warning-notice">
                {result.provider === "google"
                  ? "Google search results are source-limited, even with multiple category queries. Nearby Search cannot enumerate all businesses."
                  : "The provider returned only a partial result. Use a smaller area or increase the Geoapify page allowance when appropriate."}
              </div>
            )}

            {result?.provider === "google" && (
              <div className="google-places-notice">
                <strong className="google-maps-attribution" translate="no">Google Maps</strong>
                <span>Live Google Places results · up to 20 per request · no bulk collection or JSON/CSV export.
                  <strong className="google-call-count">
                    {googleContactsEnabled
                      ? "Phone and website fields enabled (Enterprise billing); missing values mean Google did not provide them."
                      : "Phone and website fields are disabled. Set GOOGLE_PLACES_INCLUDE_CONTACTS=true in .env.local for higher-tier retrieval."}
                    {" "}Google Places does not provide business email addresses. City is taken from Google's structured locality when supplied.
                  </strong>
                  {result.requestCount && (
                    <strong className="google-call-count">
                      {result.requestCount} Google API requests · {result.count} unique places shown.
                      {result.googleDiagnostics && (
                        <> {result.googleDiagnostics.nearbyRequests} Nearby +
                          {" "}{result.googleDiagnostics.textRequests} Text Search
                          across {result.googleDiagnostics.textQueries} targeted queries;
                          {" "}{result.googleDiagnostics.duplicatesRemoved} duplicates removed.
                          {result.googleDiagnostics.targetTypes.length > 0 &&
                            <> {result.googleDiagnostics.targetTypes.length} IT business types targeted.</>}
                        </>
                      )}
                    </strong>
                  )}
                  <a href="https://developers.google.com/maps/documentation/places/web-service/policies"
                    target="_blank" rel="noopener noreferrer"> View usage policies ↗</a>
                  {geoapifyAvailable && (
                    <button type="button" className="outline-button google-switch-provider"
                      onClick={() => {
                        selectProvider("geoapify");
                        void runSearch(polygon, "geoapify", false, {goal:"general"});
                      }}>
                      Find more businesses with Geoapify ↗
                    </button>
                  )}
                  {!geoapifyAvailable && (
                    <span> Add GEOAPIFY_API_KEY for broader exportable coverage, or use OpenStreetMap below.</span>
                  )}
                  <button type="button" className="outline-button google-switch-provider"
                    onClick={() => {
                      selectProvider("osm");
                      void runSearch(polygon, "osm", false, {goal:"general"});
                    }}>
                    Search exportable OpenStreetMap data ↗
                  </button>
                </span>
              </div>
            )}

            {result && result.provider !== "google" && (
              <div className="results-view-switch" role="group" aria-label="Results display">
                <button type="button" className={viewMode === "json" ? "active" : ""}
                  aria-pressed={viewMode === "json"} onClick={() => setViewMode("json")}>
                  {"{ }"} JSON preview
                </button>
                <button type="button" className={viewMode === "table" ? "active" : ""}
                  aria-pressed={viewMode === "table"} onClick={() => setViewMode("table")}>
                  ▤ Table
                </button>
                <span>{filtered.length} business records in the current filter</span>
              </div>
            )}

            {loading ? (
              <div className="empty-state scan-progress" role="status" aria-live="polite">
                <div className="scan-progress-wheel" />
                <strong>Searching businesses inside your selection…</strong>
                <p>Looking up places with the selected provider. Larger areas may take longer.</p>
              </div>
            ) : error ? (
              <div className="empty-state" role="alert">
                <div className="empty-icon">!</div>
                <strong>Could not retrieve businesses</strong>
                <p>{error}</p>
                <button type="button" className="outline-button" onClick={() => void runSearch()}>Try again</button>
              </div>
            ) : !result ? (
              <div className="empty-state">
                <div className="empty-icon">⌖</div>
                <strong>Every location holds a possibility.</strong>
                <p>Drag across the map to select a region. Release the mouse to search automatically and display JSON.</p>
              </div>
            ) : filtered.length === 0 ? (
              <div className="empty-state">
                <strong>No matching businesses</strong>
                <p>Try a different category, website filter, or selected area.</p>
              </div>
            ) : result.provider !== "google" && viewMode === "json" ? (
              <div className="json-pane">
                <div className="json-pane-top">
                  <span><span className="live-dot" /> businesses.json · read-only preview</span>
                  <span>Showing {Math.min(filtered.length, 25)} of {filtered.length} · Download for every record</span>
                </div>
                <pre aria-label="Business search JSON preview">
                  {JSON.stringify({
                    ...buildJsonPayload(filtered.slice(0, 25), polygon, result),
                    count: filtered.length,
                    preview: { first: Math.min(filtered.length, 25), fullResultsAvailableInDownload: true },
                  }, null, 2)}
                </pre>
              </div>
            ) : (
              <>
                <div className="table-scroll">
                  <table className="business-table">
                    <thead><tr><th>BUSINESS</th><th>CATEGORY</th><th>PHONE</th><th>WEBSITE</th><th>SOURCE</th></tr></thead>
                    <tbody>
                      {pageResults.map((business: Business) => (
                        <tr key={business.id} className={selectedBusinessId === business.id ? "row-selected" : ""}
                          onClick={() => setSelectedBusinessId(business.id)}>
                          <td><strong>{business.name}</strong><small>{business.address || business.city || "Address not listed"}</small></td>
                          <td><span className="pill">{business.category}</span></td>
                          <td>{business.phone || <span className="muted">—</span>}</td>
                          <td>{business.website
                            ? <a href={business.website} target="_blank" rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}>Visit site ↗</a>
                            : <span className="muted">Not listed</span>}</td>
                          <td><a href={business.sourceUrl} target="_blank" rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}>{business.sources.map(s => s === "overture" ? "Overture" : s === "geoapify" ? "Geoapify" : s === "google_places" ? "Google Maps" : "OSM").join(" + ")} ↗</a></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="pagination">
                  <span>Showing {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, filtered.length)} of {filtered.length}</span>
                  <div>
                    <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={currentPage === 1}>← Previous</button>
                    <span>Page {currentPage} / {totalPages}</span>
                    <button type="button" onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                      disabled={currentPage === totalPages}>Next →</button>
                  </div>
                </div>
              </>
            )}
            <div className="license-note">
              {result?.sources.some((s) => s.name === "Geoapify Places") && (
                <><a href="https://www.geoapify.com/" target="_blank" rel="noopener noreferrer">
                  Powered by Geoapify
                </a>{" · "}</>
              )}
              {result ? result.sources.map(s => s.attribution).join(" · ") : "© OpenStreetMap contributors"}.
              {" "}Source licenses and attribution apply to exports; combined databases may carry ODbL obligations.
              {" "}Search results are not exhaustive, and contact details may be outdated.
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

