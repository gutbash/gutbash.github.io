// The heart in the tagline: press it and it bursts into rigid shards that drift as if
// weightless, turning slowly and never quite stopping, bouncing softly off the edges of
// the page. On a phone, tilting the device nudges them. Every shard can be grabbed and
// thrown, and fitted back into the heart by hand, one at a time. If they are left alone
// for a while, the remaining ones glide back into place by themselves, except one, which
// keeps floating until it is dragged back into its gap.

const NS = 'http://www.w3.org/2000/svg';
const BOX = 24; // heart viewBox size
const SAMPLES = 720; // points sampled along the heart outline; dense enough to read as a curve
const HULL = 10; // every HULL-th outline point is enough for collisions
const SHARDS = 7;
const STEP = 1 / 240;
const MAX_SPIN = 22; // rad/s; tiny shards would otherwise buzz like tops
const DRAG = 1.7; // 1/s; how quickly a burst or a throw bleeds off
const DRIFT = 14; // px/s; shards never go slower than this
const SPIN_DRIFT = 0.35; // rad/s; nor turn slower than this
const BOUNCE = 0.85; // speed kept when bouncing off an edge of the page
const TILT = 9; // px/s^2 of push per degree the phone is tilted
const TILT_MAX = 25; // degrees
const REBUILD_DELAY_MS = 5000; // since the burst or the last shard was let go, none held
const RETURN_MS = 2200;
const STAGGER_MS = 140;
const SNAP_RADIUS = 18; // px from home at which a dropped shard clicks in

const button = document.querySelector('[data-heart]');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

if (reduced.matches) document.querySelector('[data-heart-beat]')?.remove();
else if (button) init();

