// The heart in the tagline: press it and it shatters into rigid shards that fall to the
// bottom of the window. Every shard can be grabbed and thrown, even in midair. Once they
// can be fitted back into the heart by hand, one at a time. If they are left lying still
// and untouched for a while, the remaining ones drift back into place by themselves,
// except one, which stays on the floor until it is dragged back into its gap.

const NS = 'http://www.w3.org/2000/svg';
const BOX = 24; // heart viewBox size
const SAMPLES = 72; // points sampled along the heart outline
const SHARDS = 7;
const GRAVITY = 2400; // px/s^2
const STEP = 1 / 240;
const MAX_SPIN = 22; // rad/s; tiny shards would otherwise buzz like tops
const REBUILD_DELAY_MS = 5000; // all shards settled and none held, for this long
const RETURN_MS = 2200;
const STAGGER_MS = 140;
const SNAP_RADIUS = 18; // px from home at which a dropped shard clicks in

const button = document.querySelector('[data-heart]');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

if (button && !reduced.matches) init();

function init() {
  const icon = button.querySelector('svg');
  const shape = icon.querySelector('[data-heart-shape]');
  const kept = icon.querySelector('[data-heart-kept]');

  // Full-window layer the shards live in. It ignores the pointer except on the shards.
  const layer = document.createElementNS(NS, 'svg');
  layer.setAttribute('aria-hidden', 'true');
  layer.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible';
  document.body.append(layer);

  let state = 'whole'; // whole | falling | returning | missing
  let bodies = [];
  let wedges = []; // every wedge of the current fracture, home or not
  let serial = 0;
  let loose = null; // the shard left behind
  let drag = null; // { body, id, dx, dy, vx, vy, t }
  let raf = 0;
  let last = 0;
  let acc = 0;
  let settledAt = 0;
  // Walls and floor, in the same coordinates the shards are drawn in. Read from the layer
  // itself, not window.innerWidth/Height: those shrink to the visible area when a phone
  // is pinch-zoomed, which would put the floor in the middle of the page.
  let W = 0, H = 0;
  let returnAt = 0;

  const scale = () => icon.getBoundingClientRect().width / BOX;
  const home = (b) => {
    const r = icon.getBoundingClientRect();
    const s = r.width / BOX;
    return { x: r.left + b.cx * s, y: r.top + b.cy * s };
  };
  const unwind = (a) => Math.atan2(Math.sin(a), Math.cos(a));

  function outline() {
    const total = shape.getTotalLength();
    return Array.from({ length: SAMPLES }, (_, i) => {
      const p = shape.getPointAtLength((i / SAMPLES) * total);
      return [p.x, p.y];
    });
  }

  // Cuts the heart into wedges that meet at a jittered point near its middle.
  function fracture() {
    const pts = outline();
    const centre = [12 + rand(-1.6, 1.6), 11.5 + rand(-1.6, 1.6)];
    const span = SAMPLES / SHARDS;
    const offset = rand(0, span);
    const cuts = Array.from({ length: SHARDS }, (_, i) => Math.round(offset + i * span + rand(-0.3, 0.3) * span));
    return cuts.map((from, i) => {
      const to = i + 1 < SHARDS ? cuts[i + 1] : cuts[0] + SAMPLES;
      const poly = [centre];
      for (let k = from; k <= to; k++) poly.push(pts[((k % SAMPLES) + SAMPLES) % SAMPLES]);
      return poly;
    });
  }

  function makeBody(poly) {
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
    const local = poly.map(([x, y]) => [x - cx, y - cy]);
    const s = scale();
    const el = document.createElementNS(NS, 'g');
    // A generous invisible handle so a few-pixel shard is easy to grab.
    const handle = document.createElementNS(NS, 'circle');
    handle.setAttribute('r', String(22 / s));
    handle.setAttribute('fill', 'transparent');
    // The shard is the real heart curve seen through its wedge, so at home it is
    // pixel-identical to the same region of the icon and the hand-over shows no jump.
    const id = `shard-${++serial}`;
    const clip = document.createElementNS(NS, 'clipPath');
    clip.setAttribute('id', id);
    const cut = document.createElementNS(NS, 'path');
    cut.setAttribute('d', toPath(wedge(poly)));
    clip.append(cut);
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', shape.getAttribute('d'));
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('clip-path', `url(#${id})`);
    const art = document.createElementNS(NS, 'g');
    art.setAttribute('transform', `translate(${-cx} ${-cy})`);
    art.append(clip, path);
    el.append(handle, art);
    el.style.cssText = 'pointer-events:auto;cursor:grab;touch-action:none';
    layer.append(el);
    const r2 = local.reduce((sum, [x, y]) => sum + x * x + y * y, 0) / local.length;
    const body = {
      el, poly, local, cx, cy, s,
      area: Math.abs(area / 2),
      inertia: (r2 * s * s) / 2, // per unit mass
      x: 0, y: 0, a: 0, vx: 0, vy: 0, w: 0,
      rest: 0, ground: 0, asleep: false,
      from: null, // set while gliding back into the heart
      snap: null, // set while clicking into the gap
    };
    Object.assign(body, home(body));
    el.addEventListener('pointerdown', (e) => grab(e, body));
    return body;
  }

  function draw(b) {
    b.el.setAttribute('transform', `translate(${b.x.toFixed(2)} ${b.y.toFixed(2)}) rotate(${((b.a * 180) / Math.PI).toFixed(2)}) scale(${b.s})`);
  }

  // One contact between a shard corner and a wall or the floor: push out, then bounce and rub.
  function contact(b, rx, ry, nx, ny, depth) {
    b.x += nx * depth;
    b.y += ny * depth;
    const vpx = b.vx - b.w * ry;
    const vpy = b.vy + b.w * rx;
    const vn = vpx * nx + vpy * ny;
    if (vn >= 0) return;
    const rn = rx * ny - ry * nx;
    const bounce = vn < -90 ? 0.3 : 0;
    const j = (-(1 + bounce) * vn) / (1 + (rn * rn) / b.inertia);
    b.vx += j * nx;
    b.vy += j * ny;
    b.w += (rn * j) / b.inertia;
    const tx = -ny, ty = nx;
    const vt = (b.vx - b.w * ry) * tx + (b.vy + b.w * rx) * ty;
    const rt = rx * ty - ry * tx;
    const jt = Math.max(-0.5 * j, Math.min(0.5 * j, -vt / (1 + (rt * rt) / b.inertia)));
    b.vx += jt * tx;
    b.vy += jt * ty;
    b.w += (rt * jt) / b.inertia;
  }

  function step(b, dt) {
    b.vy += GRAVITY * dt;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.w = Math.max(-MAX_SPIN, Math.min(MAX_SPIN, b.w));
    b.a += b.w * dt;
    const cos = Math.cos(b.a) * b.s, sin = Math.sin(b.a) * b.s;
    let grounded = false;
    for (const [lx, ly] of b.local) {
      const rx = lx * cos - ly * sin;
      const ry = lx * sin + ly * cos;
      if (b.y + ry > H) { contact(b, rx, ry, 0, -1, b.y + ry - H); grounded = true; }
      if (b.x + rx < 0) contact(b, rx, ry, 1, 0, -(b.x + rx));
      if (b.x + rx > W) contact(b, rx, ry, -1, 0, b.x + rx - W);
    }
    if (grounded) {
      b.vx *= 0.985;
      b.w *= 0.97;
      const slow = b.vx * b.vx + b.vy * b.vy < 900 && Math.abs(b.w) < 4;
      b.rest = slow ? b.rest + dt : 0;
      b.ground += dt; // total floor time; stops a shard that rocks forever
      if (b.rest > 0.2 || b.ground > 1.2) { b.asleep = true; b.vx = b.vy = b.w = 0; }
    } else {
      b.rest = 0;
    }
  }

  const held = (b) => drag && drag.body === b;
  const free = (b) => !b.asleep && !b.from && !b.snap && !held(b);

  function wake(b) {
    b.asleep = false;
    b.rest = b.ground = 0;
  }

  // A shard's wedge, pushed outward from the fracture point so it reaches past the heart's
  // edge: the wedge only decides which slice of the heart is meant, the curve does the rest.
  const wedge = ([c, ...rim]) => [c, ...rim.map(([x, y]) => [c[0] + (x - c[0]) * 1.6, c[1] + (y - c[1]) * 1.6])];
  const toPath = (poly) => 'M' + poly.map((p) => p.join(' ')).join('L') + 'Z';

  // The icon stays on screen showing only the wedges whose shards are home. Fitted
  // wedges overlap by a hair (the mask's stroke) so no seam shows between them.
  function updateMask() {
    const out = new Set(bodies.map((b) => b.poly));
    kept.setAttribute('d', wedges.filter((w) => !out.has(w)).map((w) => toPath(wedge(w))).join(''));
    if (bodies.length) shape.setAttribute('mask', 'url(#heart-kept)');
    else shape.removeAttribute('mask');
  }

  // A shard has arrived in its gap: it becomes part of the heart again.
  function place(b) {
    b.el.remove();
    bodies = bodies.filter((other) => other !== b);
    if (loose === b) loose = null;
    updateMask();
    if (!bodies.length) {
      button.removeAttribute('data-broken');
      state = 'whole';
    }
  }

  function shatter() {
    state = 'falling';
    settledAt = 0;
    button.setAttribute('data-broken', '');
    wedges = fracture();
    bodies = wedges.map(makeBody);
    updateMask();
    for (const b of bodies) {
      const dx = b.cx - 12, dy = b.cy - 11.5;
      const len = Math.hypot(dx, dy) || 1;
      const speed = rand(70, 190);
      b.vx = (dx / len) * speed + rand(-30, 30);
      b.vy = (dy / len) * speed - rand(180, 340);
      b.w = rand(-9, 9);
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
    drag = { body: b, id: e.pointerId, dx: b.x - e.clientX, dy: b.y - e.clientY, vx: 0, vy: 0, t: e.timeStamp };
    b.el.addEventListener('pointermove', move);
    b.el.addEventListener('pointerup', release);
    b.el.addEventListener('pointercancel', release);
    run();
  }

  function move(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const b = drag.body;
    const x = e.clientX + drag.dx, y = e.clientY + drag.dy;
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
      // A pointer that paused before letting go drops the shard instead of flinging it.
      const stale = e.timeStamp - drag.t > 80;
      b.vx = stale ? 0 : Math.max(-cap, Math.min(cap, drag.vx));
      b.vy = stale ? 0 : Math.max(-cap, Math.min(cap, drag.vy));
      b.w = rand(-6, 6);
      wake(b);
    }
    drag = null;
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

    // Shards in free fall.
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

    let active = bodies.some((b) => free(b) || b.snap) || !!drag;

    if (state === 'falling') {
      // The rebuild clock only runs while every remaining shard is still and nobody is holding one.
      if (bodies.every((b) => b.asleep) && !drag) {
        settledAt ||= now;
        if (now - settledAt >= REBUILD_DELAY_MS) beginReturn(now);
      } else {
        settledAt = 0;
      }
      active = true;
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
      active = true;
    }

    for (const b of bodies) draw(b);
    if (active) run();
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
    for (const b of bodies) { b.s = scale(); wake(b); }
    if (bodies.length) run();
  });
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}
