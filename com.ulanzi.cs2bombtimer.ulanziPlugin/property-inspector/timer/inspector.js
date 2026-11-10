/* global $UD, Utils */
'use strict';

const DEFAULTS = { backendUrl: 'http://127.0.0.1:3000/state', bombTime: '40', resultHold: '4' };
let SETTINGS = Object.assign({}, DEFAULTS);
let form = null;

// The action UUID (5 segments) is passed by Ulanzi Studio in the page query string.
$UD.connect('com.ulanzi.ulanzistudio.cs2bombtimer.timer');

$UD.onConnected(() => {
  form = document.querySelector('#property-inspector');
  document.querySelector('.uspi-wrapper').classList.remove('hidden');
  Utils.setFormValue(SETTINGS, form);

  form.addEventListener('input', Utils.debounce(() => {
    SETTINGS = Object.assign({}, DEFAULTS, Utils.getFormValue(form));
    $UD.sendParamFromPlugin(SETTINGS);
  }));

  // ask the main service for the backend status, then refresh it periodically
  $UD.sendToPlugin({ request: 'status' });
  setInterval(() => $UD.sendToPlugin({ request: 'status' }), 2000);
});

function loadSettings(jsn) {
  if (!jsn || !jsn.param) return;
  SETTINGS = Object.assign({}, DEFAULTS, jsn.param);
  if (form) Utils.setFormValue(SETTINGS, form);
}
$UD.onAdd(loadSettings);
$UD.onParamFromApp(loadSettings);

$UD.onSendToPropertyInspector((jsn) => {
  const p = jsn.payload || {};
  const dot = document.getElementById('dot');
  const status = document.getElementById('status');
  dot.className = 'status-dot ' + (p.online ? 'on' : p.online === false ? 'off' : '');
  if (p.online) {
    const b = p.backend || {};
    const st = b.status || 'idle';
    const t = typeof b.time_remaining === 'number' ? ` (${b.time_remaining.toFixed(1)} s)` : '';
    const gsi = b.gsi_connected === false ? ' · no CS2 data yet' : '';
    status.textContent = `Backend online · ${st}${t}${gsi}`;
  } else if (p.online === false) {
    status.textContent = 'OFFLINE - is bomb_timer.py running?';
  } else {
    status.textContent = 'Connecting…';
  }
});
