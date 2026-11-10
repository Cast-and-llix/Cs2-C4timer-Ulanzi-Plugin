#!/usr/bin/env python3
"""
Fake CS2: posts Game State Integration payloads to bomb_timer.py so you can watch
the D200 key go through a whole round without launching the game.

    python tools/mock_gsi.py                       # plant, explode after 40 s
    python tools/mock_gsi.py --outcome defused --defuse-at 7
"""
import argparse
import json
import time
import urllib.request


def post(url, payload):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=2) as r:
        return r.status


def gsi(token, phase, bomb=None):
    rnd = {"phase": phase}
    if bomb:
        rnd["bomb"] = bomb
    return {
        "provider": {"name": "Counter-Strike: Global Offensive", "appid": 730, "version": 14000,
                     "steamid": "76561190000000000", "timestamp": int(time.time())},
        "map": {"mode": "competitive", "name": "de_mirage", "phase": "live", "round": 3},
        "round": rnd,
        "player": {"steamid": "76561190000000000", "name": "mock", "team": "CT"},
        "auth": {"token": token},
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default="http://127.0.0.1:3000/")
    ap.add_argument("--token", default="CS2BOMBTIMER")
    ap.add_argument("--outcome", choices=["exploded", "defused"], default="exploded")
    ap.add_argument("--defuse-at", type=float, default=7.0, help="seconds left when defused")
    ap.add_argument("--live", type=float, default=2.0, help="seconds of live play before the plant")
    ap.add_argument("--after", type=float, default=6.0, help="seconds of round-over before next freezetime")
    args = ap.parse_args()

    def send(phase, bomb=None, note=""):
        status = post(args.url, gsi(args.token, phase, bomb))
        print(f"{time.strftime('%H:%M:%S')}  round.phase={phase:<10} round.bomb={bomb or '-':<9} HTTP {status} {note}", flush=True)

    send("freezetime")
    send("live")
    time.sleep(args.live)
    planted = time.monotonic()
    send("live", "planted", "<- key should start at 40")

    end_at = 40.0 if args.outcome == "exploded" else 40.0 - args.defuse_at
    while time.monotonic() - planted < end_at:
        time.sleep(min(1.0, end_at - (time.monotonic() - planted)))
        if time.monotonic() - planted < end_at:
            send("live", "planted")  # like CS2's periodic updates
    send("over", args.outcome, "<- key should show " + ("BOOM" if args.outcome == "exploded" else "DEFUSED"))
    time.sleep(args.after)
    send("freezetime", None, "<- next round, key back to C4 / READY")


if __name__ == "__main__":
    main()
