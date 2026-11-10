#!/usr/bin/env python3
"""
CS2 bomb timer backend.

* Receives Counter-Strike 2 Game State Integration (GSI) POSTs.
* Tracks the C4: idle -> planted -> defused / exploded -> idle.
* Serves the timer as JSON at  GET http://127.0.0.1:3000/state  (read by the Ulanzi plugin).
* Optional voice callouts (--voice): "Bomb planted", "Kit only", "Too late", "Defused".

One HTTP server handles both directions:
    POST /            <- CS2 GSI payloads (see gamestate_integration_bomb.cfg)
    GET  /state       -> timer JSON (CORS enabled so the plugin's WebView may fetch it)
    POST /manual/start, /manual/stop, /reset   -> testing helpers (curl)
    GET  /health      -> "ok"

Only the Python standard library is required. Python 3.8+.
"""
from __future__ import annotations

import argparse
import json
import logging
import math
import platform
import queue
import shutil
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Dict, Optional

__version__ = "1.0.0"

BOMB_SECONDS = 40.0          # CS2 C4 fuse
KIT_ONLY_AT = 10             # <= 10 s left: only a kit defuse (5 s) can make it
TOO_LATE_AT = 5              # <= 5 s left: too late for anybody
EXPLODE_GRACE = 2.5          # no "exploded" from GSI this long after 0 -> assume it blew up
GSI_STALE_AFTER = 30.0       # CS2 heartbeat is 10 s; older than this = game not sending

log = logging.getLogger("bomb_timer")


def phase_for(seconds: Optional[int]) -> Optional[str]:
    if seconds is None:
        return None
    if seconds > KIT_ONLY_AT:
        return "bomb"
    if seconds > TOO_LATE_AT:
        return "kit_only"
    return "too_late"


def _float(value: Any) -> Optional[float]:
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


