"use client";

import { useEffect, useRef, useState } from "react";
import type * as Leaflet from "leaflet";
import type { Business, Position } from "@/lib/types";

type MapMode = "select" | "move";
type SearchState = "idle" | "searching" | "success" | "error";

interface Props {
  polygon: Position[] | null;
  businesses: Business[];
  selectedBusinessId: string | null;
  resultCount?: number;
  googleResults?: boolean;
  focusLocation?: { latitude: number; longitude: number; boundingbox: number[] | null } | null;
  searchState?: SearchState;
  searchError?: string | null;
  onPolygonChange: (polygon: Position[] | null) => void;
  onSelectBusiness: (id: string) => void;
  onViewResults?: () => void;
}

interface Gesture {
  pointerId: number;
  start: Leaflet.Point;
  rectangle: Leaflet.Rectangle | null;
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char] || char);
}

function rectangleRing(bounds: Leaflet.LatLngBounds): Position[] {
  const { lat: north, lng: west } = bounds.getNorthWest();
  const { lat: south, lng: east } = bounds.getSouthEast();
  return [
    [west, north], [east, north], [east, south], [west, south], [west, north],
  ];
}

export default function MapCanvas({
  polygon, businesses, selectedBusinessId, focusLocation,
  resultCount, googleResults = false,
  searchState = "idle", searchError = null,
  onPolygonChange, onSelectBusiness, onViewResults,
}: Props) {
  const elementRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Leaflet.Map | null>(null);
  const leafletRef = useRef<typeof Leaflet | null>(null);
  const selectionRef = useRef<Leaflet.Rectangle | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const markersRef = useRef<Leaflet.LayerGroup | null>(null);
  const onPolygonRef = useRef(onPolygonChange);
  const onSelectRef = useRef(onSelectBusiness);
  const modeRef = useRef<MapMode>("select");

  const [mode, setMode] = useState<MapMode>("select");
  const [ready, setReady] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [tip, setTip] = useState("Drag anywhere on the map to select a region");

  useEffect(() => { onPolygonRef.current = onPolygonChange; }, [onPolygonChange]);
  useEffect(() => { onSelectRef.current = onSelectBusiness; }, [onSelectBusiness]);

  useEffect(() => {
    let disposed = false;
    let localMap: Leaflet.Map | null = null;
    let removeListeners: (() => void) | null = null;

    async function initialize() {
      // No leaflet-draw plugin: native pointer events make selection one direct drag.
      const L = await import("leaflet");
      const element = elementRef.current;
      if (disposed || !element || mapRef.current) return;

      const map = L.map(element, { zoomControl: false, preferCanvas: true })
        .setView([47.565, -52.77], 11);
      localMap = map;
      mapRef.current = map;
      leafletRef.current = L;
      map.dragging.disable();
      map.boxZoom.disable();
      map.doubleClickZoom.enable();
      L.control.zoom({ position: "bottomright" }).addTo(map);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>',
      }).addTo(map);

      const markers = L.layerGroup().addTo(map);
      markersRef.current = markers;

      const pointFromEvent = (event: PointerEvent) => {
        const box = element.getBoundingClientRect();
        return L.point(
          Math.max(0, Math.min(element.clientWidth, event.clientX - box.left)),
          Math.max(0, Math.min(element.clientHeight, event.clientY - box.top)),
        );
      };

      const clearDraft = () => {
        const gesture = gestureRef.current;
        if (gesture?.rectangle && map.hasLayer(gesture.rectangle)) {
          map.removeLayer(gesture.rectangle);
        }
        gestureRef.current = null;
        setDragging(false);
      };

      const handleDown = (event: PointerEvent) => {
        if (modeRef.current !== "select" || event.button !== 0 ||
            !event.isPrimary || gestureRef.current) return;
        const target = event.target;
        if (target instanceof Element &&
            target.closest(".leaflet-control, .leaflet-popup")) return;
        event.preventDefault();
        try { element.setPointerCapture(event.pointerId); } catch { /* older browsers */ }
        gestureRef.current = { pointerId: event.pointerId, start: pointFromEvent(event), rectangle: null };
      };

      const handleMove = (event: PointerEvent) => {
        const gesture = gestureRef.current;
        if (!gesture || event.pointerId !== gesture.pointerId) return;
        const current = pointFromEvent(event);
        if (!gesture.rectangle &&
            Math.hypot(current.x - gesture.start.x, current.y - gesture.start.y) < 7) return;
        const bounds = L.latLngBounds(
          map.containerPointToLatLng(gesture.start),
          map.containerPointToLatLng(current),
        );
        if (!gesture.rectangle) {
          if (selectionRef.current) map.removeLayer(selectionRef.current);
          selectionRef.current = null;
          gesture.rectangle = L.rectangle(bounds, {
            color: "#0c9b81", weight: 3, fillColor: "#26c69a",
            fillOpacity: 0.18, interactive: false,
          }).addTo(map);
          setDragging(true);
          setTip("Release to discover businesses in this area");
        } else {
          gesture.rectangle.setBounds(bounds);
        }
      };

      const handleUp = (event: PointerEvent) => {
        const gesture = gestureRef.current;
        if (!gesture || event.pointerId !== gesture.pointerId) return;
        try {
          if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
        } catch { /* browser can release capture automatically */ }

        const current = pointFromEvent(event);
        gestureRef.current = null;
        setDragging(false);
        if (!gesture.rectangle ||
            Math.abs(current.x - gesture.start.x) < 8 ||
            Math.abs(current.y - gesture.start.y) < 8) {
          if (gesture.rectangle && map.hasLayer(gesture.rectangle)) map.removeLayer(gesture.rectangle);
          setTip("Drag a wider rectangle to select a region");
          return;
        }
        selectionRef.current = gesture.rectangle;
        setTip("Area selected — finding businesses…");
        onPolygonRef.current(rectangleRing(gesture.rectangle.getBounds()));
      };

      const handleCancel = () => clearDraft();

      element.addEventListener("pointerdown", handleDown);
      element.addEventListener("pointermove", handleMove);
      element.addEventListener("pointerup", handleUp);
      element.addEventListener("pointercancel", handleCancel);
      removeListeners = () => {
        element.removeEventListener("pointerdown", handleDown);
        element.removeEventListener("pointermove", handleMove);
        element.removeEventListener("pointerup", handleUp);
        element.removeEventListener("pointercancel", handleCancel);
      };

      setReady(true);
      window.setTimeout(() => { if (!disposed) map.invalidateSize(); }, 120);
    }

    void initialize().catch((error: unknown) => {
      if (!disposed) {
        console.error("Map initialization failed", error);
        setMapError("The map could not load. Refresh the page and try again.");
      }
    });
    return () => {
      disposed = true;
      removeListeners?.();
      localMap?.remove();
      mapRef.current = null;
      leafletRef.current = null;
      markersRef.current = null;
      selectionRef.current = null;
      gestureRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    modeRef.current = mode;
    if (mode === "select") map.dragging.disable();
    else map.dragging.enable();
    setTip(mode === "select"
      ? "Drag anywhere on the map to select a region"
      : "Drag to move the map; scroll or use + / − to zoom");
  }, [mode, ready]);

  useEffect(() => {
    const map = mapRef.current;
    const L = leafletRef.current;
    if (!ready || !map || !L || gestureRef.current) return;
    if (selectionRef.current) {
      map.removeLayer(selectionRef.current);
      selectionRef.current = null;
    }
    if (polygon && polygon.length >= 4) {
      const points = polygon.map(([lng, lat]) => L.latLng(lat, lng));
      selectionRef.current = L.rectangle(L.latLngBounds(points), {
        color: "#0c9b81", weight: 3, fillColor: "#26c69a",
        fillOpacity: 0.18, interactive: false,
      }).addTo(map);
    }
  }, [ready, polygon]);

  useEffect(() => {
    if (!ready || !mapRef.current || !leafletRef.current || !markersRef.current) return;
    const L = leafletRef.current;
    const markers = markersRef.current;
    markers.clearLayers();
    businesses.slice(0, 700).forEach((business) => {
      const selected = business.id === selectedBusinessId;
      const marker = L.circleMarker([business.location.latitude, business.location.longitude], {
        radius: selected ? 9 : 5,
        weight: selected ? 3 : 1.5,
        color: "#fff", fillColor: selected ? "#143c39" : "#079984", fillOpacity: 0.95,
      });
      marker.bindPopup(
        "<strong>" + escapeHtml(business.name) + "</strong><br>" +
        escapeHtml(business.category) +
        (business.website ? '<br><span style="color:#087b6c">Website listed</span>' : ""),
      );
      marker.on("click", () => onSelectRef.current(business.id));
      marker.addTo(markers);
    });
  }, [businesses, selectedBusinessId, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !focusLocation) return;
    const { latitude, longitude, boundingbox } = focusLocation;
    if (Array.isArray(boundingbox) && boundingbox.length === 4 &&
        boundingbox.every(Number.isFinite) && boundingbox[0] < boundingbox[1] &&
        boundingbox[2] < boundingbox[3]) {
      map.fitBounds([[boundingbox[0], boundingbox[2]], [boundingbox[1], boundingbox[3]]], {
        padding: [24, 24], maxZoom: 14,
      });
    } else {
      map.setView([latitude, longitude], 12);
    }
  }, [ready, focusLocation]);

  function clearArea() {
    const map = mapRef.current;
    if (map && selectionRef.current) map.removeLayer(selectionRef.current);
    selectionRef.current = null;
    setTip("Drag anywhere on the map to select a region");
    onPolygonRef.current(null);
  }

  return (
    <div className="map-shell">
      <div
        ref={elementRef}
        className={"leaflet-host " + (mode === "select" ? "map-select-cursor" : "map-move-cursor")}
        aria-label="Interactive business map; drag to select a geographic region"
      />
      <div className="map-overlay top-left">
        <span className="live-dot" /> SELECT AN AREA
      </div>
      <div className="map-mode-picker" role="group" aria-label="Map interaction mode">
        <button type="button" className={mode === "select" ? "active" : ""}
          aria-pressed={mode === "select"} onClick={() => setMode("select")}>
          ▣ Select area
        </button>
        <button type="button" className={mode === "move" ? "active" : ""}
          aria-pressed={mode === "move"} onClick={() => setMode("move")}>
          ✥ Move map
        </button>
      </div>
      {polygon && (
        <button type="button" className="map-clear-button" onClick={clearArea}>✕ Clear area</button>
      )}
      <div className="map-feedback" role="status" aria-live="polite">
        {mapError ? (
          <span className="map-feedback-error">{mapError}</span>
        ) : !ready ? (
          <span>Loading map…</span>
        ) : dragging ? (
          <span className="map-feedback-active">▣ Release to search this region</span>
        ) : searchState === "searching" ? (
          <span className="map-feedback-active"><span className="map-spinner" /> Searching the selected area…</span>
        ) : searchState === "error" ? (
          <span className="map-feedback-error">⚠ {searchError || "Business search failed. Try again."}</span>
        ) : searchState === "success" ? (
          <span className="map-feedback-success">
            ✓ {resultCount ?? businesses.length} businesses found
            <button type="button" onClick={onViewResults}>{googleResults ? "View places ↓" : "View JSON ↓"}</button>
          </span>
        ) : (
          <span>{tip}</span>
        )}
      </div>
    </div>
  );
}
