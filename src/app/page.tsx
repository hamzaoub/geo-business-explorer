"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { buildJsonPayload, exportCsv, exportJson } from "@/lib/export";
import type { Business, Category, Position, SearchProvider, SearchResponse, WebsiteFilter } from "@/lib/types";

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
  const [provider, setProvider] = useState<SearchProvider>("osm");
  const [overtureAvailable, setOvertureAvailable] = useState(false);
  const [geoapifyAvailable, setGeoapifyAvailable] = useState(false);
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
  const [textFilter, setTextFilter] = useState("");
  const [websiteFilter, setWebsiteFilter] = useState<WebsiteFilter>("all");
  const [selectedBusinessId, setSelectedBusinessId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [viewMode, setViewMode] = useState<"table" | "json">("json");
  const activeRequest = useRef<AbortController | null>(null);
  const resultsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => () => { activeRequest.current?.abort(); }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/capabilities", { cache: "no-store" })
      .then((response) => response.json())
      .then((data: { providers?: { overture?: boolean; geoapify?: boolean } }) => {
        if (!cancelled) {
          setOvertureAvailable(Boolean(data.providers?.overture));
          setGeoapifyAvailable(Boolean(data.providers?.geoapify));
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

  async function runSearch(selectedArea: Position[] | null = polygon) {
    if (!selectedArea) return;
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setLoading(true);
    setResult(null);
    setError(null);
    setSelectedBusinessId(null);
    try {
      const response = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ polygon: selectedArea, category, provider }),
        signal: controller.signal,
      });
      const json: unknown = await response.json();
      if (!response.ok) {
        const message = json && typeof json === "object" && "error" in json
          ? String(json.error) : "Search was unsuccessful.";
        throw new Error(message);
      }
      if (activeRequest.current !== controller) return;
      setResult(json as SearchResponse);
      setTextFilter("");
      setWebsiteFilter("all");
      setPage(1);
      setViewMode("json");
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
    setResult(null);
    setError(null);
    setSelectedBusinessId(null);
  }

  function changePolygon(next: Position[] | null) {
    cancelSearch();
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
          <span className="source-badge"><span className="source-dot" /> {provider === "both" ? "OSM + Overture" : provider === "overture" ? "Overture Maps" : provider === "geoapify" ? "Geoapify Places" : "OpenStreetMap data"}</span>
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
            <div className="step-heading"><span className="step-number">02</span><strong>Business category</strong></div>
            <div className="category-list" role="group" aria-label="Business category">
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
            </div>
          </div>

          <div className="steps">
            <div className="step-heading"><span className="step-number">03</span><strong>Data sources</strong></div>
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
              onClick={() => void runSearch()}
              disabled={!polygon || loading}
            >
              <span>{loading ? "Searching businesses…" : "Search area again"}</span>
              <span>{loading ? "◌" : "↗"}</span>
            </button>
            {error && <div className="error-notice" role="alert">{error}</div>}
            <p className="side-footnote">Searching begins automatically when you release the mouse. Data coverage depends on the selected sources; no source guarantees every business.</p>
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
              businesses={businesses}
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
            <div className="results-head">
              <div>
                <span className="section-kicker">YOUR DISCOVERY LIST</span>
                <h2>Business results <span className="results-count">{businesses.length}</span></h2>
              </div>
              <div className="export-actions">
                <button type="button" className="outline-button" disabled={!result || !filtered.length}
                  onClick={() => result && exportJson(filtered, polygon, result)}>↓ JSON</button>
                <button type="button" className="outline-button" disabled={!result || !filtered.length}
                  onClick={() => exportCsv(filtered)}>↓ CSV</button>
              </div>
            </div>

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
              <div className="warning-notice">Search result limit reached or a provider was unavailable. This is a partial result; select a smaller area for better coverage.</div>
            )}

            {result && (
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
                <p>Loading OpenStreetMap data. Larger areas may take longer.</p>
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
            ) : viewMode === "json" ? (
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
                              onClick={(e) => e.stopPropagation()}>{business.sources.map(s => s === "overture" ? "Overture" : s === "geoapify" ? "Geoapify" : "OSM").join(" + ")} ↗</a></td>
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