class BombTracker:
    """Thread-safe bomb state machine. All times use time.monotonic()."""

    def __init__(self, bomb_seconds: float = BOMB_SECONDS, clock: Callable[[], float] = time.monotonic,
                 on_event: Optional[Callable[[str], None]] = None):
        self.bomb_seconds = float(bomb_seconds)
        self.clock = clock
        self.on_event = on_event or (lambda _e: None)
        self._lock = threading.RLock()
        self.status = "idle"            # idle | planted | defused | exploded
        self.source: Optional[str] = None   # gsi | manual
        self.planted_at: Optional[float] = None
        self.status_changed_at = self.clock()
        self.inferred = False           # True when "exploded" was assumed, not reported
        self.last_gsi_at: Optional[float] = None
        self.map_name: Optional[str] = None
        self.round_phase: Optional[str] = None
        self.player_team: Optional[str] = None
        self._announced: set = set()

    # ------------------------------------------------------------------ helpers
    def _set_status(self, status: str, source: Optional[str], now: float, inferred: bool = False) -> None:
        if status == self.status and source == self.source:
            self.inferred = self.inferred and inferred  # GSI confirmed what we assumed
            return
        log.info("bomb %s -> %s (%s%s)", self.status, status, source or "-", ", inferred" if inferred else "")
        self.status = status
        self.source = source
        self.status_changed_at = now
        self.inferred = inferred
        if status != "planted":
            self.planted_at = None if status == "idle" else self.planted_at
        self.on_event(status)

    def _remaining(self, now: float) -> Optional[float]:
        if self.status != "planted" or self.planted_at is None:
            return None
        return max(0.0, self.bomb_seconds - (now - self.planted_at))

    def _plant(self, now: float, source: str, remaining_hint: Optional[float] = None) -> None:
        elapsed = 0.0
        if remaining_hint is not None and 0 <= remaining_hint <= self.bomb_seconds + 1:
            elapsed = self.bomb_seconds - remaining_hint
        self.planted_at = now - elapsed
        self._announced = set()
        self._set_status("planted", source, now)

    # --------------------------------------------------------------- GSI input
    def update_from_gsi(self, payload: Dict[str, Any]) -> None:
        now = self.clock()
        with self._lock:
            self.last_gsi_at = now
            mp = payload.get("map") or {}
            if isinstance(mp, dict):
                self.map_name = mp.get("name", self.map_name)
            player = payload.get("player") or {}
            if isinstance(player, dict) and player.get("team"):
                self.player_team = player.get("team")

            rnd = payload.get("round")
            has_round = isinstance(rnd, dict)
            rnd = rnd if has_round else {}
            self.round_phase = rnd.get("phase", self.round_phase if not has_round else None)
            bomb_round = rnd.get("bomb")  # planted | defused | exploded | None (players + spectators)

            # Spectator / GOTV only: precise bomb state + countdown
            bomb_obj = payload.get("bomb") if isinstance(payload.get("bomb"), dict) else {}
            spec_state = bomb_obj.get("state")
            spec_countdown = _float(bomb_obj.get("countdown"))

            # phase_countdowns: phase "bomb" counts down the C4 when available
            pc = payload.get("phase_countdowns") if isinstance(payload.get("phase_countdowns"), dict) else {}
            pc_remaining = _float(pc.get("phase_ends_in")) if pc.get("phase") == "bomb" else None

            hint = None
            if spec_state in ("planted", "defusing") and spec_countdown is not None:
                hint = spec_countdown
            elif pc_remaining is not None:
                hint = pc_remaining

            if bomb_round == "planted" or spec_state in ("planted", "defusing"):
                if self.status != "planted" or self.source != "gsi":
                    self._plant(now, "gsi", hint)
                elif hint is not None:
                    current = self._remaining(now)
                    if current is not None and abs(current - hint) > 0.35:
                        log.debug("resync %.2f -> %.2f", current, hint)
                        self.planted_at = now - (self.bomb_seconds - hint)
            elif bomb_round == "defused" or spec_state == "defused":
                self._set_status("defused", "gsi", now)
            elif bomb_round == "exploded" or spec_state == "exploded":
                self._set_status("exploded", "gsi", now)
            elif has_round:
                # Round info present but no bomb: new round / warmup / bomb never planted.
                if self.source == "gsi" and self.status != "idle":
                    if self.status == "planted" or self.round_phase in ("freezetime", "live", None):
                        self._set_status("idle", None, now)

    # ------------------------------------------------------------- manual input
    def manual_start(self) -> None:
        with self._lock:
            self._plant(self.clock(), "manual")

    def manual_stop(self) -> None:
        with self._lock:
            if self.source == "manual":
                self._set_status("idle", None, self.clock())

    def reset(self) -> None:
        with self._lock:
            self._set_status("idle", None, self.clock())

    # ------------------------------------------------------------------ ticking
    def tick(self) -> None:
        """Advance time-based transitions and fire countdown callouts. Call ~10x/s."""
        now = self.clock()
        with self._lock:
            if self.source == "manual" and self.status in ("defused", "exploded") \
                    and now - self.status_changed_at > 10:
                self._set_status("idle", None, now)
            rem = self._remaining(now)
            if rem is None:
                return
            secs = math.ceil(rem - 1e-6)
            for mark, event in ((KIT_ONLY_AT, "kit_only"), (TOO_LATE_AT, "too_late")):
                if secs <= mark and event not in self._announced:
                    self._announced.add(event)
                    if secs > 0 and secs >= mark - 1:  # don't announce stale marks after a late resync
                        self.on_event(event)
            if rem <= 0:
                overdue = now - (self.planted_at + self.bomb_seconds)
                if self.source == "manual" or overdue >= EXPLODE_GRACE:
                    self._set_status("exploded", self.source, now, inferred=self.source != "manual")

    # -------------------------------------------------------------------- state
    def snapshot(self) -> Dict[str, Any]:
        self.tick()
        now = self.clock()
        with self._lock:
            rem = self._remaining(now)
            secs = None if rem is None else math.ceil(rem - 1e-6)
            gsi_age = None if self.last_gsi_at is None else now - self.last_gsi_at
            return {
                "status": self.status,
                "time_remaining": None if rem is None else round(rem, 3),
                "seconds": secs,
                "phase": phase_for(secs) if self.status == "planted" else self.status,
                "bomb_time": self.bomb_seconds,
                "source": self.source,
                "status_age": round(now - self.status_changed_at, 3),
                "inferred": self.inferred,
                "gsi_connected": gsi_age is not None and gsi_age < GSI_STALE_AFTER,
                "last_gsi_age": None if gsi_age is None else round(gsi_age, 3),
                "round_phase": self.round_phase,
                "map": self.map_name,
                "player_team": self.player_team,
                "server_time": time.time(),
                "version": __version__,
            }


