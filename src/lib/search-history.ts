import type { Category, Position, SearchGoal, SearchProvider, SearchResponse } from "./types";

// Only non-Google results may be persisted as reusable result snapshots.
// Google history is limited to user-generated search parameters and Place IDs.
export const HISTORY_KEY = "geoscout:search-history:v1";
export const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
export const HISTORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_HISTORY = 20;
const MAX_STORAGE_BYTES = 2_800_000;

export interface SearchIdentity {
  polygon: Position[];
  provider: SearchProvider;
  category: Category;
  goal: SearchGoal;
  googleExpanded: boolean;
}

export interface SearchHistoryEntry extends SearchIdentity {
  key: string;
  timestamp: number;
  count: number;
  googlePlaceIds?: string[];
  snapshot?: SearchResponse;
}

function storage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; }
  catch { return null; }
}
function isPositionArray(input: unknown): input is Position[] {
  return Array.isArray(input) && input.length >= 4 && input.length <= 100 &&
    input.every((pos) => Array.isArray(pos) && pos.length === 2 &&
      pos.every((number: unknown) => typeof number === "number" && Number.isFinite(number)));
}
function isHistoryEntry(value: unknown): value is SearchHistoryEntry {
  return Boolean(value && typeof value === "object" &&
    "key" in value && typeof value.key === "string" &&
    "timestamp" in value && typeof value.timestamp === "number" &&
    "polygon" in value && isPositionArray(value.polygon) &&
    "provider" in value && typeof value.provider === "string" &&
    "category" in value && typeof value.category === "string" &&
    "goal" in value && (value.goal === "general" || value.goal === "it") &&
    "count" in value && typeof value.count === "number");
}

export function searchIdentityKey(identity: SearchIdentity): string {
  const lng = identity.polygon.map(p => p[0]);
  const lat = identity.polygon.map(p => p[1]);
  // Collapse winding order and repeated first vertex for rectangle selections.
  const bounds = [
    Math.min(...lng), Math.min(...lat), Math.max(...lng), Math.max(...lat),
  ].map(value => Number(value.toFixed(5)));
  return JSON.stringify([
    bounds, identity.provider, identity.category, identity.goal,
    identity.provider === "google" ? identity.googleExpanded : false,
  ]);
}

export function readSearchHistory(
  store: Storage | null = storage(),
  now = Date.now(),
): SearchHistoryEntry[] {
  if (!store) return [];
  try {
    const raw = store.getItem(HISTORY_KEY);
    if (!raw || raw.length > MAX_STORAGE_BYTES * 2) return [];
    const json: unknown = JSON.parse(raw);
    if (!Array.isArray(json)) return [];
    return json.filter(isHistoryEntry)
      .filter(entry => now - entry.timestamp < HISTORY_TTL_MS && entry.timestamp <= now + 60_000)
      .map(entry => {
        if (entry.provider === "google" ||
            now - entry.timestamp > SNAPSHOT_TTL_MS ||
            entry.snapshot?.provider !== entry.provider ||
            !Array.isArray(entry.snapshot?.businesses)) {
          const { snapshot: _snapshot, ...metadata } = entry;
          return metadata;
        }
        return entry;
      })
      .sort((a,b) => b.timestamp - a.timestamp)
      .slice(0,MAX_HISTORY);
  } catch { return []; }
}

function writeHistory(entries: SearchHistoryEntry[], store: Storage | null): void {
  if (!store) return;
  const working = entries.slice(0,MAX_HISTORY);
  // LocalStorage is small; preserve metadata before dropping older snapshots.
  while (working.length) {
    const payload = JSON.stringify(working);
    if (payload.length <= MAX_STORAGE_BYTES) {
      try { store.setItem(HISTORY_KEY,payload); }
      catch {
        try {
          const metadataOnly = working.map(({snapshot: _snapshot,...rest})=>rest);
          store.setItem(HISTORY_KEY,JSON.stringify(metadataOnly));
        } catch { /* privacy mode / quota restrictions */ }
      }
      return;
    }
    const fromEnd = [...working].reverse().find(item => item.snapshot);
    if (fromEnd) delete fromEnd.snapshot;
    else working.pop();
  }
}

export function recordSearchHistory(
  identity: SearchIdentity,
  response: SearchResponse,
  store: Storage | null = storage(),
  now = Date.now(),
): SearchHistoryEntry[] {
  const key = searchIdentityKey(identity);
  const old = readSearchHistory(store,now).filter(entry => entry.key !== key);
  const google = identity.provider === "google";
  const entry: SearchHistoryEntry = {
    ...identity, key, timestamp: now, count: response.count,
    ...(google ? {
      googlePlaceIds: [...new Set(response.businesses
        .map(item=>item.id.startsWith("google/") ? item.id.slice(7) : "")
        .filter(Boolean))].slice(0,500),
    } : { snapshot: response }),
  };
  const entries = [entry,...old].slice(0,MAX_HISTORY);
  writeHistory(entries,store);
  return readSearchHistory(store,now);
}

export function reusableSnapshot(
  identity: SearchIdentity,
  store: Storage | null = storage(),
  now = Date.now(),
): SearchResponse | null {
  // Google content is never read from history or persisted.
  if (identity.provider === "google") return null;
  const key = searchIdentityKey(identity);
  const entry = readSearchHistory(store,now).find(item => item.key === key);
  return entry?.snapshot ?? null;
}

export function removeSearchHistory(
  key: string | null,
  store: Storage | null = storage(),
): SearchHistoryEntry[] {
  if (!store) return [];
  if (key === null) {
    try { store.removeItem(HISTORY_KEY); } catch { /* unavailable storage */ }
    return [];
  }
  const entries = readSearchHistory(store).filter(entry=>entry.key !== key);
  writeHistory(entries,store);
  return entries;
}
