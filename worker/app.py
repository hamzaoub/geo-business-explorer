"""Optional Overture Places GeoParquet search worker.

Run on a private/local network; never expose an unkeyed worker to the internet.
The worker performs bounding-box queries; the Next.js API performs exact
point-in-polygon filtering before serving results.
"""
from __future__ import annotations

import hmac
import os
import re
import threading
import time
from typing import Literal
from urllib.request import Request, urlopen

import duckdb
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator

LATEST_URL = "https://stac.overturemaps.org/catalog.json"
MAX_RESULTS = 2000
MAX_AREA_KM2 = 200.0
CATEGORY = Literal["all", "food", "retail", "services", "health", "stay"]
RELEASE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}\.\d+$")
CATEGORY_PATTERNS = {
    "food": r"restaurant|cafe|coffee|bakery|bar|pub|diner|food|pizz|beverage|tea|dessert|catering",
    "retail": r"shop|store|retail|market|supermarket|grocery|boutique|bakery|pharmacy",
    "services": r"salon|hair|beauty|repair|consult|office|agency|account|lawyer|plumb|electric|service|software|marketing|spa",
    "health": r"clinic|hospital|doctor|dentist|pharmacy|medical|health|veterinar|optometr",
    "stay": r"hotel|motel|inn|hostel|lodg|accommodation|guest.house|resort",
}

app = FastAPI(title="GeoScout Overture Worker", version="0.2.0", docs_url=None, redoc_url=None)
_lock = threading.Lock()
_cached_release: tuple[float, str] | None = None


class Bounds(BaseModel):
    model_config = ConfigDict(extra="forbid")
    south: float = Field(ge=-90, le=90)
    north: float = Field(ge=-90, le=90)
    west: float = Field(ge=-180, le=180)
    east: float = Field(ge=-180, le=180)
    approximateKm2: float = Field(ge=0, le=1800)

    @model_validator(mode="after")
    def validate_bounds(self):
        if self.north <= self.south or self.east <= self.west:
            raise ValueError("Invalid geographical bounds")
        latitude_km = (self.north - self.south) * 111.2
        longitude_km = (self.east - self.west) * 111.2 * abs(
            __import__("math").cos(__import__("math").radians((self.south + self.north) / 2))
        )
        if latitude_km * longitude_km > MAX_AREA_KM2:
            raise ValueError("Overture preview area is limited to 200 km²")
        return self


class SearchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    bounds: Bounds
    category: CATEGORY = "all"


def latest_release() -> str:
    global _cached_release
    pin = os.getenv("OVERTURE_RELEASE")
    if pin:
        if not RELEASE_PATTERN.fullmatch(pin):
            raise RuntimeError("OVERTURE_RELEASE must have format YYYY-MM-DD.X")
        return pin
    now = time.monotonic()
    if _cached_release and now - _cached_release[0] < 3600:
        return _cached_release[1]
    request = Request(
        LATEST_URL,
        headers={"User-Agent": "GeoScoutOvertureWorker/0.2 (data catalog reader)"},
    )
    import json
    with urlopen(request, timeout=10) as response:
        value = json.load(response)["latest"]
    if not isinstance(value, str) or not RELEASE_PATTERN.fullmatch(value):
        raise RuntimeError("Overture catalog provided an invalid release")
    _cached_release = (now, value)
    return value


def build_query(category: CATEGORY) -> tuple[str, list[str]]:
    """Only trusted release paths and fixed field identifiers become SQL."""
    filter_sql = ""
    pattern_parameters: list[str] = []
    if category != "all":
        filter_sql = "AND regexp_matches(COALESCE(taxonomy.primary, ''), ?, 'i')"
        pattern_parameters.append(CATEGORY_PATTERNS[category])
    query = f"""
        SELECT
            id,
            names.primary AS name,
            taxonomy.primary AS category,
            websites[1] AS website,
            phones[1] AS phone,
            emails[1] AS email,
            addresses[1].freeform AS address,
            addresses[1].locality AS city,
            bbox.ymin AS latitude,
            bbox.xmin AS longitude,
            confidence
        FROM read_parquet(?)
        WHERE bbox.xmin BETWEEN ? AND ?
          AND bbox.ymin BETWEEN ? AND ?
          AND names.primary IS NOT NULL
          {filter_sql}
        LIMIT {MAX_RESULTS + 1}
    """
    return query, pattern_parameters


def query_places(req: SearchRequest) -> dict:
    release = latest_release()
    parquet_glob = os.getenv("OVERTURE_PARQUET_GLOB") or (
        f"s3://overturemaps-us-west-2/release/{release}/theme=places/type=place/*"
    )
    con = duckdb.connect(":memory:")
    try:
        if parquet_glob.startswith("s3://"):
            con.execute("INSTALL httpfs")
            con.execute("LOAD httpfs")
            con.execute("SET s3_region = 'us-west-2'")
        query, category_params = build_query(req.category)
        rows = con.execute(
            query,
            [
                parquet_glob, req.bounds.west, req.bounds.east,
                req.bounds.south, req.bounds.north,
                *category_params,
            ],
        ).fetchall()
    finally:
        con.close()
    result = []
    for row in rows[:MAX_RESULTS]:
        id_, name, category, website, phone, email, address, city, lat, lon, confidence = row
        result.append({
            "id": str(id_),
            "name": name,
            "category": category,
            "website": website,
            "phone": phone,
            "email": email,
            "address": address,
            "city": city,
            "latitude": lat,
            "longitude": lon,
            "confidence": confidence,
        })
    return {
        "release": release,
        "businesses": result,
        "truncated": len(rows) > MAX_RESULTS,
    }


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "overture", "configured": True}


@app.post("/search")
def search(
    req: SearchRequest,
    x_worker_key: str | None = Header(default=None),
) -> dict:
    expected = os.getenv("OVERTURE_WORKER_KEY")
    if expected and not hmac.compare_digest(x_worker_key or "", expected):
        raise HTTPException(status_code=401, detail="Unauthorized")
    if not _lock.acquire(blocking=False):
        raise HTTPException(status_code=429, detail="Worker is busy; retry later")
    try:
        return query_places(req)
    except HTTPException:
        raise
    except Exception as exc:
        # Don't leak infrastructure paths/credentials to callers.
        print(f"Overture worker failed: {type(exc).__name__}: {exc}", flush=True)
        raise HTTPException(status_code=503, detail="Overture data unavailable") from exc
    finally:
        _lock.release()
