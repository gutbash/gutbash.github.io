// The heart in the tagline: press it and it bursts into rigid shards that drift as if
// weightless, tumbling slowly about any axis and never quite stopping, bouncing softly
// off the edges of the page. Every shard can be grabbed and
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
const SPIN_DRIFT = 0.45; // rad/s; nor tumble slower than this
const BOUNCE = 0.85; // speed kept when bouncing off an edge of the page
const REBUILD_DELAY_MS = 5000; // since the burst or the last shard was let go, none held
const RETURN_MS = 2200;
const STAGGER_MS = 140;
const THICK = 0.25; // shard thickness, in heart viewBox units
const SNAP_RADIUS = 18; // px from home at which a dropped shard clicks in

const button = document.querySelector('[data-heart]');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

if (reduced.matches) document.querySelector('[data-heart-beat]')?.remove();
else if (button) init();

function init() {
  const icon = button.querySelector('svg');
  const shape = icon.querySelector('[data-heart-shape]');
  const kept = icon.querySelector('[data-heart-kept]');
  const beat = icon.querySelector('[data-heart-beat]');

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

  // A shard's orientation is a unit quaternion [w, x, y, z], so it can tumble about any
  // axis. A flat shape turned in 3D and viewed straight on is just a 2D affine transform
  // of itself, so the shards stay plain vector paths: no CSS 3D, nothing rasterised.
  // tilt() reads the orientation as one turn about one axis, taking the short way round;
  // setTilt() writes it back. Easing the angle to zero lays the shard flat and upright.
  function tilt(b) {
    let [w, x, y, z] = b.q;
    if (w < 0) { w = -w; x = -x; y = -y; z = -z; }
    const n = Math.hypot(x, y, z);
    return n < 1e-6 ? { axis: [0, 0, 1], angle: 0 } : { axis: [x / n, y / n, z / n], angle: 2 * Math.atan2(n, w) };
  }
  function setTilt(b, { axis, angle }, k = 1) {
    const h = (angle * k) / 2, sin = Math.sin(h);
    b.q = [Math.cos(h), axis[0] * sin, axis[1] * sin, axis[2] * sin];
  }

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
    handle.setAttribute('r', '22');
    handle.setAttribute('fill', 'transparent');
    // The shard is one plain filled outline that follows the heart's curve point by
    // point. Plain paths are redrawn sharp at any zoom; clipped or masked ones are not
    // (iOS Safari draws those through a fixed-resolution bitmap, which pixelates).
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', toPath(fine));
    path.setAttribute('fill', 'currentColor');
    // The shard's cut and outer edges, seen when it is turned: redrawn every frame from
    // the rough hull, under the face.
    const side = document.createElementNS(NS, 'path');
    side.setAttribute('fill', 'currentColor');
    el.append(handle, side, path);
    el.style.cssText = 'pointer-events:auto;cursor:grab;touch-action:none';
    layer.append(el);
    const r2 = local.reduce((sum, [x, y]) => sum + x * x + y * y, 0) / local.length;
    const body = {
      el, wedge, local, cx, cy, s,
      area: Math.abs(area / 2),
      inertia: (r2 * s * s) / 2, // per unit mass
      x: 0, y: 0, vx: 0, vy: 0,
      q: [1, 0, 0, 0],
      w: 0, wx: 0, wy: 0, // turn rate about the axis out of the page, and the two in it
      path, side,
      turn: Math.sign(area), // which way round the outline runs
      from: null, // set while gliding back into the heart
      snap: null, // set while clicking into the gap
    };
    Object.assign(body, home(body));
    el.addEventListener('pointerdown', (e) => grab(e, body));
    return body;
  }

  // A shard is a slab: its face, plus the walls between its two faces. Seen straight on
  // (no perspective), the nearer face is the flat shape under a 2D matrix, and the walls
  // are one quad per hull edge, running back to where the far face's edge would be. The
  // far face itself is always hidden behind those. Faces dim as they turn away and walls
  // brighten as they turn into view, mixed with the page colour so everything stays
  // opaque. Lying flat, the walls vanish and the face is exactly the heart's own colour.
  function draw(b) {
    const at = `translate(${b.x.toFixed(2)} ${b.y.toFixed(2)})`;
    if (at !== b.drawnAt) b.el.setAttribute('transform', (b.drawnAt = at));
    const [w, x, y, z] = b.q;
    const s = b.s;
    const m00 = (1 - 2 * (y * y + z * z)) * s, m01 = 2 * (x * y - w * z) * s;
    const m10 = 2 * (x * y + w * z) * s, m11 = (1 - 2 * (x * x + z * z)) * s;
    const nz = 1 - 2 * (x * x + y * y); // how squarely the face looks at the viewer
    const half = ((nz < 0 ? -1 : 1) * THICK * s) / 2;
    const ox = 2 * (x * z + w * y) * half, oy = 2 * (y * z - w * x) * half; // to the nearer face
    const face = `matrix(${m00.toFixed(4)} ${m10.toFixed(4)} ${m01.toFixed(4)} ${m11.toFixed(4)} ${ox.toFixed(3)} ${oy.toFixed(3)})`;
    if (face === b.drawn) return;
    b.drawn = face;
    b.path.setAttribute('transform', face);
    const shade = (el, pct) => {
      if (el.shade === pct) return;
      el.shade = pct;
      el.style.fill = pct >= 100 ? '' : `color-mix(in srgb, currentColor ${pct}%, var(--bg))`;
    };
    shade(b.path, Math.round(55 + 45 * Math.abs(nz)));
    if (Math.hypot(ox, oy) < 0.02) { b.side.setAttribute('d', ''); return; }
    shade(b.side, Math.round(50 + 40 * Math.sqrt(Math.max(0, 1 - nz * nz))));
    // Every piece of the wall path is wound the same way, so overlapping quads add up
    // under the nonzero fill rule and never punch holes in each other.
    const pts = b.local.map(([lx, ly]) => [lx * m00 + ly * m01, lx * m10 + ly * m11]);
    if (b.turn * nz < 0) pts.reverse();
    const f = (n) => n.toFixed(2);
    let d = 'M' + pts.map(([px, py]) => `${f(px + ox)} ${f(py + oy)}`).join('L') + 'Z';
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % pts.length];
      const quad = [[ax + ox, ay + oy], [bx + ox, by + oy], [bx - ox, by - oy], [ax - ox, ay - oy]];
      if ((bx - ax) * oy - (by - ay) * ox > 0) quad.reverse();
      d += 'M' + quad.map(([qx, qy]) => `${f(qx)} ${f(qy)}`).join('L') + 'Z';
    }
    b.side.setAttribute('d', d);
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
    // Weightless: nothing pushes or pulls. Fast motion bleeds off, but never below a slow drift and a slow turn.
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
    const spin = Math.hypot(b.wx, b.wy, b.w);
    let k;
    if (spin < 0.01) {
      b.wx = rand(-1, 1) * 0.01; b.wy = rand(-1, 1) * 0.01; b.w = rand(-1, 1) * 0.01;
      k = 1;
    } else if (spin > SPIN_DRIFT) k = Math.min(MAX_SPIN / spin, Math.max(SPIN_DRIFT / spin, Math.exp(-DRAG * dt)));
    else k = Math.min(SPIN_DRIFT, spin + 0.5 * dt) / spin;
    b.wx *= k; b.wy *= k; b.w *= k;

    b.x += b.vx * dt;
    b.y += b.vy * dt;
    // q += (dt / 2) * omega * q, with the turn rate in page axes.
    let [qw, qx, qy, qz] = b.q;
    const hx = (b.wx * dt) / 2, hy = (b.wy * dt) / 2, hz = (b.w * dt) / 2;
    const nw = qw - hx * qx - hy * qy - hz * qz;
    const nx = qx + hx * qw + hy * qz - hz * qy;
    const ny = qy - hx * qz + hy * qw + hz * qx;
    const nz = qz + hx * qy - hy * qx + hz * qw;
    const norm = Math.hypot(nw, nx, ny, nz);
    b.q = [qw, qx, qy, qz] = [nw / norm, nx / norm, ny / norm, nz / norm];
    const m00 = (1 - 2 * (qy * qy + qz * qz)) * b.s, m01 = 2 * (qx * qy - qw * qz) * b.s;
    const m10 = 2 * (qx * qy + qw * qz) * b.s, m11 = (1 - 2 * (qx * qx + qz * qz)) * b.s;
    for (const [lx, ly] of b.local) {
      const rx = lx * m00 + ly * m01;
      const ry = lx * m10 + ly * m11;
      if (b.x + rx < 0) contact(b, rx, ry, 1, 0, -(b.x + rx));
      if (b.x + rx > W) contact(b, rx, ry, -1, 0, b.x + rx - W);
      if (b.y + ry < 0) contact(b, rx, ry, 0, 1, -(b.y + ry));
      if (b.y + ry > H) contact(b, rx, ry, 0, -1, b.y + ry - H);
    }
  }

  const held = (b) => drag && drag.body === b;
  const free = (b) => !b.from && !b.snap && !held(b);

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
      // The beat kept time unseen while the heart was broken; restart it from the top so
      // the mended heart's first beat is a whole one.
      beat?.beginElement();
    }
  }

  // Throws a shard outwards from the middle of the heart, tumbling.
  function burst(b) {
    const dx = b.cx - 12, dy = b.cy - 11.5;
    const len = Math.hypot(dx, dy) || 1;
    const speed = rand(240, 520);
    b.vx = (dx / len) * speed + rand(-60, 60);
    b.vy = (dy / len) * speed + rand(-60, 60);
    b.w = rand(-10, 10);
    b.wx = rand(-9, 9);
    b.wy = rand(-9, 9);
  }

  function shatter() {
    state = 'floating';
    idleSince = performance.now();
    button.setAttribute('data-broken', '');
    wedges = fracture();
    bodies = wedges.map(makeBody);
    updateKept();
    bodies.forEach(burst);
    run();
  }

  // The heart is broken but some of it is back in place: break that part again, along
  // the same cracks, so the shards still adrift go on fitting.
  function reshatter() {
    const out = new Set(bodies.map((b) => b.wedge));
    const fresh = wedges.filter((w) => !out.has(w)).map(makeBody);
    if (!fresh.length) return;
    state = 'floating';
    loose = null;
    idleSince = performance.now();
    bodies.push(...fresh);
    updateKept();
    fresh.forEach(burst);
    run();
  }

  function beginReturn(now) {
    state = 'returning';
    returnAt = now;
    loose = bodies.reduce((a, b) => (b.area > a.area ? b : a));
    let i = 0;
    for (const b of bodies) {
      if (b === loose) continue;
      b.from = { x: b.x, y: b.y, tilt: tilt(b) };
      b.delay = i++ * STAGGER_MS;
      b.el.style.pointerEvents = 'none';
    }
  }

  function grab(e, b) {
    if (drag || b.from || b.snap) return;
    e.preventDefault();
    b.el.setPointerCapture(e.pointerId);
    b.el.style.cursor = 'grabbing';
    b.vx = b.vy = b.w = b.wx = b.wy = 0;
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
      b.wx = rand(-5, 5);
      b.wy = rand(-5, 5);
    }
    drag = null;
    idleSince = performance.now();
    run();
  }

  function snapHome(b) {
    b.snap = { x: b.x, y: b.y, tilt: tilt(b), t: performance.now() };
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
    // The held shard lies flat and straightens up so it arrives ready to fit.
    if (drag) setTilt(drag.body, tilt(drag.body), Math.pow(0.002, dt));

    // Shards clicking into their gaps.
    for (const b of bodies.filter((b) => b.snap)) {
      const t = Math.min(1, (now - b.snap.t) / 220);
      const k = 1 - Math.pow(1 - t, 3);
      const h = home(b);
      b.x = b.snap.x + (h.x - b.snap.x) * k;
      b.y = b.snap.y + (h.y - b.snap.y) * k;
      setTilt(b, b.snap.tilt, 1 - k);
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
        setTilt(b, b.from.tilt, 1 - k);
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
    // Pressing what is left of a mended heart breaks it again.
    else if (e.detail !== 0 && state !== 'returning' && !bodies.some((b) => b.snap)) reshatter();
  });

  addEventListener('resize', () => {
    for (const b of bodies) b.s = scale();
    if (bodies.length) run();
  });
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}
