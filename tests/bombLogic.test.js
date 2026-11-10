// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../com.ulanzi.cs2bombtimer.ulanziPlugin/plugin/actions/bombLogic.js');

const planted = (rem, extra = {}) => Object.assign({ status: 'planted', time_remaining: rem }, extra);

test('classify thresholds', () => {
  assert.equal(L.classify(40), 'bomb');
  assert.equal(L.classify(11), 'bomb');
  assert.equal(L.classify(10), 'kit_only');
  assert.equal(L.classify(6), 'kit_only');
  assert.equal(L.classify(5), 'too_late');
  assert.equal(L.classify(0), 'too_late');
});

test('normalize tolerates field variants', () => {
  assert.deepEqual(L.normalizeBackendState({ state: 'DEFUSING', remaining: '12.5' }).status, 'planted');
  assert.equal(L.normalizeBackendState({ status: 'boom' }).status, 'exploded');
  assert.equal(L.normalizeBackendState({ time_left: 9 }).status, 'planted');
  assert.equal(L.normalizeBackendState(null).status, 'idle');
  assert.equal(L.normalizeBackendState({ status: 'planted', time_remaining: -3 }).remaining, 0);
});

test('idle before first poll, READY after ok poll', () => {
  const m = new L.BombTimerModel();
  assert.equal(m.view(0).mode, 'idle');
  m.onPollSuccess({ status: 'idle', time_remaining: null }, 100);
  const v = m.view(150);
  assert.equal(v.mode, 'idle');
  assert.equal(v.label, 'READY');
});

test('OFFLINE when backend unreachable', () => {
  const m = new L.BombTimerModel();
  m.onPollFailure(0);
  assert.equal(m.view(10).label, 'OFFLINE');
  m.onPollSuccess({ status: 'idle' }, 1000);
  assert.equal(m.view(1100).mode, 'idle');
  m.onPollFailure(1200);                       // single dropped poll is tolerated
  assert.equal(m.view(1300).mode, 'idle');
  assert.equal(m.view(2600).mode, 'offline');  // > 1.5 s without success
});

test('countdown labels, colours phase and interpolation', () => {
  const m = new L.BombTimerModel();
  m.onPollSuccess(planted(40), 0);
  let v = m.view(0);
  assert.equal(v.mode, 'countdown');
  assert.equal(v.seconds, 40);
  assert.equal(v.label, 'BOMB');
  assert.equal(v.fraction, 1);
  m.onPollSuccess(planted(10.4), 29600);
  v = m.view(29600);
  assert.equal(v.seconds, 11); assert.equal(v.label, 'BOMB');
  v = m.view(29900);                            // interpolated 10.1 -> 11
  assert.equal(v.seconds, 11);
  v = m.view(30500);                            // 9.5 -> 10
  assert.equal(v.seconds, 10); assert.equal(v.label, 'KIT ONLY');
  m.onPollSuccess(planted(5.2), 34800);
  assert.equal(m.view(34800).label, 'KIT ONLY'); // 6
  v = m.view(35300);                             // 4.7 -> 5
  assert.equal(v.seconds, 5); assert.equal(v.label, 'TOO LATE');
  assert.equal(v.fraction, 5 / 40);
});

test('TOO LATE flashes, others do not', () => {
  const m = new L.BombTimerModel();
  m.onPollSuccess(planted(3), 0);
  const a = m.view(0), b = m.view(260);
  assert.notEqual(a.flashOn, b.flashOn);
  assert.notEqual(L.viewSignature(a), L.viewSignature(b));
  const m2 = new L.BombTimerModel();
  m2.onPollSuccess(planted(20), 0);
  assert.equal(m2.view(0).flashOn, true);
  assert.equal(m2.view(260).flashOn, true);
});

test('signature only changes when the number changes (outside TOO LATE)', () => {
  const m = new L.BombTimerModel();
  m.onPollSuccess(planted(30), 0);
  const sigs = new Set();
  for (let t = 0; t < 900; t += 50) sigs.add(L.viewSignature(m.view(t)));
  assert.equal(sigs.size, 1);
});

test('number never ticks back up by one from poll jitter', () => {
  const m = new L.BombTimerModel();
  m.onPollSuccess(planted(20.02), 0);
  assert.equal(m.view(30).seconds, 20);         // 19.99 -> 20
  m.onPollSuccess(planted(20.05), 40);          // jittery poll says 20.05 -> 21
  assert.equal(m.view(40).seconds, 20);
});

test('DEFUSED shown briefly then READY', () => {
  const m = new L.BombTimerModel({ resultHoldMs: 4000 });
  m.onPollSuccess(planted(12), 0);
  m.onPollSuccess({ status: 'defused', status_age: 0 }, 200);
  assert.equal(m.view(300).label, 'DEFUSED');
  m.onPollSuccess({ status: 'defused', status_age: 3 }, 3200);
  assert.equal(m.view(4100).label, 'DEFUSED');
  assert.equal(m.view(4300).label, 'READY');
});

test('BOOM without status_age uses transition from planted', () => {
  const m = new L.BombTimerModel();
  m.onPollSuccess(planted(0.1), 0);
  m.onPollSuccess({ status: 'exploded' }, 200);
  assert.equal(m.view(300).label, 'BOOM');
  m.onPollSuccess({ status: 'exploded' }, 4400); // backend still says exploded during round-over
  assert.equal(m.view(4500).label, 'READY');
});

test('stale result on startup is not shown', () => {
  const m = new L.BombTimerModel();
  m.onPollSuccess({ status: 'defused', status_age: 12 }, 0);
  assert.equal(m.view(10).label, 'READY');
  const m2 = new L.BombTimerModel();
  m2.onPollSuccess({ status: 'exploded' }, 0);   // no age, never saw the plant
  assert.equal(m2.view(10).label, 'READY');
});

test('manual countdown: start, stop, works offline, ends in BOOM', () => {
  const m = new L.BombTimerModel();
  m.onPollFailure(0);
  assert.equal(m.toggleManual(100), 'started');
  let v = m.view(100);
  assert.equal(v.seconds, 40); assert.equal(v.manual, true); assert.equal(v.label, 'BOMB');
  assert.equal(m.toggleManual(5000), 'stopped');
  assert.equal(m.view(5000).label, 'OFFLINE');
  m.toggleManual(10000);
  v = m.view(10000 + 35500);
  assert.equal(v.label, 'TOO LATE'); assert.equal(v.seconds, 5);
  assert.equal(m.view(10000 + 40000).label, 'BOOM');
  assert.equal(m.view(10000 + 44100).label, 'OFFLINE');
});

test('real plant overrides manual; manual ignored during live bomb', () => {
  const m = new L.BombTimerModel();
  m.onPollSuccess({ status: 'idle' }, 0);
  m.toggleManual(0);
  m.onPollSuccess(planted(40), 10000);
  const v = m.view(10000);
  assert.equal(v.manual, false); assert.equal(v.seconds, 40);
  assert.equal(m.toggleManual(10100), 'ignored');
});

test('backend without time_remaining falls back to local clock', () => {
  const m = new L.BombTimerModel();
  m.onPollSuccess({ status: 'planted' }, 0);
  assert.equal(m.view(0).seconds, 40);
  m.onPollSuccess({ status: 'planted' }, 15000);
  assert.equal(m.view(15000).seconds, 25);
});

test('custom bomb time', () => {
  const m = new L.BombTimerModel({ bombTime: 45 });
  m.toggleManual(0);
  assert.equal(m.view(0).seconds, 45);
  assert.equal(m.view(0).fraction, 1);
});
