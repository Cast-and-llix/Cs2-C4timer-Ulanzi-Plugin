/*
 * CS2 Bomb Timer - canvas renderer.
 * draw(view) paints one key image and returns a PNG data URL for $UD.setBaseDataIcon.
 */
(function (root) {
  'use strict';

  const SIZE = 144; // same canvas size as Ulanzi's official sample plugins; the host scales it
  const FONT = "'Source Han Sans SC', 'Segoe UI', system-ui, -apple-system, Roboto, Helvetica, Arial, sans-serif";

  const C = Object.freeze({
    bg: '#0b0b0d',
    track: '#26262b',
    orange: '#ff8c1a',
    red: '#ff2b2b',
    redDim: '#5a0f0f',
    redBg: '#240606',
    green: '#2ecc71',
    greenBg: '#06200f',
    boomBg: '#2a0a00',
    white: '#f4f4f4',
    grey: '#8d8d96',
    greyDim: '#4a4a52',
    amber: '#ffb020'
  });

  const CX = SIZE / 2;
  const CY = 60;
  const R = 46;
  const RING_W = 11;
  const LABEL_Y = 129;

  function makeCanvas() {
    const c = document.createElement('canvas');
    c.width = SIZE;
    c.height = SIZE;
    return c;
  }

  function fitFont(ctx, text, weight, maxPx, maxWidth) {
    let px = maxPx;
    do {
      ctx.font = `${weight} ${px}px ${FONT}`;
      if (ctx.measureText(text).width <= maxWidth) break;
      px -= 1;
    } while (px > 8);
    return px;
  }

  function text(ctx, str, x, y, color, weight, maxPx, maxWidth) {
    fitFont(ctx, str, weight, maxPx, maxWidth);
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(str, x, y);
  }

  function ring(ctx, fraction, color, dashed) {
    ctx.lineWidth = RING_W;
    ctx.lineCap = 'butt';
    ctx.setLineDash(dashed ? [8, 7] : []);
    ctx.strokeStyle = C.track;
    ctx.beginPath();
    ctx.arc(CX, CY, R, 0, Math.PI * 2);
    ctx.stroke();
    if (fraction > 0 && color) {
      // Starts at 12 o'clock and shrinks counter-clockwise as time runs out.
      const start = -Math.PI / 2;
      ctx.strokeStyle = color;
      ctx.lineCap = fraction >= 1 ? 'butt' : 'round';
      ctx.beginPath();
      ctx.arc(CX, CY, R, start, start + Math.PI * 2 * fraction);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  function check(ctx, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 9;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(CX - 20, CY + 1);
    ctx.lineTo(CX - 6, CY + 15);
    ctx.lineTo(CX + 21, CY - 14);
    ctx.stroke();
  }

  function burst(ctx, color) {
    // simple 8-point explosion star
    ctx.fillStyle = color;
    ctx.beginPath();
    const spikes = 8;
    for (let i = 0; i < spikes * 2; i++) {
      const r = i % 2 === 0 ? 27 : 12;
      const a = (Math.PI / spikes) * i - Math.PI / 2;
      const x = CX + Math.cos(a) * r;
      const y = CY + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
  }

  function manualBadge(ctx) {
    ctx.fillStyle = C.amber;
    ctx.beginPath();
    ctx.arc(SIZE - 14, 14, 9, 0, Math.PI * 2);
    ctx.fill();
    text(ctx, 'M', SIZE - 14, 15, '#1a1200', 800, 12, 14);
  }

  function paint(ctx, v) {
    let bg = C.bg;
    if (v.mode === 'countdown' && v.phase === 'too_late' && v.flashOn) bg = C.redBg;
    if (v.mode === 'defused') bg = C.greenBg;
    if (v.mode === 'exploded') bg = C.boomBg;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, SIZE, SIZE);

    switch (v.mode) {
      case 'countdown': {
        let ringColor = C.orange;
        let numColor = C.white;
        let labelColor = C.orange;
        if (v.phase === 'kit_only') { ringColor = C.red; labelColor = C.red; }
        if (v.phase === 'too_late') {
          ringColor = v.flashOn ? C.red : C.redDim;
          numColor = v.flashOn ? C.white : C.redDim;
          labelColor = v.flashOn ? C.red : C.redDim;
        }
        ring(ctx, v.fraction, ringColor, false);
        text(ctx, String(v.seconds), CX, CY + 2, numColor, 800, 46, 2 * R - RING_W - 6);
        text(ctx, v.label, CX, LABEL_Y, labelColor, 800, 21, SIZE - 10);
        if (v.manual) manualBadge(ctx);
        break;
      }
      case 'defused':
        ring(ctx, 1, C.green, false);
        check(ctx, C.green);
        text(ctx, v.label, CX, LABEL_Y, C.green, 800, 21, SIZE - 10);
        break;
      case 'exploded':
        ring(ctx, 1, C.orange, false);
        burst(ctx, C.red);
        text(ctx, v.label, CX, LABEL_Y, C.orange, 800, 24, SIZE - 10);
        break;
      case 'offline':
        ring(ctx, 0, null, true);
        text(ctx, 'C4', CX, CY + 2, C.greyDim, 800, 34, 70);
        text(ctx, v.label, CX, LABEL_Y, C.grey, 800, 21, SIZE - 10);
        break;
      default: // idle
        ring(ctx, 1, C.greyDim, false);
        text(ctx, 'C4', CX, CY + 2, C.white, 800, 34, 70);
        text(ctx, v.label, CX, LABEL_Y, C.green, 800, 21, SIZE - 10);
    }
  }

  class BombRenderer {
    constructor() {
      this.canvas = makeCanvas();
      this.ctx = this.canvas.getContext('2d');
    }
    draw(view) {
      this.ctx.clearRect(0, 0, SIZE, SIZE);
      paint(this.ctx, view);
      return this.canvas.toDataURL('image/png');
    }
  }

  root.BombRenderer = BombRenderer;
  root.BombRenderer.SIZE = SIZE;
})(window);