function init() {
  const icon = button.querySelector('svg');
  const shape = icon.querySelector('[data-heart-shape]');
  const kept = icon.querySelector('[data-heart-kept]');

  // Page-sized layer the shards live in. It ignores the pointer except on the shards.
  // It is ordinary page content (absolute, not fixed): iOS Safari freezes and upscales
  // fixed layers while the page is pinch-zoomed, so shards in one stop moving and blur.
  // Everything below works in this layer's own coordinates.
  const layer = document.createElementNS(NS, 'svg');
  layer.setAttribute('aria-hidden', 'true');
  layer.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;overflow:visible';
  document.body.style.position = 'relative';
  document.body.append(layer);

  let state = 'whole'; // whole | floating | returning | missing
  let bodies = [];
  let wedges = []; // every wedge of the current fracture, home or not
  let loose = null; // the shard left behind
  let drag = null; // { body, id, dx, dy, vx, vy, t }
  let raf = 0;
  let last = 0;
  let acc = 0;
  let idleSince = 0;
  const tilt = { x: 0, y: 0, base: null, on: false }; // push from the phone's tilt, px/s^2
  // The page edges, in the same coordinates the shards are drawn in. Read from the layer
  // itself, not window.innerWidth/Height: those shrink to the visible area when a phone
  // is pinch-zoomed, which would put the edges in the middle of the page.
  let W = 0, H = 0;
  let returnAt = 0;

  const scale = () => icon.getBoundingClientRect().width / BOX;
  const home = (b) => {
    const r = icon.getBoundingClientRect();
    const o = layer.getBoundingClientRect();
    const s = r.width / BOX;
    return { x: r.left - o.left + b.cx * s, y: r.top - o.top + b.cy * s };
  };
  // A pointer position in layer coordinates.
  const point = (e) => {
    const o = layer.getBoundingClientRect();
    return { x: e.clientX - o.left, y: e.clientY - o.top };
  };
  const unwind = (a) => Math.atan2(Math.sin(a), Math.cos(a));

  function outline() {
    const total = shape.getTotalLength();
    return Array.from({ length: SAMPLES }, (_, i) => {
      const p = shape.getPointAtLength((i / SAMPLES) * total);
      return [p.x, p.y];
    });
  }

  // Cuts the heart into wedges that meet at a jittered point near its middle. Each wedge
  // is the fracture point plus the stretch of outline ("rim") between two cuts.
  function fracture() {
    const pts = outline();
    const centre = [12 + rand(-1.6, 1.6), 11.5 + rand(-1.6, 1.6)];
    const span = SAMPLES / SHARDS;
    const offset = rand(0, span);
    const cuts = Array.from({ length: SHARDS }, (_, i) => Math.round(offset + i * span + rand(-0.3, 0.3) * span));
    return cuts.map((from, i) => {
      const to = i + 1 < SHARDS ? cuts[i + 1] : cuts[0] + SAMPLES;
      const rim = [];
      for (let k = from; k <= to; k++) rim.push(pts[((k % SAMPLES) + SAMPLES) % SAMPLES]);
      return { centre, rim };
    });
  }

  const toPath = (poly) => 'M' + poly.map((p) => p.map((n) => n.toFixed(3)).join(' ')).join('L') + 'Z';

  function makeBody(wedge) {
    const poly = [wedge.centre, ...wedge.rim];
    let area = 0, cx = 0, cy = 0;
    for (let i = 0; i < poly.length; i++) {
      const [x0, y0] = poly[i];
      const [x1, y1] = poly[(i + 1) % poly.length];
      const cross = x0 * y1 - x1 * y0;
      area += cross;
      cx += (x0 + x1) * cross;
      cy += (y0 + y1) * cross;
    }
    cx /= 3 * area;
    cy /= 3 * area;
    const fine = poly.map(([x, y]) => [x - cx, y - cy]);
    // The physics only needs a rough hull: the fracture point and every HULL-th rim point.
    const local = fine.filter((_, i) => i === 0 || i === fine.length - 1 || (i - 1) % HULL === 0);
    const s = scale();
    const el = document.createElementNS(NS, 'g');
    // A generous invisible handle so a few-pixel shard is easy to grab.
    const handle = document.createElementNS(NS, 'circle');
    handle.setAttribute('r', String(22 / s));
    handle.setAttribute('fill', 'transparent');
    // The shard is one plain filled outline that follows the heart's curve point by
    // point. Plain paths are redrawn sharp at any zoom; clipped or masked ones are not
    // (iOS Safari draws those through a fixed-resolution bitmap, which pixelates).
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', toPath(fine));
    path.setAttribute('fill', 'currentColor');
    el.append(handle, path);
    el.style.cssText = 'pointer-events:auto;cursor:grab;touch-action:none';
    layer.append(el);
    const r2 = local.reduce((sum, [x, y]) => sum + x * x + y * y, 0) / local.length;
    const body = {
      el, wedge, local, cx, cy, s,
      area: Math.abs(area / 2),
      inertia: (r2 * s * s) / 2, // per unit mass
      x: 0, y: 0, a: 0, vx: 0, vy: 0, w: 0,
      from: null, // set while gliding back into the heart
      snap: null, // set while clicking into the gap
    };
    Object.assign(body, home(body));
    el.addEventListener('pointerdown', (e) => grab(e, body));
    return body;
  }

  function draw(b) {
    const transform = `translate(${b.x.toFixed(2)} ${b.y.toFixed(2)}) rotate(${((b.a * 180) / Math.PI).toFixed(2)}) scale(${b.s})`;
    if (transform === b.drawn) return;
    b.drawn = transform;
    b.el.setAttribute('transform', transform);
  }

  // A shard corner has crossed an edge of the page: push it back in and bounce it off.
  function contact(b, rx, ry, nx, ny, depth) {
    b.x += nx * depth;
    b.y += ny * depth;
    const vn = (b.vx - b.w * ry) * nx + (b.vy + b.w * rx) * ny;
    if (vn >= 0) return;
    const rn = rx * ny - ry * nx;
    const j = (-(1 + BOUNCE) * vn) / (1 + (rn * rn) / b.inertia);
    b.vx += j * nx;
    b.vy += j * ny;
    b.w += (rn * j) / b.inertia;
  }

  function step(b, dt) {
    // Weightless: only the phone's tilt pushes, and only gently.
    b.vx += tilt.x * dt;
    b.vy += tilt.y * dt;
    // Fast motion bleeds off, but never below a slow drift and a slow turn.
    const speed = Math.hypot(b.vx, b.vy);
    if (speed > DRIFT) {
      const k = Math.max(DRIFT / speed, Math.exp(-DRAG * dt));
      b.vx *= k;
      b.vy *= k;
    } else if (speed > 0.01) {
      const k = Math.min(DRIFT, speed + 20 * dt) / speed;
      b.vx *= k;
      b.vy *= k;
    } else {
      const a = rand(0, Math.PI * 2);
      b.vx = Math.cos(a);
      b.vy = Math.sin(a);
    }
    const spin = Math.abs(b.w);
    if (spin > SPIN_DRIFT) b.w *= Math.max(SPIN_DRIFT / spin, Math.exp(-DRAG * dt));
    else b.w = (b.w < 0 ? -1 : 1) * Math.min(SPIN_DRIFT, spin + 0.5 * dt);
    b.w = Math.max(-MAX_SPIN, Math.min(MAX_SPIN, b.w));

    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.a += b.w * dt;
    const cos = Math.cos(b.a) * b.s, sin = Math.sin(b.a) * b.s;
    for (const [lx, ly] of b.local) {
      const rx = lx * cos - ly * sin;
      const ry = lx * sin + ly * cos;
      if (b.x + rx < 0) contact(b, rx, ry, 1, 0, -(b.x + rx));
      if (b.x + rx > W) contact(b, rx, ry, -1, 0, b.x + rx - W);
      if (b.y + ry < 0) contact(b, rx, ry, 0, 1, -(b.y + ry));
      if (b.y + ry > H) contact(b, rx, ry, 0, -1, b.y + ry - H);
    }
  }

  const held = (b) => drag && drag.body === b;
  const free = (b) => !b.from && !b.snap && !held(b);

  // Tilt is measured against a slowly following baseline, so however the phone is being
  // held counts as level and only fresh tilts push the shards.
  function onTilt(e) {
    if (e.gamma == null || e.beta == null) return;
    const turned = screen.orientation ? screen.orientation.angle : 0;
    const g = turned === 90 ? e.beta : turned === 270 ? -e.beta : e.gamma;
    const b = turned === 90 ? -e.gamma : turned === 270 ? e.gamma : e.beta;
    tilt.base ||= { g, b };
    tilt.base.g += (g - tilt.base.g) * 0.006;
    tilt.base.b += (b - tilt.base.b) * 0.006;
    const clamp = (n) => Math.max(-TILT_MAX, Math.min(TILT_MAX, n));
    tilt.x = clamp(g - tilt.base.g) * TILT;
    tilt.y = clamp(b - tilt.base.b) * TILT;
  }

  // iOS only hands out motion data after asking the visitor, and only from a tap.
  function enableTilt() {
    if (tilt.on || typeof DeviceOrientationEvent === 'undefined') return;
    tilt.on = true;
    const listen = () => addEventListener('deviceorientation', onTilt);
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      DeviceOrientationEvent.requestPermission().then((answer) => answer === 'granted' && listen()).catch(() => {});
    } else {
      listen();
    }
  }

  // While the heart is broken the icon shows only the wedges whose shards are home, as
  // one plain path. Neighbouring fitted wedges are merged into a single outline, so there
  // is no seam between them and nothing but ordinary vector shapes on screen.
  function updateKept() {
    const out = new Set(bodies.map((b) => b.wedge));
    const n = wedges.length;
    const start = wedges.findIndex((w) => out.has(w));
    let d = '';
    let rim = [];
    for (let k = 1; start >= 0 && k <= n; k++) {
      const w = wedges[(start + k) % n];
      if (!out.has(w)) rim.push(...w.rim);
      else if (rim.length) { d += toPath([w.centre, ...rim]); rim = []; }
    }
    kept.setAttribute('d', d);
  }

  // A shard has arrived in its gap: it becomes part of the heart again.
  function place(b) {
    b.el.remove();
    bodies = bodies.filter((other) => other !== b);
    if (loose === b) loose = null;
    updateKept();
    if (!bodies.length) {
      button.removeAttribute('data-broken');
      state = 'whole';
    }
  }

  function shatter() {
    state = 'floating';
    idleSince = performance.now();
    enableTilt();
    button.setAttribute('data-broken', '');
    wedges = fracture();
    bodies = wedges.map(makeBody);
    updateKept();
    for (const b of bodies) {
      const dx = b.cx - 12, dy = b.cy - 11.5;
      const len = Math.hypot(dx, dy) || 1;
      const speed = rand(240, 520);
      b.vx = (dx / len) * speed + rand(-60, 60);
      b.vy = (dy / len) * speed + rand(-60, 60);
      b.w = rand(-10, 10);
    }
    run();
  }

  function beginReturn(now) {
    state = 'returning';
    returnAt = now;
    loose = bodies.reduce((a, b) => (b.area > a.area ? b : a));
    let i = 0;
    for (const b of bodies) {
      if (b === loose) continue;
      b.from = { x: b.x, y: b.y, a: unwind(b.a) };
      b.delay = i++ * STAGGER_MS;
      b.el.style.pointerEvents = 'none';
    }
  }

  function grab(e, b) {
    if (drag || b.from || b.snap) return;
    e.preventDefault();
    b.el.setPointerCapture(e.pointerId);
    b.el.style.cursor = 'grabbing';
    b.vx = b.vy = b.w = 0;
    const at = point(e);
    drag = { body: b, id: e.pointerId, dx: b.x - at.x, dy: b.y - at.y, vx: 0, vy: 0, t: e.timeStamp };
    b.el.addEventListener('pointermove', move);
    b.el.addEventListener('pointerup', release);
    b.el.addEventListener('pointercancel', release);
    run();
  }

  function move(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const b = drag.body;
    const at = point(e);
    const x = at.x + drag.dx, y = at.y + drag.dy;
    const dt = Math.max(1, e.timeStamp - drag.t) / 1000;
    drag.vx = 0.6 * drag.vx + 0.4 * ((x - b.x) / dt);
    drag.vy = 0.6 * drag.vy + 0.4 * ((y - b.y) / dt);
    drag.t = e.timeStamp;
    b.x = x;
    b.y = y;
  }

  function release(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const b = drag.body;
    b.el.removeEventListener('pointermove', move);
    b.el.removeEventListener('pointerup', release);
    b.el.removeEventListener('pointercancel', release);
    b.el.style.cursor = 'grab';
    const h = home(b);
    if (Math.hypot(h.x - b.x, h.y - b.y) <= SNAP_RADIUS) {
      snapHome(b);
    } else {
      const cap = 3000;
      // A pointer that paused before letting go leaves the shard adrift instead of flinging it.
      const stale = e.timeStamp - drag.t > 80;
      b.vx = stale ? 0 : Math.max(-cap, Math.min(cap, drag.vx));
      b.vy = stale ? 0 : Math.max(-cap, Math.min(cap, drag.vy));
      b.w = rand(-6, 6);
    }
    drag = null;
    idleSince = performance.now();
    run();
  }

  function snapHome(b) {
    b.snap = { x: b.x, y: b.y, a: unwind(b.a), t: performance.now() };
    run();
  }

  function frame(now) {
    raf = 0;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    const bounds = layer.getBoundingClientRect();
    W = bounds.width;
    H = bounds.height;

    // Shards adrift.
    acc += dt;
    while (acc >= STEP) {
      for (const b of bodies) if (free(b)) step(b, STEP);
      acc -= STEP;
    }
    // The held shard straightens up so it arrives ready to fit.
    if (drag) drag.body.a = unwind(drag.body.a) * Math.pow(0.002, dt);

    // Shards clicking into their gaps.
    for (const b of bodies.filter((b) => b.snap)) {
      const t = Math.min(1, (now - b.snap.t) / 220);
      const k = 1 - Math.pow(1 - t, 3);
      const h = home(b);
      b.x = b.snap.x + (h.x - b.snap.x) * k;
      b.y = b.snap.y + (h.y - b.snap.y) * k;
      b.a = b.snap.a * (1 - k);
      if (t === 1) place(b);
    }
    if (state === 'whole') return;

    if (state === 'floating') {
      // The rebuild clock restarts whenever a shard is let go and waits while one is held.
      if (!drag && now - idleSince >= REBUILD_DELAY_MS) beginReturn(now);
    } else if (state === 'returning') {
      for (const b of bodies.filter((b) => b.from)) {
        const t = Math.max(0, Math.min(1, (now - returnAt - b.delay) / RETURN_MS));
        const k = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        const h = home(b);
        b.x = b.from.x + (h.x - b.from.x) * k;
        b.y = b.from.y + (h.y - b.from.y) * k;
        b.a = b.from.a * (1 - k);
        // Each shard melts into the icon the moment it lands, so two never sit side by side.
        if (t === 1) place(b);
      }
      if (state === 'whole') return; // the last shard was fitted by hand meanwhile
      if (!bodies.some((b) => b.from)) state = 'missing';
    }

    for (const b of bodies) draw(b);
    run(); // a broken heart never comes to rest
  }

  function run() {
    if (raf) return;
    if (!last || performance.now() - last > 100) { last = performance.now(); acc = 0; }
    raf = requestAnimationFrame(frame);
  }

  button.addEventListener('click', (e) => {
    if (state === 'whole') shatter();
    // Keyboard has no drag, so Enter/Space on the broken heart fetches the shard.
    else if (state === 'missing' && e.detail === 0 && !drag && loose && !loose.snap) snapHome(loose);
  });

  addEventListener('resize', () => {
    for (const b of bodies) b.s = scale();
    if (bodies.length) run();
  });
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}
