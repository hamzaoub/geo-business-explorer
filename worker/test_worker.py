"""Offline tests — no downloads or live cloud query required."""
import os
import unittest

os.environ["OVERTURE_RELEASE"] = "2026-10-21.0"
from app import Bounds, SearchRequest, build_query, latest_release


class WorkerTests(unittest.TestCase):
    def test_latest_release_pin(self):
        self.assertEqual(latest_release(), "2026-10-21.0")

    def test_query_uses_parameterized_bounds(self):
        query, params = build_query("food")
        self.assertIn("read_parquet(?)", query)
        self.assertIn("bbox.xmin BETWEEN ? AND ?", query)
        self.assertIn("regexp_matches", query)
        self.assertEqual(len(params), 1)

    def test_all_query_has_no_category_param(self):
        query, params = build_query("all")
        self.assertEqual(params, [])
        self.assertNotIn("regexp_matches", query)

    def test_bounds_accept_small_area(self):
        req = SearchRequest(bounds=Bounds(
            south=47.54, north=47.58, west=-52.75, east=-52.70,
            approximateKm2=0,
        ), category="all")
        self.assertEqual(req.category, "all")

    def test_bounds_reject_oversized_area_even_if_claimed_small(self):
        with self.assertRaises(ValueError):
            Bounds(
                south=47.0, north=48.0, west=-53.0, east=-52.0,
                approximateKm2=0,
            )


if __name__ == "__main__":
    unittest.main()
