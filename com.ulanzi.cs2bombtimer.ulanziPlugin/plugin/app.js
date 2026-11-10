/* global $UD, BombLogic, BombRenderer */
/*
 * CS2 Bomb Timer - Ulanzi Studio main service.
 *
 * - Polls the bomb_timer.py backend (default http://127.0.0.1:3000/state) ~5x per second.
 * - Each key instance has its own BombTimerModel; the key image is only re-sent
 *   when the visible content changes (number, phase, flash frame).
 * - Key press toggles a manual 40 s countdown (testing without the game).
 */
'use strict';

const PLUGIN_UUID = 'com.ulanzi.ulanzistudio.cs2bombtimer';
const DEFAULT_SETTINGS = Object.freeze({
  backendUrl: 'http://127.0.0.1:3000/state',
  bombTime: 40,
  resultHold: 4
});
const POLL_MS = 80;        // ~12 polls per second
const POLL_TIMEOUT_MS = 400;
const RENDER_TICK_MS = 50;  // cheap check; an image is only sent when the signature changes

const renderer = new BombRenderer();
const INSTANCES = {};       // context -> instance
const POLLERS = {};         // url -> Poller

function log(...args) { console.log('[CS2BombTimer]', ...args); }

/* ----------------------------------------------------------------------------
 * Backend poller (shared by all keys that point at the same URL)
 * ------------------------------------------------------------------------- */
class Poller {
  constructor(url) {
    this.url = url;
    this.subscribers = new Set();
    this.inflight = false;
    this.lastState = null;
    this.online = null;
    this.timer = setInterval(() => this.poll(), POLL_MS);
    this.poll();
  }

  async poll() {
    if (this.inflight) return;
    this.inflight = true;
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const to = ctrl ? setTimeout(() => ctrl.abort(), POLL_TIMEOUT_MS) : null;
    try {
      const res = await fetch(this.url, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const now = Date.now();
      this.lastState = data;
      this.setOnline(true);
      this.subscribers.forEach((inst) => inst.model.onPollSuccess(data, now));
    } catch (err) {
      const now = Date.now();
      if (this.online !== false) log('backend unreachable:', this.url, String(err && err.message || err));
      this.setOnline(false);
      this.subscribers.forEach((inst) => inst.model.onPollFailure(now));
    } finally {
      if (to) clearTimeout(to);
      this.inflight = false;
      this.subscribers.forEach((inst) => inst.render());
    }
  }

  setOnline(on) {
    if (this.online === on) return;
    this.online = on;
    log('backend', on ? 'ONLINE' : 'OFFLINE', this.url);
    this.subscribers.forEach((inst) => inst.pushStatusToInspector());
  }

  destroy() { clearInterval(this.timer); }
}

function subscribe(inst, url) {
  if (!POLLERS[url]) POLLERS[url] = new Poller(url);
  POLLERS[url].subscribers.add(inst);
  return POLLERS[url];
}

function unsubscribe(inst, url) {
  const p = POLLERS[url];
  if (!p) return;
  p.subscribers.delete(inst);
  if (p.subscribers.size === 0) {
    p.destroy();
    delete POLLERS[url];
  }
}

/* ----------------------------------------------------------------------------
 * One instance per key the action is placed on
 * ------------------------------------------------------------------------- */
class BombKey {
  constructor(context, settings) {
    this.context = context;
    this.active = true;
    this.lastSig = null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS);
    this.model = new BombLogic.BombTimerModel();
    this.poller = null;
    this.applySettings(settings);
  }

  applySettings(raw) {
    const s = Object.assign({}, this.settings);
    if (raw && typeof raw === 'object') {
      if (typeof raw.backendUrl === 'string' && raw.backendUrl.trim()) s.backendUrl = raw.backendUrl.trim();
      if (Number(raw.bombTime) > 0) s.bombTime = Number(raw.bombTime);
      if (raw.resultHold !== undefined && raw.resultHold !== '' && Number(raw.resultHold) >= 0) s.resultHold = Number(raw.resultHold);
    }
    const urlChanged = !this.poller || this.poller.url !== s.backendUrl;
    this.settings = s;
    this.model.configure({ bombTime: s.bombTime, resultHoldMs: s.resultHold * 1000 });
    if (urlChanged) {
      if (this.poller) unsubscribe(this, this.poller.url);
      this.poller = subscribe(this, s.backendUrl);
    }
    this.render(true);
  }

  setActive(active) {
    this.active = active;
    if (active) this.render(true);
  }

  press() {
    const result = this.model.toggleManual(Date.now());
    log('key press ->', result);
    if (result === 'ignored') $UD.toast('Live bomb from CS2 in progress - manual timer ignored');
    this.render(true);
  }

  render(force) {
    if (!this.active) return;
    const view = this.model.view(Date.now());
    const sig = BombLogic.viewSignature(view);
    if (!force && sig === this.lastSig) return;
    this.lastSig = sig;
    $UD.setBaseDataIcon(this.context, renderer.draw(view), '');
  }

  pushStatusToInspector() {
    const p = this.poller;
    $UD.sendToPropertyInspector({
      online: p ? p.online : null,
      url: this.settings.backendUrl,
      backend: p ? p.lastState : null
    }, this.context);
  }

  destroy() {
    if (this.poller) unsubscribe(this, this.poller.url);
    this.poller = null;
  }
}

/* ----------------------------------------------------------------------------
 * Ulanzi Studio events
 * ------------------------------------------------------------------------- */
$UD.connect(PLUGIN_UUID);

$UD.onConnected(() => log('connected to Ulanzi Studio'));
$UD.onClose(() => log('Ulanzi Studio websocket closed'));

function ensureInstance(jsn) {
  const ctx = jsn.context;
  if (!INSTANCES[ctx]) INSTANCES[ctx] = new BombKey(ctx, jsn.param);
  return INSTANCES[ctx];
}

// Action placed on a key (also sent when a page with the key is loaded)
$UD.onAdd((jsn) => {
  const inst = INSTANCES[jsn.context];
  if (inst) inst.applySettings(jsn.param);
  else ensureInstance(jsn);
});

// Key pressed (confirmed click)
$UD.onRun((jsn) => ensureInstance(jsn).press());

// Page switched / device asleep: stop pushing images while hidden
$UD.onSetActive((jsn) => {
  const inst = INSTANCES[jsn.context];
  if (inst) inst.setActive(String(jsn.active) === 'true');
});

// Action removed from one or more keys
$UD.onClear((jsn) => {
  (jsn.param || []).forEach((item) => {
    const inst = INSTANCES[item.context];
    if (inst) {
      inst.destroy();
      delete INSTANCES[item.context];
    }
  });
});

// Settings changed in the property inspector / re-sent by the app
function onSettings(jsn) {
  const inst = INSTANCES[jsn.context];
  if (inst) inst.applySettings(jsn.param);
}
$UD.onParamFromApp(onSettings);
$UD.onParamFromPlugin(onSettings);

// Property inspector asks for live backend status
$UD.onSendToPlugin((jsn) => {
  const inst = INSTANCES[jsn.context];
  if (inst) inst.pushStatusToInspector();
});

// Local clock drives the countdown between polls and the TOO LATE flash.
setInterval(() => {
  for (const ctx in INSTANCES) INSTANCES[ctx].render(false);
}, RENDER_TICK_MS);
