/*
 * CS2 Bomb Timer - pure state logic (no DOM, no Ulanzi API).
 *
 * Turns backend polls (GET /state), poll failures and key presses into a
 * "view" describing what the key should show. Rendering lives in
 * bombRenderer.js. This file also runs under Node for unit tests.
 */
(function (root) {
  'use strict';

  const DEFAULTS = Object.freeze({
    bombTime: 40,          // seconds on the C4 fuse in CS2
    resultHoldMs: 4000,    // how long DEFUSED / BOOM stays on the key
    offlineAfterMs: 1500,  // no successful poll for this long => OFFLINE
    flashPeriodMs: 250     // TOO LATE flash half-period
  });

  const KIT_ONLY_MAX = 10; // 6..10 s left: only a kit defuse (5 s) can make it
  const TOO_LATE_MAX = 5;  // <= 5 s left: nobody can defuse in time

  const PLANTED = new Set(['planted', 'defusing', 'bomb_planted', 'active', 'running', 'countdown']);
  const DEFUSED = new Set(['defused', 'bomb_defused']);
  const EXPLODED = new Set(['exploded', 'boom', 'detonated', 'bomb_exploded']);

  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /** Accepts the documented /state JSON plus a few common field-name variants. */
  function normalizeBackendState(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    const statusRaw = String(s.status ?? s.state ?? s.bomb ?? '').toLowerCase().trim();
    let status = 'idle';
    if (PLANTED.has(statusRaw)) status = 'planted';
    else if (DEFUSED.has(statusRaw)) status = 'defused';
    else if (EXPLODED.has(statusRaw)) status = 'exploded';

    const remaining = num(s.time_remaining ?? s.remaining ?? s.time_left ?? s.timeLeft ?? s.countdown);
    // A backend that only reports a running number (no status) still counts as planted.
    if (status === 'idle' && !statusRaw && remaining !== null && remaining > 0) status = 'planted';

    return {
      status,
      remaining: remaining === null ? null : Math.max(0, remaining),
      statusAge: num(s.status_age),
      bombTime: num(s.bomb_time ?? s.total),
      source: s.source || null
    };
  }

  function classify(seconds) {
    if (seconds > KIT_ONLY_MAX) return 'bomb';
    if (seconds > TOO_LATE_MAX) return 'kit_only';
    return 'too_late';
  }

  const LABELS = Object.freeze({
    bomb: 'BOMB', kit_only: 'KIT ONLY', too_late: 'TOO LATE',
    defused: 'DEFUSED', exploded: 'BOOM', idle: 'READY', offline: 'OFFLINE'
  });

  class BombTimerModel {
    constructor(options) {
      this.configure(options);
      this.lastOkMs = null;
      this.failures = 0;
      this.backend = { status: 'idle', remaining: null, receivedAtMs: 0, localPlantMs: null };
      this.prevBackendStatus = undefined; // undefined = never polled successfully
      this.manualStartMs = null;
      this.result = null;                 // { kind: 'defused'|'exploded', untilMs }
      this._lastCountdown = null;         // { session, seconds } - keeps the number monotonic
    }

    configure(options) {
      const o = Object.assign({}, DEFAULTS, options || {});
      this.bombTime = num(o.bombTime) > 0 ? num(o.bombTime) : DEFAULTS.bombTime;
      this.resultHoldMs = num(o.resultHoldMs) >= 0 ? num(o.resultHoldMs) : DEFAULTS.resultHoldMs;
      this.offlineAfterMs = num(o.offlineAfterMs) > 0 ? num(o.offlineAfterMs) : DEFAULTS.offlineAfterMs;
      this.flashPeriodMs = num(o.flashPeriodMs) > 0 ? num(o.flashPeriodMs) : DEFAULTS.flashPeriodMs;
    }

    isOnline(nowMs) {
      if (this.lastOkMs === null) return false;
      return nowMs - this.lastOkMs <= this.offlineAfterMs;
    }

    /** Has at least one poll finished (ok or failed)? Before that we show READY, not OFFLINE. */
    hasPolled() {
      return this.lastOkMs !== null || this.failures > 0;
    }

    onPollSuccess(raw, nowMs) {
      const s = normalizeBackendState(raw);
      const prev = this.prevBackendStatus;
      this.lastOkMs = nowMs;
      this.failures = 0;

      if (s.status === 'planted') {
        if (prev !== 'planted') {
          this.backend.localPlantMs = nowMs;
          this.result = null;
        }
        this.manualStartMs = null; // a real plant always wins over a manual test countdown
      } else if ((s.status === 'defused' || s.status === 'exploded') && prev !== s.status) {
        let holdLeft = null;
        if (s.statusAge !== null) holdLeft = this.resultHoldMs - s.statusAge * 1000;
        else if (prev === 'planted') holdLeft = this.resultHoldMs;
        if (holdLeft !== null && holdLeft > 0) {
          this.result = { kind: s.status, untilMs: nowMs + holdLeft };
          this.manualStartMs = null;
        }
      }

      this.backend.status = s.status;
      this.backend.remaining = s.remaining;
      this.backend.receivedAtMs = nowMs;
      this.prevBackendStatus = s.status;
      return s;
    }

    onPollFailure(nowMs) {
      this.failures += 1;
      void nowMs;
    }

    /** Key press: start or stop the manual countdown. Returns what happened. */
    toggleManual(nowMs) {
      if (this.manualStartMs !== null) {
        this.manualStartMs = null;
        this._lastCountdown = null;
        return 'stopped';
      }
      if (this.isOnline(nowMs) && this.backend.status === 'planted') return 'ignored';
      this.manualStartMs = nowMs;
      this.result = null;
      this._lastCountdown = null;
      return 'started';
    }

    backendRemaining(nowMs) {
      const b = this.backend;
      if (b.remaining !== null) return Math.max(0, b.remaining - (nowMs - b.receivedAtMs) / 1000);
      const start = b.localPlantMs ?? b.receivedAtMs;
      return Math.max(0, this.bombTime - (nowMs - start) / 1000);
    }

    _countdownView(remaining, session, manual, nowMs) {
      let seconds = Math.max(0, Math.ceil(remaining - 1e-6));
      const last = this._lastCountdown;
      // Poll jitter can make the interpolated number tick back up by one; never show that.
      if (last && last.session === session && seconds === last.seconds + 1) seconds = last.seconds;
      this._lastCountdown = { session, seconds };

      const phase = classify(seconds);
      const flashOn = phase !== 'too_late' || Math.floor(nowMs / this.flashPeriodMs) % 2 === 0;
      return {
        mode: 'countdown',
        phase,
        label: LABELS[phase],
        seconds,
        fraction: Math.min(1, Math.max(0, seconds / this.bombTime)),
        flashOn,
        manual
      };
    }

    view(nowMs) {
      const online = this.isOnline(nowMs);

      // 1) live bomb from the backend
      if (online && this.backend.status === 'planted') {
        return this._countdownView(this.backendRemaining(nowMs), 'gsi:' + this.backend.localPlantMs, false, nowMs);
      }

      // 2) manual test countdown (works even while the backend is offline)
      if (this.manualStartMs !== null) {
        const remaining = this.bombTime - (nowMs - this.manualStartMs) / 1000;
        if (remaining > 0) {
          return this._countdownView(remaining, 'manual:' + this.manualStartMs, true, nowMs);
        }
        this.manualStartMs = null;
        this.result = { kind: 'exploded', untilMs: nowMs + this.resultHoldMs };
      }

      this._lastCountdown = null;

      // 3) DEFUSED / BOOM for a short while after the round
      if (this.result && nowMs < this.result.untilMs) {
        const kind = this.result.kind;
        return { mode: kind, phase: kind, label: LABELS[kind], seconds: null, fraction: 1, flashOn: true, manual: false };
      }
      this.result = null;

      // 4) backend unreachable
      if (!online && this.hasPolled()) {
        return { mode: 'offline', phase: 'offline', label: LABELS.offline, seconds: null, fraction: 1, flashOn: true, manual: false };
      }

      // 5) idle
      return { mode: 'idle', phase: 'idle', label: LABELS.idle, seconds: null, fraction: 1, flashOn: true, manual: false };
    }
  }

  /** Cheap identity of a view: the key is only redrawn when this changes. */
  function viewSignature(v) {
    return [v.mode, v.phase, v.seconds, v.flashOn ? 1 : 0, v.manual ? 1 : 0].join('|');
  }

  const api = { DEFAULTS, LABELS, KIT_ONLY_MAX, TOO_LATE_MAX, normalizeBackendState, classify, BombTimerModel, viewSignature };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BombLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