# ------------------------------------------------------------------- voice
class Voice:
    """Fire-and-forget text-to-speech on a worker thread. No-op if nothing is available."""

    PHRASES = {"planted": "Bomb planted", "kit_only": "Kit only", "too_late": "Too late",
               "defused": "Bomb defused", "exploded": None}

    def __init__(self, enabled: bool):
        self.enabled = enabled
        self.q: "queue.Queue[str]" = queue.Queue()
        self._speak = self._pick_backend() if enabled else None
        if enabled and self._speak is None:
            log.warning("voice requested but no TTS found (pip install pyttsx3) - callouts disabled")
        if self._speak:
            threading.Thread(target=self._run, daemon=True).start()

    def _pick_backend(self) -> Optional[Callable[[str], None]]:
        try:
            import pyttsx3  # type: ignore

            engine = pyttsx3.init()
            engine.setProperty("rate", 210)

            def speak(text: str) -> None:
                engine.say(text)
                engine.runAndWait()
            return speak
        except Exception:  # noqa: BLE001 - optional dependency
            pass
        system = platform.system()
        if system == "Darwin" and shutil.which("say"):
            return lambda t: subprocess.run(["say", t], check=False)
        if system == "Windows":
            ps = ("Add-Type -AssemblyName System.Speech; "
                  "(New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak($args[0])")
            return lambda t: subprocess.run(["powershell", "-NoProfile", "-Command", ps, t], check=False,
                                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if shutil.which("espeak"):
            return lambda t: subprocess.run(["espeak", t], check=False)
        return None

    def event(self, name: str) -> None:
        phrase = self.PHRASES.get(name)
        if self._speak and phrase:
            self.q.put(phrase)

    def _run(self) -> None:
        while True:
            text = self.q.get()
            try:
                self._speak(text)  # type: ignore[misc]
            except Exception as exc:  # noqa: BLE001
                log.warning("voice error: %s", exc)


# -------------------------------------------------------------------- HTTP
def make_handler(tracker: BombTracker, token: Optional[str]):
    class Handler(BaseHTTPRequestHandler):
        server_version = "CS2BombTimer/" + __version__
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):  # route http.server logs to debug
            log.debug("%s - " + fmt, self.address_string(), *args)

        def _cors(self) -> None:
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Private-Network", "true")

        def _send(self, code: int, body: bytes = b"", ctype: str = "text/plain; charset=utf-8") -> None:
            self.send_response(code)
            self._cors()
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if body and self.command != "HEAD":
                self.wfile.write(body)

        def _json(self, obj: Any, code: int = 200) -> None:
            self._send(code, json.dumps(obj).encode("utf-8"), "application/json")

        def do_OPTIONS(self):  # CORS preflight
            self._send(204)

        def do_HEAD(self):
            self.do_GET()

        def do_GET(self):
            path = self.path.split("?", 1)[0].rstrip("/") or "/"
            if path == "/state":
                self._json(tracker.snapshot())
            elif path in ("/", "/health"):
                self._send(200, b"ok - CS2 bomb timer backend. GET /state for JSON.\n")
            else:
                self._send(404, b"not found\n")

        def do_POST(self):
            path = self.path.split("?", 1)[0].rstrip("/") or "/"
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length > 0 else b""

            if path == "/manual/start":
                tracker.manual_start()
                return self._json(tracker.snapshot())
            if path == "/manual/stop":
                tracker.manual_stop()
                return self._json(tracker.snapshot())
            if path == "/reset":
                tracker.reset()
                return self._json(tracker.snapshot())

            # Anything else is treated as a CS2 GSI payload.
            try:
                payload = json.loads(raw.decode("utf-8") or "{}")
                if not isinstance(payload, dict):
                    raise ValueError("payload is not an object")
            except (ValueError, UnicodeDecodeError) as exc:
                log.warning("bad GSI payload: %s", exc)
                return self._send(400, b"bad json\n")

            if token:
                sent = (payload.get("auth") or {}).get("token")
                if sent != token:
                    log.warning("GSI payload with wrong/missing auth token ignored")
                    return self._send(403, b"bad token\n")

            tracker.update_from_gsi(payload)
            self._send(200)

    return Handler


def run(host: str, port: int, token: Optional[str], bomb_seconds: float, voice: bool) -> None:
    speaker = Voice(voice)
    tracker = BombTracker(bomb_seconds, on_event=speaker.event)

    def ticker() -> None:
        while True:
            tracker.tick()
            time.sleep(0.1)

    threading.Thread(target=ticker, daemon=True).start()

    try:
        httpd = ThreadingHTTPServer((host, port), make_handler(tracker, token))
    except OSError as exc:
        log.error("cannot listen on %s:%d (%s). Is another bomb_timer.py already running?", host, port, exc)
        sys.exit(1)
    httpd.daemon_threads = True
    log.info("CS2 bomb timer v%s listening on http://%s:%d  (state: /state)", __version__, host, port)
    log.info("voice callouts: %s | auth token: %s", "on" if speaker._speak else "off", "set" if token else "none")
    try:
        httpd.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        log.info("bye")
    finally:
        httpd.server_close()


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description="CS2 bomb timer backend (GSI listener + /state JSON)")
    ap.add_argument("--host", default="127.0.0.1", help="bind address (default 127.0.0.1)")
    ap.add_argument("--port", type=int, default=3000, help="port for GSI POSTs and /state (default 3000)")
    ap.add_argument("--token", default="CS2BOMBTIMER",
                    help="GSI auth token, must match the .cfg (default CS2BOMBTIMER; '' disables the check)")
    ap.add_argument("--bomb-time", type=float, default=BOMB_SECONDS, help="C4 fuse in seconds (default 40)")
    ap.add_argument("--voice", action="store_true", help="speak callouts (pyttsx3, macOS 'say' or Windows SAPI)")
    ap.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)-7s %(message)s", datefmt="%H:%M:%S")
    run(args.host, args.port, args.token or None, args.bomb_time, args.voice)


if __name__ == "__main__":
    main()
