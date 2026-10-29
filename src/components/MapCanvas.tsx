"use client";

import { useEffect, useRef, useState } from "react";
import type * as Leaflet from "leaflet";
import type { Business, Position } from "@/lib/types";

interface Props {
  polygon: Position[] | null;
  businesses: Business[];
  selectedBusinessId: string | null;
  focusLocation?: { latitude: number; longitude: number; boundingbox: number[] | null } | null;
  onPolygonChange: (polygon: Position[] | null) => void;
  onSelectBusiness: (id: string) => void;
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char] || char);
}

export default function MapCanvas({
  polygon, businesses, selectedBusinessId, focusLocation, onPolygonChange, onSelectBusiness,
}: Props) {
  const elementRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Leaflet.Map | null>(null);
  const leafletRef = useRef<typeof Leaflet | null>(null);
  const drawnRef = useRef<Leaflet.FeatureGroup | null>(null);
  const rectangleDrawRef = useRef<Leaflet.Draw.Rectangle | null>(null);
  const [drawingRectangle, setDrawingRectangle] = useState(false);
  const markersRef = useRef<Leaflet.LayerGroup | null>(null);
  const onPolygonRef = useRef(onPolygonChange);
  const onSelectRef = useRef(onSelectBusiness);
  const [ready, setReady] = useState(false);

  useEffect(() => { onPolygonRef.current = onPolygonChange; }, [onPolygonChange]);
  useEffect(() => { onSelectRef.current = onSelectBusiness; }, [onSelectBusiness]);

  useEffect(() => {
    let disposed = false;
    async function initialize() {
      const L = await import("leaflet");
      await import("leaflet-draw");
      if (disposed || !elementRef.current || mapRef.current) return;
      leafletRef.current = L;
      const map = L.map(elementRef.current, { zoomControl: false, preferCanvas: true })
        .setView([47.565, -52.77], 11);
      mapRef.current = map;
      L.control.zoom({ position: "bottomright" }).addTo(map);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>',
      }).addTo(map);
      const drawn = new L.FeatureGroup();
      const markers = new L.LayerGroup();
      drawn.addTo(map);
      markers.addTo(map);
      drawnRef.current = drawn;
      markersRef.current = markers;
      const drawing = new L.Control.Draw({
        position: "topright",
        draw: {
          polygon: {
            allowIntersection: false,
            showArea: true,
            shapeOptions: { color: "#0f9a81", weight: 3, fillOpacity: 0.13 },
          },
          rectangle: { shapeOptions: { color: "#0f9a81", weight: 3, fillOpacity: 0.13 } },
          polyline: false, circle: false, circlemarker: false, marker: false,
        },
        edit: { featureGroup: drawn, remove: true },
      });
      map.addControl(drawing);

      const syncPolygon = (layer: Leaflet.Layer) => {
        const feature = (layer as Leaflet.Polygon).toGeoJSON();
        if (feature.geometry.type !== "Polygon") return;
        const ring = feature.geometry.coordinates[0];
        onPolygonRef.current(ring.map((pair) => [pair[0], pair[1]] as Position));
      };
      map.on(L.Draw.Event.CREATED, (event) => {
        const layer = (event as Leaflet.DrawEvents.Created).layer;
        drawn.clearLayers();
        drawn.addLayer(layer);
        rectangleDrawRef.current = null;
        setDrawingRectangle(false);
        syncPolygon(layer);
      });
      map.on(L.Draw.Event.DRAWSTOP, () => {
        rectangleDrawRef.current = null;
        setDrawingRectangle(false);
      });
      map.on(L.Draw.Event.EDITED, () => {
        drawn.eachLayer((layer) => syncPolygon(layer));
      });
      map.on(L.Draw.Event.DELETED, () => {
        if (drawn.getLayers().length === 0) onPolygonRef.current(null);
      });
      setReady(true);
      setTimeout(() => { if (!disposed) map.invalidateSize(); }, 100);
    }
    void initialize();
    return () => {
      disposed = true;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
      leafletRef.current = null;
      rectangleDrawRef.current?.disable();
      rectangleDrawRef.current = null;
      drawnRef.current = null;
      markersRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!ready || !markersRef.current || !leafletRef.current) return;
    const L = leafletRef.current;
    markersRef.current.clearLayers();
    // Avoid overwhelming the browser on large searches.
    businesses.slice(0, 700).forEach((business) => {
      const selected = business.id === selectedBusinessId;
      const marker = L.circleMarker([business.location.latitude, business.location.longitude], {
        radius: selected ? 9 : 5,
        weight: selected ? 3 : 1.5,
        color: "#fff",
        fillColor: selected ? "#143c39" : "#079984",
        fillOpacity: 0.95,
      });
      const website = business.website
        ? '<br><span style="color:#087b6c">Website available</span>' : "";
      marker.bindPopup(
        '<strong>' + escapeHtml(business.name) + '</strong><br>' +
        escapeHtml(business.category) + website,
      );
      marker.on("click", () => onSelectRef.current(business.id));
      marker.addTo(markersRef.current!);
    });
  }, [businesses, selectedBusinessId, ready]);

  useEffect(() => {
    if (!ready || !mapRef.current || !leafletRef.current || !focusLocation) return;
    const { latitude, longitude, boundingbox } = focusLocation;
    if (Array.isArray(boundingbox) && boundingbox.length === 4 &&
        boundingbox.every(Number.isFinite) && boundingbox[0] < boundingbox[1] &&
        boundingbox[2] < boundingbox[3]) {
      mapRef.current.fitBounds([
        [boundingbox[0], boundingbox[2]],
        [boundingbox[1], boundingbox[3]],
      ], { padding: [20, 20], maxZoom: 14 });
    } else {
      mapRef.current.setView([latitude, longitude], 12);
    }
  }, [ready, focusLocation]);

  function beginScreenshotSelection() {
    const map = mapRef.current;
    const L = leafletRef.current;
    if (!map || !L || drawingRectangle) return;
    // Like a screenshot selection: press, drag, and release to define the search box.
    // Actual map coordinates (not screenshot pixels) are sent to the search API.
    // @types/leaflet-draw expects a DrawMap with static members on the instance;
// at runtime Leaflet.Draw accepts the regular Leaflet map.
    const rectangle = new L.Draw.Rectangle(
      map as unknown as ConstructorParameters<typeof L.Draw.Rectangle>[0], {
      shapeOptions: { color: "#0f9a81", weight: 3, fillOpacity: 0.13 },
    });
    rectangleDrawRef.current = rectangle;
    setDrawingRectangle(true);
    rectangle.enable();
  }

  function useVisibleArea() {
    const map = mapRef.current;
    const L = leafletRef.current;
    const drawn = drawnRef.current;
    if (!map || !L || !drawn) return;
    const bounds = map.getBounds();
    const layer = L.rectangle(bounds, {
      color: "#0f9a81", weight: 3, fillOpacity: 0.13,
    });
    drawn.clearLayers();
    drawn.addLayer(layer);
    const nw = bounds.getNorthWest();
    const ne = bounds.getNorthEast();
    const se = bounds.getSouthEast();
    const sw = bounds.getSouthWest();
    const ring: Position[] = [
      [nw.lng, nw.lat], [ne.lng, ne.lat], [se.lng, se.lat],
      [sw.lng, sw.lat], [nw.lng, nw.lat],
    ];
    onPolygonRef.current(ring);
  }

  function clearArea() {
    rectangleDrawRef.current?.disable();
    rectangleDrawRef.current = null;
    setDrawingRectangle(false);
    drawnRef.current?.clearLayers();
    onPolygonRef.current(null);
  }

  return (
    <div className="map-shell">
      <div ref={elementRef} className="leaflet-host" aria-label="Interactive map of businesses" />
      <div className="map-overlay top-left">
        <span className="live-dot" /> MAP EXPLORER
      </div>
      <div className="map-overlay bottom-left">
        <button type="button" className={"map-action " + (drawingRectangle ? "drawing" : "")}
          onClick={beginScreenshotSelection} disabled={!ready || drawingRectangle}
          aria-label="Select region by dragging a rectangle on the map">
          {drawingRectangle ? "Drag to select…" : "▣ Select region"}
        </button>
        <button type="button" className="map-action secondary" onClick={useVisibleArea} disabled={!ready}>
          Use visible area
        </button>
        <button type="button" className="map-action secondary" onClick={clearArea} disabled={!polygon}>
          Clear selection
        </button>
      </div>
      <div className="map-help">
        {drawingRectangle
          ? "Click and drag over the map. Release to search automatically."
          : polygon
            ? "Area selected · Businesses search automatically · Resize using edit controls"
            : "Click Select region, then drag a rectangle across the map"}
      </div>
    </div>
  );
}
