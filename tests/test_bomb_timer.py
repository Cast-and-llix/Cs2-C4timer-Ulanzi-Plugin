"""Unit + HTTP tests for backend/bomb_timer.py.  Run: python -m unittest discover tests"""
import json
import os
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
import bomb_timer as bt  # noqa: E402


class FakeClock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def gsi(round_bomb=None, phase="live", **extra):
    p = {"round": {"phase": phase}, "map": {"name": "de_inferno"}}
    if round_bomb:
        p["round"]["bomb"] = round_bomb
    p.update(extra)
    return p


class TrackerTests(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.events = []
        self.t = bt.BombTracker(clock=self.clock, on_event=self.events.append)

    def test_idle_snapshot(self):
        s = self.t.snapshot()
        self.assertEqual(s["status"], "idle")
        self.assertIsNone(s["time_remaining"])
        self.assertFalse(s["gsi_connected"])

    def test_plant_countdown_phases(self):
        self.t.update_from_gsi(gsi("planted"))
        s = self.t.snapshot()
        self.assertEqual((s["status"], s["seconds"], s["phase"], s["source"]), ("planted", 40, "bomb", "gsi"))
        self.clock.t += 29.5          # 10.5 left -> displays 11
        self.assertEqual(self.t.snapshot()["phase"], "bomb")
        self.clock.t += 0.6           # 9.9 left -> 10
        s = self.t.snapshot()
        self.assertEqual((s["seconds"], s["phase"]), (10, "kit_only"))
        self.clock.t += 4.0           # 5.9 -> 6
        self.assertEqual(self.t.snapshot()["phase"], "kit_only")
        self.clock.t += 1.0           # 4.9 -> 5
        s = self.t.snapshot()
        self.assertEqual((s["seconds"], s["phase"]), (5, "too_late"))
        self.assertIn("kit_only", self.events)
        self.assertIn("too_late", self.events)

    def test_repeated_planted_does_not_restart(self):
        self.t.update_from_gsi(gsi("planted"))
        self.clock.t += 12
        self.t.update_from_gsi(gsi("planted"))
        self.assertEqual(self.t.snapshot()["seconds"], 28)

    def test_defuse_then_new_round(self):
        self.t.update_from_gsi(gsi("planted"))
        self.clock.t += 20
        self.t.update_from_gsi(gsi("defused", phase="over"))
        s = self.t.snapshot()
        self.assertEqual(s["status"], "defused")
        self.assertIsNone(s["time_remaining"])
        self.assertEqual(s["status_age"], 0)
        self.clock.t += 3
        self.t.update_from_gsi(gsi(None, phase="over"))   # still over, no bomb key -> keep result
        self.assertEqual(self.t.snapshot()["status"], "defused")
        self.t.update_from_gsi(gsi(None, phase="freezetime"))
        self.assertEqual(self.t.snapshot()["status"], "idle")

    def test_explode_reported(self):
        self.t.update_from_gsi(gsi("planted"))
        self.clock.t += 40.2
        self.t.update_from_gsi(gsi("exploded", phase="over"))
        s = self.t.snapshot()
        self.assertEqual((s["status"], s["inferred"]), ("exploded", False))

    def test_explode_inferred_when_gsi_silent(self):
        self.t.update_from_gsi(gsi("planted"))
        self.clock.t += 41
        self.assertEqual(self.t.snapshot()["status"], "planted")   # within grace, shows 0
        self.clock.t += 2
        s = self.t.snapshot()
        self.assertEqual((s["status"], s["inferred"]), ("exploded", True))
        self.t.update_from_gsi(gsi("exploded", phase="over"))      # GSI confirms
        self.assertFalse(self.t.snapshot()["inferred"])

    def test_spectator_countdown_hint_and_resync(self):
        self.t.update_from_gsi(gsi(None, bomb={"state": "planted", "countdown": "31.0"}))
        self.assertAlmostEqual(self.t.snapshot()["time_remaining"], 31.0, places=2)
        self.clock.t += 1
        self.t.update_from_gsi(gsi("planted", bomb={"state": "defusing", "countdown": "29.0"}))
        self.assertAlmostEqual(self.t.snapshot()["time_remaining"], 29.0, places=2)

    def test_phase_countdowns_hint(self):
        self.t.update_from_gsi(gsi("planted", phase_countdowns={"phase": "bomb", "phase_ends_in": "35.5"}))
        self.assertAlmostEqual(self.t.snapshot()["time_remaining"], 35.5, places=2)
        # defuse countdown must not be treated as bomb time
        self.t.update_from_gsi(gsi("planted", phase_countdowns={"phase": "defuse", "phase_ends_in": "4.0"}))
        self.assertAlmostEqual(self.t.snapshot()["time_remaining"], 35.5, places=2)

    def test_round_restart_while_planted_resets(self):
        self.t.update_from_gsi(gsi("planted"))
        self.t.update_from_gsi(gsi(None, phase="freezetime"))
        self.assertEqual(self.t.snapshot()["status"], "idle")

    def test_manual_mode(self):
        self.t.manual_start()
        s = self.t.snapshot()
        self.assertEqual((s["status"], s["source"]), ("planted", "manual"))
        self.t.update_from_gsi(gsi(None))            # GSI without a bomb must not cancel manual
        self.assertEqual(self.t.snapshot()["status"], "planted")
        self.clock.t += 40
        self.assertEqual(self.t.snapshot()["status"], "exploded")
        self.clock.t += 11
        self.assertEqual(self.t.snapshot()["status"], "idle")
        self.t.manual_start()
        self.t.manual_stop()
        self.assertEqual(self.t.snapshot()["status"], "idle")

    def test_gsi_plant_overrides_manual(self):
        self.t.manual_start()
        self.clock.t += 15
        self.t.update_from_gsi(gsi("planted"))
        s = self.t.snapshot()
        self.assertEqual((s["source"], s["seconds"]), ("gsi", 40))


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tracker = bt.BombTracker()
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), bt.make_handler(cls.tracker, "TOK"))
        cls.base = "http://127.0.0.1:%d" % cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def req(self, path, data=None, method=None):
        body = None if data is None else json.dumps(data).encode()
        r = urllib.request.Request(self.base + path, data=body, method=method)
        return urllib.request.urlopen(r, timeout=2)

    def test_state_has_cors_and_json(self):
        self.tracker.reset()
        with self.req("/state") as r:
            self.assertEqual(r.headers["Access-Control-Allow-Origin"], "*")
            self.assertIn("no-store", r.headers["Cache-Control"])
            s = json.loads(r.read())
        self.assertEqual(s["status"], "idle")
        for k in ("time_remaining", "seconds", "phase", "status_age", "bomb_time", "gsi_connected"):
            self.assertIn(k, s)

    def test_gsi_post_with_token(self):
        self.tracker.reset()
        with self.req("/", gsi("planted", auth={"token": "TOK"})) as r:
            self.assertEqual(r.status, 200)
        with self.req("/state") as r:
            s = json.loads(r.read())
        self.assertEqual((s["status"], s["gsi_connected"]), ("planted", True))
        self.tracker.reset()

    def test_gsi_bad_token_rejected(self):
        self.tracker.reset()
        with self.assertRaises(urllib.error.HTTPError) as cm:
            self.req("/", gsi("planted", auth={"token": "nope"}))
        self.assertEqual(cm.exception.code, 403)
        self.assertEqual(self.tracker.snapshot()["status"], "idle")

    def test_bad_json(self):
        r = urllib.request.Request(self.base + "/", data=b"{nope", method="POST")
        with self.assertRaises(urllib.error.HTTPError) as cm:
            urllib.request.urlopen(r, timeout=2)
        self.assertEqual(cm.exception.code, 400)

    def test_manual_endpoints_and_preflight(self):
        with self.req("/manual/start", {}) as r:
            self.assertEqual(json.loads(r.read())["source"], "manual")
        with self.req("/manual/stop", {}) as r:
            self.assertEqual(json.loads(r.read())["status"], "idle")
        with self.req("/state", method="OPTIONS") as r:
            self.assertEqual(r.status, 204)
            self.assertEqual(r.headers["Access-Control-Allow-Private-Network"], "true")


if __name__ == "__main__":
    unittest.main()
