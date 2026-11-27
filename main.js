// Night Sky — the sky above you right now.
//
// Model: the observer stands at the origin. World axes are the local horizon
// frame: +x = east, +y = zenith (up), -z = north (+z = south). Stars live in an
// equatorial frame inside `skyGroup`; every frame its matrix is set to the
// equatorial -> horizon rotation for the observer's latitude and the local
// sidereal time, so the sky turns exactly as the real one does. The ground
// (drawn last, on top) hides everything below the horizon.
import * as THREE from './vendor/three.module.js';

const DEG = Math.PI / 180;
const SKY_R = 100; // radius of the star sphere (camera sits at its centre)

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const els = {
  canvas: $('#sky'),
  labels: $('#labels'),
  tooltip: $('#tooltip'),
  panel: $('#panel'),
  panelContent: $('#panel-content'),
  panelClose: $('#panel-close'),
  topbar: $('#topbar'),
  controls: $('#controls'),
  tz: $('#meta-timezone'),
  time: $('#meta-time'),
  loc: $('#meta-location'),
  sun: $('#meta-sun'),
  timeOffset: $('#time-offset'),
  timeLabel: $('#time-label'),
  timeNow: $('#time-now'),
  toggleLines: $('#toggle-lines'),
  toggleLabels: $('#toggle-labels'),
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  // Greenwich until the browser tells us where the user is.
  lat: 51.4779,
  lon: -0.0015,
  place: 'Greenwich (default)',
  locKnown: false,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  offsetMin: 0, // time shift the sky is drawn for (eases toward offsetTarget)
  offsetTarget: 0, // time shift chosen with the slider / wheel, in minutes
  yaw: 180 * DEG, // azimuth the camera faces (0 = north, 90° = east)
  pitch: 32 * DEG, // altitude the camera faces
  fov: 80,
  userMoved: false,
  pointer: { x: 0, y: 0, inside: false, down: false, moved: 0, lastX: 0, lastY: 0 },
  edgeArmed: false, // edge-panning only after the user moves the cursor into an edge
  edgeSince: 0, // when the cursor entered the edge zone (ms)
  hovered: null, // constellation under the cursor
  hoveredStar: null,
  selected: null, // constellation shown in the panel
  showLines: true,
  showLabels: false,
};

let stars = [];
let brightStars = []; // stars that can be hovered individually
const starByHip = new Map();
let consts = [];
const constByAbbr = new Map();

// ---------------------------------------------------------------------------
// Astronomy
// ---------------------------------------------------------------------------
const julianDate = (ms) => ms / 86400000 + 2440587.5;

// Greenwich mean sidereal time in degrees (IAU 1982 expression).
function gmstDeg(ms) {
  const d = julianDate(ms) - 2451545.0;
  const t = d / 36525;
  const g = 280.46061837 + 360.98564736629 * d + 0.000387933 * t * t - (t * t * t) / 38710000;
  return ((g % 360) + 360) % 360;
}

const lstRad = (ms, lonDeg) => (gmstDeg(ms) + lonDeg) * DEG;

// Unit vector in the equatorial frame (x -> RA 0h, z -> north celestial pole).
function eqVec(raHours, decDeg, r = 1) {
  const a = raHours * 15 * DEG;
  const d = decDeg * DEG;
  return new THREE.Vector3(r * Math.cos(d) * Math.cos(a), r * Math.cos(d) * Math.sin(a), r * Math.sin(d));
}

// Rotation taking equatorial vectors to the horizon frame (x east, y up, z south).
function eqToHorizon(ms, latDeg, lonDeg, out = new THREE.Matrix4()) {
  const L = lstRad(ms, lonDeg);
  const p = latDeg * DEG;
  const cL = Math.cos(L), sL = Math.sin(L), cp = Math.cos(p), sp = Math.sin(p);
  return out.set(
    -sL, cL, 0, 0,
    cp * cL, cp * sL, sp, 0,
    sp * cL, sp * sL, -cp, 0,
    0, 0, 0, 1,
  );
}

// Precession (IAU 1976) from the catalogue's J2000 coordinates to the equinox of date.
const _pa = new THREE.Matrix4(), _pb = new THREE.Matrix4();
function precession(ms, out = new THREE.Matrix4()) {
  const t = (julianDate(ms) - 2451545.0) / 36525;
  const as = DEG / 3600;
  const zeta = (2306.2181 * t + 0.30188 * t * t + 0.017998 * t * t * t) * as;
  const z = (2306.2181 * t + 1.09468 * t * t + 0.018203 * t * t * t) * as;
  const theta = (2004.3109 * t - 0.42665 * t * t - 0.041833 * t * t * t) * as;
  return out.makeRotationZ(z).multiply(_pa.makeRotationY(-theta)).multiply(_pb.makeRotationZ(zeta));
}

// Full J2000-catalogue -> horizon rotation for a moment and place.
const _prec = new THREE.Matrix4();
function skyMatrixAt(ms, latDeg, lonDeg, out = new THREE.Matrix4()) {
  return eqToHorizon(ms, latDeg, lonDeg, out).multiply(precession(ms, _prec));
}

// Horizon-frame vector -> { alt, az } in degrees (az from north through east).
function altAz(v) {
  const alt = Math.asin(THREE.MathUtils.clamp(v.y / v.length(), -1, 1)) / DEG;
  let az = Math.atan2(v.x, -v.z) / DEG;
  if (az < 0) az += 360;
  return { alt, az };
}

// Low-precision Sun position (good to ~0.01°), returns RA hours / Dec degrees.
function sunRaDec(ms) {
  const n = julianDate(ms) - 2451545.0;
  const L = (280.46 + 0.9856474 * n) * DEG;
  const g = (357.528 + 0.9856003 * n) * DEG;
  const lambda = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const eps = (23.439 - 0.0000004 * n) * DEG;
  let ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda)) / DEG / 15;
  if (ra < 0) ra += 24;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda)) / DEG;
  return { ra, dec };
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const COMPASS_WORDS = {
  N: 'north', NNE: 'north-northeast', NE: 'northeast', ENE: 'east-northeast', E: 'east',
  ESE: 'east-southeast', SE: 'southeast', SSE: 'south-southeast', S: 'south',
  SSW: 'south-southwest', SW: 'southwest', WSW: 'west-southwest', W: 'west',
  WNW: 'west-northwest', NW: 'northwest', NNW: 'north-northwest',
};
const compass = (az) => COMPASS[Math.round(az / 22.5) % 16];

// B−V colour index -> RGB (Ballesteros temperature + Tanner Helland blackbody fit),
// softened toward white because the eye sees star colours as pale tints.
function bvToRgb(bv) {
  const b = THREE.MathUtils.clamp(bv ?? 0.6, -0.4, 2.0);
  const t = 4600 * (1 / (0.92 * b + 1.7) + 1 / (0.92 * b + 0.62)) / 100;
  let r, g, bl;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    bl = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    bl = 255;
  }
  const c = (x) => THREE.MathUtils.clamp(x, 0, 255) / 255;
  const mix = 0.45; // desaturate
  return [c(r) * (1 - mix) + mix, c(g) * (1 - mix) + mix, c(bl) * (1 - mix) + mix];
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}
const fmtMag = (m) => (m == null ? '—' : m.toFixed(2));
function fmtDist(ly) {
  if (ly == null) return '—';
  if (ly < 100) return `${ly.toFixed(1)} ly`;
  return `${Math.round(ly).toLocaleString('en-GB')} ly`;
}
function fmtLatLon(lat, lon) {
  return `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(2)}° ${lon >= 0 ? 'E' : 'W'}`;
}
function fmtClock(ms, withDate = false) {
  const opts = { timeZone: state.timeZone, hour: '2-digit', minute: '2-digit', hour12: false };
  if (withDate) Object.assign(opts, { weekday: 'short', day: 'numeric', month: 'short' });
  return new Intl.DateTimeFormat('en-GB', opts).format(new Date(ms));
}
const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

function designation(star, cst) {
  const gen = cst?.genitive || star.con;
  if (star.bayer) return `${star.bayer}${star.bayerSup || ''} ${gen}`;
  if (star.flam) return `${star.flam} ${gen}`;
  return `HIP ${star.hip}`;
}
const starTitle = (s, cst) => s.name || designation(s, cst);
// Stellarium's English name, unless it just repeats the Latin one (Orion, Perseus…).
const meaningOf = (c) => (c.meaning && c.meaning !== c.name ? c.meaning : '');

function starKind(spect) {
  const sp = (spect || '').trim();
  const cls = (sp.match(/[OBAFGKM]/) || [])[0];
  const colours = { O: 'Blue', B: 'Blue-white', A: 'White', F: 'Yellow-white', G: 'Yellow', K: 'Orange', M: 'Red' };
  const rest = sp.replace(/^[^IV]*/, '');
  let lum = '';
  if (/III/.test(rest)) lum = 'giant';
  else if (/IV/.test(rest)) lum = 'subgiant';
  else if (/II/.test(rest)) lum = 'bright giant';
  else if (/I(a|b|ab)?/.test(rest) && !/V/.test(rest)) lum = 'supergiant';
  else if (/V/.test(rest)) lum = 'main-sequence';
  if (!cls) return sp || '—';
  return `${colours[cls]} ${lum || 'star'}`.replace(/^\w/, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ canvas: els.canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(state.fov, window.innerWidth / window.innerHeight, 0.1, 2000);
camera.rotation.order = 'YXZ';

const skyGroup = new THREE.Group(); // equatorial frame, re-oriented every frame
skyGroup.matrixAutoUpdate = false;
scene.add(skyGroup);
const skyMatrix = new THREE.Matrix4();

// Sky dome: dark zenith, faint glow at the horizon.
const domeMaterial = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  depthTest: false,
  uniforms: { uTwilight: { value: 0 } },
  vertexShader: /* glsl */ `
    varying vec3 vDir;
    void main() {
      vDir = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform float uTwilight;
    varying vec3 vDir;
    void main() {
      vec3 d = normalize(vDir);
      float y = max(d.y, 0.0);
      vec3 zenith = vec3(0.006, 0.010, 0.024);
      vec3 horizon = vec3(0.035, 0.052, 0.090);
      vec3 col = mix(horizon, zenith, pow(y, 0.38));
      col += vec3(0.07, 0.08, 0.11) * exp(-y * 14.0) * 0.55;          // airglow / light dome
      col += vec3(0.10, 0.16, 0.30) * uTwilight * exp(-y * 3.0);      // twilight wash
      gl_FragColor = vec4(col, 1.0);
    }`,
});
const dome = new THREE.Mesh(new THREE.SphereGeometry(900, 64, 32), domeMaterial);
dome.renderOrder = -10;
scene.add(dome);

// Ground with a soft hill silhouette. Drawn after stars and lines so it hides
// anything below the horizon.
const groundMaterial = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  transparent: true,
  depthWrite: false,
  depthTest: false,
  vertexShader: /* glsl */ `
    varying vec3 vDir;
    void main() {
      vDir = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    varying vec3 vDir;
    float hill(float az) {
      return 0.016 + 0.009 * sin(az * 3.0 + 1.3) + 0.006 * sin(az * 7.0 + 0.4)
           + 0.003 * sin(az * 17.0 + 2.1) + 0.0015 * sin(az * 41.0 + 0.7);
    }
    void main() {
      vec3 d = normalize(vDir);
      float az = atan(d.x, -d.z);
      float h = hill(az);
      if (d.y > h) discard;
      float depth = clamp((h - d.y) * 5.0, 0.0, 1.0);
      vec3 col = mix(vec3(0.030, 0.034, 0.042), vec3(0.006, 0.007, 0.009), depth);
      gl_FragColor = vec4(col, 1.0);
    }`,
});
const ground = new THREE.Mesh(new THREE.SphereGeometry(800, 128, 64), groundMaterial);
ground.renderOrder = 10;
scene.add(ground);

// Milky Way: a soft, mottled band along the real galactic plane. It lives in the
// equatorial frame (inside skyGroup) so it rises and sets with the stars.
const milkyWayMaterial = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  transparent: true,
  depthWrite: false,
  depthTest: false,
  blending: THREE.AdditiveBlending,
  uniforms: {
    // J2000 north galactic pole and galactic centre directions (equatorial).
    uNgp: { value: eqVec(12.8572, 27.1283) },
    uGc: { value: eqVec(17.7611, -28.9362) },
  },
  vertexShader: /* glsl */ `
    varying vec3 vEq;
    varying float vAlt;
    void main() {
      vEq = normalize(position);
      vec4 world = modelMatrix * vec4(position, 1.0);
      vAlt = normalize(world.xyz).y;
      gl_Position = projectionMatrix * viewMatrix * world;
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 uNgp;
    uniform vec3 uGc;
    varying vec3 vEq;
    varying float vAlt;
    float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
    float noise(vec3 p) {
      vec3 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
                 mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
    }
    float fbm(vec3 p) {
      float s = 0.0, a = 0.5;
      for (int i = 0; i < 5; i++) { s += a * noise(p); p *= 2.07; a *= 0.5; }
      return s;
    }
    void main() {
      vec3 d = normalize(vEq);
      float b = asin(clamp(dot(d, uNgp), -1.0, 1.0));            // galactic latitude
      vec3 gcPerp = normalize(uGc - dot(uGc, uNgp) * uNgp);
      float cosl = dot(normalize(d - dot(d, uNgp) * uNgp), gcPerp); // cos(galactic longitude)
      float width = 0.16 + 0.08 * (0.5 + 0.5 * cosl);
      float band = exp(-pow(b / width, 2.0));
      float core = 0.55 + 0.45 * pow(0.5 + 0.5 * cosl, 2.0);       // brighter toward Sagittarius
      float mottling = fbm(d * 7.0) * 0.9 + fbm(d * 19.0) * 0.35;
      float dust = smoothstep(0.03, 0.0, abs(b + 0.012 * sin(cosl * 9.0))) * smoothstep(0.2, 0.75, cosl);
      float v = band * core * mottling * (1.0 - 0.6 * dust);
      float fade = smoothstep(0.0, 0.25, vAlt);                    // washed out near the horizon
      vec3 col = vec3(0.62, 0.70, 0.88) * v * 0.17 * fade;
      gl_FragColor = vec4(col, 1.0);
    }`,
});
const milkyWay = new THREE.Mesh(new THREE.SphereGeometry(850, 96, 48), milkyWayMaterial);
milkyWay.renderOrder = 0;
milkyWay.frustumCulled = false;
skyGroup.add(milkyWay);

let starPoints = null;
const starMaterial = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  depthTest: false,
  blending: THREE.AdditiveBlending,
  uniforms: {
    uPixelRatio: { value: renderer.getPixelRatio() },
    uScale: { value: 1 },
    uTime: { value: 0 },
  },
  vertexShader: /* glsl */ `
    attribute vec3 aColor;
    attribute float aSize;
    attribute float aTwinkle;
    uniform float uPixelRatio;
    uniform float uScale;
    uniform float uTime;
    varying vec3 vColor;
    varying float vFade;
    void main() {
      vec4 world = modelMatrix * vec4(position, 1.0);
      float alt = normalize(world.xyz).y;
      // atmospheric extinction: stars fade and shrink close to the horizon
      vFade = smoothstep(-0.005, 0.11, alt);
      float tw = 1.0 + aTwinkle * 0.14 * sin(uTime * 2.7 + position.x * 13.1 + position.y * 7.3);
      vColor = aColor * tw;
      gl_Position = projectionMatrix * viewMatrix * world;
      gl_PointSize = aSize * uPixelRatio * uScale * (0.65 + 0.35 * vFade);
      if (alt < -0.02) gl_PointSize = 0.0;
    }`,
  fragmentShader: /* glsl */ `
    varying vec3 vColor;
    varying float vFade;
    void main() {
      vec2 p = gl_PointCoord * 2.0 - 1.0;
      float r2 = dot(p, p);
      if (r2 > 1.0) discard;
      float core = exp(-r2 * 7.5);
      float halo = exp(-r2 * 2.6) * 0.28;
      float a = (core + halo) * vFade;
      gl_FragColor = vec4(vColor * a, a);
    }`,
});

// Constellation lines: one object per constellation so each can be highlighted.
const LINE_BASE = 0.15;
const LINE_HOVER = 0.7;
const LINE_SELECTED = 0.85;
const lineVertex = /* glsl */ `
  varying float vAlt;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vAlt = normalize(world.xyz).y;
    gl_Position = projectionMatrix * viewMatrix * world;
  }`;
const lineFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vAlt;
  void main() {
    if (vAlt < 0.0) discard;
    gl_FragColor = vec4(uColor, uOpacity * smoothstep(0.0, 0.06, vAlt));
  }`;

function buildStars() {
  const n = stars.length;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const size = new Float32Array(n);
  const twinkle = new Float32Array(n);
  stars.forEach((s, i) => {
    s.vec = eqVec(s.ra, s.dec, 1);
    pos[i * 3] = s.vec.x * SKY_R;
    pos[i * 3 + 1] = s.vec.y * SKY_R;
    pos[i * 3 + 2] = s.vec.z * SKY_R;
    const [r, g, b] = bvToRgb(s.ci);
    // Fainter stars are both smaller and dimmer; the brightest get a little extra bloom.
    const intensity = THREE.MathUtils.clamp(1.3 - s.mag * 0.15, 0.24, 1.25);
    col[i * 3] = r * intensity;
    col[i * 3 + 1] = g * intensity;
    col[i * 3 + 2] = b * intensity;
    size[i] = 3.4 + Math.max(0, 5.2 - s.mag) * 2.9;
    twinkle[i] = s.mag < 2.5 ? 1 : 0.35;
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('aTwinkle', new THREE.BufferAttribute(twinkle, 1));
  starPoints = new THREE.Points(geo, starMaterial);
  starPoints.frustumCulled = false;
  starPoints.renderOrder = 1;
  skyGroup.add(starPoints);
}

// Small angular gap so lines stop just short of each star, like a star chart.
const gapFor = (s) => (0.45 + Math.max(0, 4 - s.mag) * 0.16) * DEG;

function buildConstellations() {
  for (const c of consts) {
    c.segs = [];
    const pts = [];
    for (const poly of c.lines) {
      for (let i = 0; i + 1 < poly.length; i++) {
        const a = starByHip.get(poly[i]);
        const b = starByHip.get(poly[i + 1]);
        if (!a || !b) continue;
        c.segs.push([a, b]);
        const ang = a.vec.angleTo(b.vec);
        const ga = Math.min(gapFor(a), ang * 0.35) / ang;
        const gb = Math.min(gapFor(b), ang * 0.35) / ang;
        const p1 = a.vec.clone().lerp(b.vec, ga).normalize().multiplyScalar(SKY_R);
        const p2 = a.vec.clone().lerp(b.vec, 1 - gb).normalize().multiplyScalar(SKY_R);
        pts.push(p1, p2);
      }
    }
    c.figure = c.figureStars.map((h) => starByHip.get(h)).filter(Boolean);
    c.center = new THREE.Vector3();
    c.figure.forEach((s) => c.center.add(s.vec));
    c.center.normalize();
    c.raCenter = ((Math.atan2(c.center.y, c.center.x) / DEG / 15) + 24) % 24;
    c.decCenter = Math.asin(c.center.z) / DEG;
    c.decMin = Math.min(...c.figure.map((s) => s.dec));
    c.decMax = Math.max(...c.figure.map((s) => s.dec));

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      uniforms: {
        uColor: { value: new THREE.Color(0.55, 0.7, 1.0) },
        uOpacity: { value: LINE_BASE },
      },
      vertexShader: lineVertex,
      fragmentShader: lineFragment,
    });
    c.lineObj = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), mat);
    c.lineObj.frustumCulled = false;
    c.lineObj.renderOrder = 2;
    skyGroup.add(c.lineObj);

    c.labelEl = document.createElement('div');
    c.labelEl.className = 'label con';
    c.labelEl.textContent = c.name;
    c.labelEl.style.display = 'none';
    els.labels.appendChild(c.labelEl);
  }
}

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'].map((name, i) => {
  const el = document.createElement('div');
  el.className = `label cardinal${name.length === 1 ? ' major' : ''}`;
  el.textContent = name;
  els.labels.appendChild(el);
  const az = i * 45 * DEG;
  const alt = -1.4 * DEG;
  return {
    el,
    vec: new THREE.Vector3(Math.cos(alt) * Math.sin(az), Math.sin(alt), -Math.cos(alt) * Math.cos(az)),
  };
});

// ---------------------------------------------------------------------------
// Projection helpers (horizon frame -> screen pixels)
// ---------------------------------------------------------------------------
let W = window.innerWidth;
let H = window.innerHeight;
const _p = new THREE.Vector3();

function toScreen(hVec) {
  _p.copy(hVec).applyMatrix4(camera.matrixWorldInverse);
  if (_p.z > -1e-3) return null; // behind the camera
  _p.applyMatrix4(camera.projectionMatrix);
  return { x: ((_p.x + 1) / 2) * W, y: ((1 - _p.y) / 2) * H };
}

const horizonVec = (eq, out = new THREE.Vector3()) => out.copy(eq).applyMatrix4(skyMatrix);

function distToSegment(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  const t = THREE.MathUtils.clamp(((px - a.x) * dx + (py - a.y) * dy) / len2, 0, 1);
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

function convexHull(points) {
  const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function polygonArea(poly) {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
  return Math.abs(s / 2);
}

// Where each figure star is on screen this frame (null when below the horizon or behind us).
const screenPos = new Map();
const _h = new THREE.Vector3();
function updateScreenPositions() {
  screenPos.clear();
  for (const c of consts) {
    for (const s of c.figure) {
      if (screenPos.has(s.hip)) continue;
      horizonVec(s.vec, _h);
      screenPos.set(s.hip, _h.y > 0 ? toScreen(_h) : null);
    }
  }
}

// What is under the cursor: a bright star, a constellation line, or the area a figure spans.
function pick(px, py) {
  let star = null;
  let bestStar = 10;
  for (const s of brightStars) {
    horizonVec(s.vec, _h);
    if (_h.y <= 0) continue;
    const p = toScreen(_h);
    if (!p) continue;
    const d = Math.hypot(p.x - px, p.y - py) - Math.max(0, 3 - s.mag);
    if (d < bestStar) { bestStar = d; star = s; }
  }
  if (star) return { cst: constByAbbr.get(star.con) || null, star };

  let best = null;
  let bestD = 12;
  for (const c of consts) {
    for (const [a, b] of c.segs) {
      const pa = screenPos.get(a.hip);
      const pb = screenPos.get(b.hip);
      if (!pa || !pb) continue;
      const d = distToSegment(px, py, pa, pb);
      if (d < bestD) { bestD = d; best = c; }
    }
  }
  if (best) return { cst: best, star: null };

  let hullBest = null;
  let hullArea = Infinity;
  for (const c of consts) {
    const pts = c.figure.map((s) => screenPos.get(s.hip)).filter(Boolean);
    if (pts.length < 3) continue;
    const hull = convexHull(pts);
    if (hull.length < 3 || !pointInPolygon(px, py, hull)) continue;
    const area = polygonArea(hull);
    if (area < hullArea) { hullArea = area; hullBest = c; }
  }
  return { cst: hullBest, star: null };
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------
const skyTime = () => Date.now() + state.offsetMin * 60000;

function updateHeader() {
  const now = Date.now();
  els.tz.textContent = state.timeZone;
  els.time.textContent = new Intl.DateTimeFormat('en-GB', {
    timeZone: state.timeZone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(now));
  els.loc.textContent = state.locKnown
    ? `${state.place} · ${fmtLatLon(state.lat, state.lon)}`
    : `${state.place} — allow location access for your own sky`;

  const t = skyTime();
  const sun = sunRaDec(t);
  // sunRaDec is already referred to the equinox of date, so no precession here.
  const sunAlt = altAz(eqVec(sun.ra, sun.dec).applyMatrix4(eqToHorizon(t, state.lat, state.lon))).alt;
  let text;
  if (sunAlt > 0) text = `Up (${sunAlt.toFixed(0)}°) — stars shown as if it were dark`;
  else if (sunAlt > -6) text = `Civil twilight (${sunAlt.toFixed(0)}°)`;
  else if (sunAlt > -12) text = `Nautical twilight (${sunAlt.toFixed(0)}°)`;
  else if (sunAlt > -18) text = `Astronomical twilight (${sunAlt.toFixed(0)}°)`;
  else text = `Night — ${Math.abs(sunAlt).toFixed(0)}° below the horizon`;
  els.sun.textContent = text;
  domeMaterial.uniforms.uTwilight.value = THREE.MathUtils.clamp((sunAlt + 18) / 18, 0, 1) * 0.6;

  const shown = Math.round(state.offsetMin);
  if (state.offsetTarget === 0 && shown === 0) {
    els.timeLabel.textContent = 'Live';
  } else {
    const sign = shown >= 0 ? '+' : '−';
    const h = Math.floor(Math.abs(shown) / 60);
    const m = Math.abs(shown) % 60;
    els.timeLabel.textContent = `${fmtClock(t, true)} (${sign}${h}h${m ? ` ${m}m` : ''})`;
  }
}

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------
function setLocation(lat, lon, place, known) {
  state.lat = lat;
  state.lon = lon;
  state.place = place;
  state.locKnown = known;
  // Southern-hemisphere observers look north by default (toward the celestial equator).
  if (!state.userMoved) state.yaw = (lat >= 0 ? 180 : 0) * DEG;
  updateHeader();
  if (state.selected) renderPanel(state.selected);
}

async function reverseGeocode(lat, lon) {
  try {
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    const city = j.city || j.locality || j.principalSubdivision;
    return [city, j.countryName].filter(Boolean).join(', ') || null;
  } catch {
    return null;
  }
}

async function ipLocation() {
  try {
    const r = await fetch('https://ipapi.co/json/');
    if (!r.ok) return false;
    const j = await r.json();
    if (typeof j.latitude !== 'number') return false;
    const place = [j.city, j.country_name].filter(Boolean).join(', ') || 'Approximate location';
    setLocation(j.latitude, j.longitude, `${place} (approx.)`, true);
    return true;
  } catch {
    return false;
  }
}

function initLocation() {
  updateHeader();
  if (!navigator.geolocation) {
    ipLocation();
    return;
  }
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude, longitude } = pos.coords;
      setLocation(latitude, longitude, 'Your location', true);
      const name = await reverseGeocode(latitude, longitude);
      if (name) setLocation(latitude, longitude, name, true);
    },
    () => { ipLocation(); },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 },
  );
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------
const clampPitch = (p) => THREE.MathUtils.clamp(p, -8 * DEG, 89.9 * DEG);

let lastTooltipKey = '';
function setHover(result) {
  const prev = state.hovered;
  state.hovered = result?.cst || null;
  state.hoveredStar = result?.star || null;
  if (prev !== state.hovered) refreshLineStyles();
  const key = `${state.hovered?.abbr}|${state.hoveredStar?.hip}|${state.pointer.x}|${state.pointer.y}`;
  if (key === lastTooltipKey) return;
  lastTooltipKey = key;
  els.canvas.classList.toggle('hovering', !!state.hovered && !state.pointer.down);
  if (!state.hovered) {
    els.tooltip.hidden = true;
    return;
  }
  const c = state.hovered;
  const s = state.hoveredStar;
  let html = `<div class="tt-name">${escapeHtml(c.name)}</div>${meaningOf(c) ? `<div class="tt-sub">${escapeHtml(meaningOf(c))}</div>` : ''}`;
  if (s) {
    const des = designation(s, c);
    html += `<div class="tt-star">★ ${escapeHtml(s.name ? `${s.name} · ${des}` : des)} · mag ${fmtMag(s.mag)}</div>`;
  }
  els.tooltip.innerHTML = html;
  els.tooltip.hidden = false;
  const tw = els.tooltip.offsetWidth;
  const th = els.tooltip.offsetHeight;
  let x = state.pointer.x + 16;
  let y = state.pointer.y + 16;
  if (x + tw > W - 8) x = state.pointer.x - tw - 12;
  if (y + th > H - 8) y = state.pointer.y - th - 12;
  els.tooltip.style.left = `${x}px`;
  els.tooltip.style.top = `${y}px`;
}

function refreshLineStyles() {
  for (const c of consts) {
    let o = state.showLines ? LINE_BASE : 0;
    if (c === state.selected) o = LINE_SELECTED;
    else if (c === state.hovered) o = LINE_HOVER;
    c.lineObj.material.uniforms.uOpacity.value = o;
  }
}

function onPointerDown(e) {
  if (e.button !== 0) return;
  const p = state.pointer;
  p.down = true;
  p.moved = 0;
  p.lastX = e.clientX;
  p.lastY = e.clientY;
  els.canvas.setPointerCapture(e.pointerId);
  els.canvas.classList.add('dragging');
}

function onPointerMove(e) {
  const p = state.pointer;
  if (Math.abs(e.clientX - p.x) + Math.abs(e.clientY - p.y) > 2) state.edgeArmed = true;
  p.x = e.clientX;
  p.y = e.clientY;
  p.inside = true;
  if (p.down) {
    const dx = e.clientX - p.lastX;
    const dy = e.clientY - p.lastY;
    p.lastX = e.clientX;
    p.lastY = e.clientY;
    p.moved += Math.abs(dx) + Math.abs(dy);
    // "Grab the sky": the point under the cursor follows the cursor.
    const radPerPx = (state.fov * DEG) / H;
    state.yaw -= dx * radPerPx;
    state.pitch = clampPitch(state.pitch + dy * radPerPx);
    state.userMoved = true;
    els.tooltip.hidden = true;
  }
}

function onPointerUp(e) {
  const p = state.pointer;
  if (!p.down) return;
  p.down = false;
  els.canvas.classList.remove('dragging');
  if (els.canvas.hasPointerCapture(e.pointerId)) els.canvas.releasePointerCapture(e.pointerId);
  if (p.moved < 5) {
    // A click, not a drag.
    updateScreenPositions();
    const hit = pick(e.clientX, e.clientY);
    if (hit.cst) openPanel(hit.cst, hit.star);
    else closePanel();
  }
}

function onWheel(e) {
  e.preventDefault();
  state.fov = THREE.MathUtils.clamp(state.fov * Math.exp(e.deltaY * 0.0012), 18, 110);
}

function onKey(e) {
  if (e.target instanceof HTMLInputElement) return;
  const step = 4 * DEG * (state.fov / 80);
  if (e.key === 'Escape') closePanel();
  else if (e.key === 'ArrowLeft') state.yaw -= step;
  else if (e.key === 'ArrowRight') state.yaw += step;
  else if (e.key === 'ArrowUp') state.pitch = clampPitch(state.pitch + step);
  else if (e.key === 'ArrowDown') state.pitch = clampPitch(state.pitch - step);
  else if (e.key === '+' || e.key === '=') state.fov = Math.max(18, state.fov / 1.15);
  else if (e.key === '-') state.fov = Math.min(110, state.fov * 1.15);
  else return;
  state.userMoved = true;
}

// Resting the cursor near an edge of the sky turns the view that way.
function edgePan(dt) {
  const p = state.pointer;
  if (!p.inside || p.down) return;
  const top = els.topbar.getBoundingClientRect().bottom;
  const bottom = els.controls.getBoundingClientRect().top;
  const right = els.panel.classList.contains('open') ? els.panel.getBoundingClientRect().left : W;
  const zone = Math.min(110, W * 0.09);
  const strength = (d) => (d >= zone ? 0 : (1 - Math.max(d, 0) / zone) ** 2);
  const vx = strength(right - p.x) - strength(p.x);
  const vy = strength(p.y - top) - strength(bottom - p.y);
  if (!vx && !vy) {
    state.edgeSince = 0;
    return;
  }
  // Only pan when the user moved into the edge on purpose, after a short dwell,
  // so opening the panel or a click near the edge doesn't spin the sky.
  if (!state.edgeArmed) return;
  const now = performance.now();
  if (!state.edgeSince) state.edgeSince = now;
  const ramp = THREE.MathUtils.clamp((now - state.edgeSince - 250) / 400, 0, 1);
  if (!ramp) return;
  const speed = 55 * DEG * (state.fov / 80) * ramp; // degrees per second at the very edge
  state.yaw += vx * speed * dt;
  state.pitch = clampPitch(state.pitch + vy * speed * dt);
  state.userMoved = true;
}

function onResize() {
  W = window.innerWidth;
  H = window.innerHeight;
  renderer.setSize(W, H, false);
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
}

function wireControls() {
  els.canvas.addEventListener('pointerdown', onPointerDown);
  els.canvas.addEventListener('pointermove', onPointerMove);
  els.canvas.addEventListener('pointerup', onPointerUp);
  els.canvas.addEventListener('pointercancel', onPointerUp);
  els.canvas.addEventListener('pointerleave', () => {
    if (!state.pointer.down) {
      state.pointer.inside = false;
      setHover(null);
    }
  });
  els.canvas.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', onResize);
  els.panelClose.addEventListener('click', closePanel);
  els.timeOffset.addEventListener('input', () => {
    state.offsetTarget = Number(els.timeOffset.value);
  });
  // Scrolling over the time control scrubs through time too (10 minutes per notch).
  els.timeOffset.parentElement.addEventListener('wheel', (e) => {
    e.preventDefault();
    const notches = THREE.MathUtils.clamp(e.deltaY / 100, -3, 3);
    setTimeTarget(state.offsetTarget - notches * 10);
  }, { passive: false });
  els.timeNow.addEventListener('click', () => setTimeTarget(0));
  els.toggleLines.addEventListener('change', () => {
    state.showLines = els.toggleLines.checked;
    refreshLineStyles();
  });
  els.toggleLabels.addEventListener('change', () => {
    state.showLabels = els.toggleLabels.checked;
  });
}

function setTimeTarget(min) {
  state.offsetTarget = THREE.MathUtils.clamp(Math.round(min), -720, 720);
  els.timeOffset.value = String(state.offsetTarget);
}

// Move the drawn time smoothly toward the chosen one, so scrubbing turns the sky
// continuously instead of jumping by the slider's step.
function easeTime(dt) {
  const diff = state.offsetTarget - state.offsetMin;
  if (diff === 0) return false;
  const k = 1 - Math.exp(-dt * 9); // ~110 ms time constant
  state.offsetMin = Math.abs(diff) < 0.05 ? state.offsetTarget : state.offsetMin + diff * k;
  return true;
}

// ---------------------------------------------------------------------------
// Side panel
// ---------------------------------------------------------------------------
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// The month in which the constellation is highest at about 9 pm local time.
function bestMonth(raHours) {
  // At 21:00 local solar time LST ≈ RA(sun) + 9 h, and RA(sun) ≈ 0 h on ~20 March.
  const dayOfYear = (79 + ((((raHours - 9) % 24) + 24) % 24) / 24 * 365.25) % 365.25;
  const date = new Date(Date.UTC(2025, 0, 1) + dayOfYear * 86400000);
  return MONTHS[date.getUTCMonth()];
}

function latitudeRange(c) {
  // The whole figure rises somewhere above the horizon between these latitudes.
  const north = Math.min(90, 90 + c.decMin);
  const south = Math.max(-90, c.decMax - 90);
  const f = (v) => `${Math.abs(Math.round(v))}° ${v >= 0 ? 'N' : 'S'}`;
  return `${f(north)} to ${f(south)}`;
}

function nowLine(c) {
  const t = skyTime();
  const M = skyMatrixAt(t, state.lat, state.lon, new THREE.Matrix4());
  const v = c.center.clone().applyMatrix4(M);
  const { alt, az } = altAz(v);
  // Next upper culmination: when the local sidereal time equals the figure's RA.
  const lstH = lstRad(t, state.lon) / DEG / 15;
  const dh = ((((c.raCenter - lstH) % 24) + 24) % 24) / 1.0027379;
  const transitMs = t + dh * 3600000;
  const transitAlt = 90 - Math.abs(state.lat - c.decCenter);
  const dir = c.decCenter < state.lat ? 'south' : 'north';
  const where = Math.round(state.offsetMin) === 0 ? 'Right now' : `At ${fmtClock(t)}`;
  let first;
  if (alt > 0) first = `${where} it is <strong>${alt.toFixed(0)}° above the horizon</strong>, toward the ${COMPASS_WORDS[compass(az)]}.`;
  else first = `${where} it is <strong>below your horizon</strong>.`;
  let second = '';
  if (transitAlt > 0) second = ` It is highest (${transitAlt.toFixed(0)}° up, due ${dir}) at <strong>${fmtClock(transitMs, dh > 12)}</strong>.`;
  else second = ' It never rises from your latitude.';
  return first + second;
}

function chartSvg(c, highlightHip) {
  const Wc = 348, Hc = 250, pad = 26;
  const a0 = c.raCenter * 15 * DEG;
  const d0 = c.decCenter * DEG;
  const sd0 = Math.sin(d0), cd0 = Math.cos(d0);
  // Gnomonic projection around the figure's centre; north up, east to the left (as seen in the sky).
  const proj = (s) => {
    const a = s.ra * 15 * DEG, d = s.dec * DEG;
    const cosc = sd0 * Math.sin(d) + cd0 * Math.cos(d) * Math.cos(a - a0);
    if (cosc < 0.25) return null;
    const x = (Math.cos(d) * Math.sin(a - a0)) / cosc;
    const y = (cd0 * Math.sin(d) - sd0 * Math.cos(d) * Math.cos(a - a0)) / cosc;
    return { x: -x, y: -y };
  };
  const fig = c.figure.map((s) => ({ s, p: proj(s) })).filter((o) => o.p);
  if (!fig.length) return '';
  const xs = fig.map((o) => o.p.x), ys = fig.map((o) => o.p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const scale = Math.min((Wc - 2 * pad) / (maxX - minX || 1), (Hc - 2 * pad) / (maxY - minY || 1));
  const ox = (Wc - (maxX - minX) * scale) / 2 - minX * scale;
  const oy = (Hc - (maxY - minY) * scale) / 2 - minY * scale;
  const X = (p) => (p.x * scale + ox).toFixed(1);
  const Y = (p) => (p.y * scale + oy).toFixed(1);
  const rOf = (m) => Math.max(1.1, 4.6 - m * 0.65);
  const fill = (s) => {
    const [r, g, b] = bvToRgb(s.ci);
    return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
  };

  let bg = '';
  const maxAng = Math.max(...c.figure.map((s) => s.vec.angleTo(c.center))) + 8 * DEG;
  for (const s of stars) {
    if (s.mag > 5.5 || s.vec.angleTo(c.center) > maxAng || c.figureStars.includes(s.hip)) continue;
    const p = proj(s);
    if (!p) continue;
    const x = p.x * scale + ox, y = p.y * scale + oy;
    if (x < 4 || x > Wc - 4 || y < 4 || y > Hc - 4) continue;
    bg += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(rOf(s.mag) * 0.75).toFixed(2)}" fill="#7f8aa3" opacity="0.45"/>`;
  }

  let lines = '';
  for (const [a, b] of c.segs) {
    const pa = proj(a), pb = proj(b);
    if (!pa || !pb) continue;
    lines += `<line x1="${X(pa)}" y1="${Y(pa)}" x2="${X(pb)}" y2="${Y(pb)}"/>`;
  }

  let dots = '';
  let labels = '';
  const named = fig.slice().sort((p, q) => p.s.mag - q.s.mag);
  named.forEach(({ s, p }, i) => {
    const hl = s.hip === highlightHip;
    dots += `<circle cx="${X(p)}" cy="${Y(p)}" r="${(rOf(s.mag) + (hl ? 1.5 : 0)).toFixed(2)}" fill="${fill(s)}"${hl ? ' stroke="#9cc0ff" stroke-width="1.5"' : ''}/>`;
    const text = i < 4 && s.name ? s.name : s.bayer && s.mag < 4.3 ? `${s.bayer}${s.bayerSup || ''}` : '';
    if (text) labels += `<text x="${(p.x * scale + ox + rOf(s.mag) + 3).toFixed(1)}" y="${(p.y * scale + oy + 3.5).toFixed(1)}">${escapeHtml(text)}</text>`;
  });

  return `
    <svg class="p-chart" viewBox="0 0 ${Wc} ${Hc}" role="img" aria-label="Star chart of ${escapeHtml(c.name)}">
      <g>${bg}</g>
      <g stroke="#7fa3e6" stroke-opacity="0.55" stroke-width="1">${lines}</g>
      <g>${dots}</g>
      <g fill="#c7d3e6" font-size="10.5" font-family="system-ui, sans-serif">${labels}</g>
    </svg>
    <div class="p-chart-note">North up · east left, as it appears in the sky</div>`;
}

function renderPanel(c, highlightHip = state.panelStar) {
  const brightest = starByHip.get(c.brightest);
  const listed = c.figure.slice();
  if (brightest && !listed.includes(brightest)) listed.push(brightest);
  listed.sort((a, b) => a.mag - b.mag);

  const rows = listed.map((s) => {
    const [r, g, b] = bvToRgb(s.ci);
    const sw = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
    const des = designation(s, c);
    const title = s.name
      ? `${escapeHtml(s.name)}<div class="desig">${escapeHtml(des)}</div>`
      : escapeHtml(des);
    return `<tr class="${s.hip === highlightHip ? 'hl' : ''}">
      <td><span class="p-swatch" style="background:${sw}"></span>${title}<div class="kind">${escapeHtml(starKind(s.spect))}</div></td>
      <td class="num">${fmtMag(s.mag)}</td>
      <td class="num">${fmtDist(s.dist)}</td>
    </tr>`;
  }).join('');

  const summary = c.summary
    ? `<p>${escapeHtml(c.summary)}</p>${c.wikiUrl ? `<p><a href="${escapeHtml(c.wikiUrl)}" target="_blank" rel="noopener">Read more on Wikipedia →</a></p>` : ''}`
    : '';

  els.panelContent.innerHTML = `
    <div class="p-eyebrow">Constellation · ${escapeHtml(c.abbr)}</div>
    <h2 class="p-title">${escapeHtml(c.name)}</h2>
    <div class="p-sub">${[meaningOf(c) ? `The ${escapeHtml(meaningOf(c))}` : '', c.genitive ? `genitive <i>${escapeHtml(c.genitive)}</i>` : ''].filter(Boolean).join(' · ')}</div>
    <div class="p-now">${nowLine(c)}</div>
    ${chartSvg(c, highlightHip)}
    <section class="p-section">
      <h3>At a glance</h3>
      <dl class="p-facts">
        ${brightest ? `<dt>Brightest star</dt><dd>${escapeHtml(starTitle(brightest, c))} (mag ${fmtMag(brightest.mag)})</dd>` : ''}
        ${c.area ? `<dt>Size</dt><dd>${Math.round(c.area)} square degrees — ${ordinal(c.areaRank)} largest of 88</dd>` : ''}
        ${c.starCount ? `<dt>Naked-eye stars</dt><dd>${c.starCount} brighter than magnitude 6.5</dd>` : ''}
        <dt>Best seen</dt><dd>Evenings in ${bestMonth(c.raCenter)}</dd>
        <dt>Fully visible</dt><dd>From latitudes ${latitudeRange(c)}</dd>
      </dl>
    </section>
    <section class="p-section">
      <h3>Stars in the figure</h3>
      <table class="p-stars">
        <thead><tr><th>Star</th><th class="num">Mag</th><th class="num">Distance</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>
    ${summary ? `<section class="p-section p-about"><h3>About</h3>${summary}</section>` : ''}
  `;
}

function openPanel(c, star = null) {
  state.selected = c;
  state.panelStar = star?.hip ?? null;
  renderPanel(c);
  els.panel.classList.add('open');
  document.body.classList.add('panel-open');
  state.edgeArmed = false;
  els.panel.setAttribute('aria-hidden', 'false');
  els.panel.scrollTop = 0;
  refreshLineStyles();
}

function closePanel() {
  state.selected = null;
  state.panelStar = null;
  els.panel.classList.remove('open');
  document.body.classList.remove('panel-open');
  state.edgeArmed = false;
  els.panel.setAttribute('aria-hidden', 'true');
  refreshLineStyles();
}

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------
function updateLabels() {
  for (const c of CARDINALS) {
    const p = toScreen(c.vec);
    if (!p || p.x < -40 || p.x > W + 40 || p.y < -40 || p.y > H + 40) {
      c.el.style.display = 'none';
      continue;
    }
    c.el.style.display = '';
    c.el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -50%)`;
  }
  for (const c of consts) {
    const active = c === state.hovered || c === state.selected;
    if (!state.showLabels && !active) {
      c.labelEl.style.display = 'none';
      continue;
    }
    horizonVec(c.center, _h);
    const p = _h.y > 0.03 ? toScreen(_h) : null;
    if (!p || p.x < 0 || p.x > W || p.y < 0 || p.y > H) {
      c.labelEl.style.display = 'none';
      continue;
    }
    c.labelEl.style.display = '';
    c.labelEl.classList.toggle('active', active);
    c.labelEl.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -50%)`;
  }
}

let lastFrame = performance.now();
let lastHeader = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;

  edgePan(dt);
  const timeMoving = easeTime(dt);
  camera.fov = state.fov;
  camera.updateProjectionMatrix();
  camera.rotation.set(state.pitch, -state.yaw, 0);
  camera.updateMatrixWorld();

  skyMatrixAt(skyTime(), state.lat, state.lon, skyMatrix);
  skyGroup.matrix.copy(skyMatrix);
  skyGroup.matrixWorldNeedsUpdate = true;

  starMaterial.uniforms.uTime.value = now / 1000;
  starMaterial.uniforms.uScale.value = Math.pow(80 / state.fov, 0.6);

  updateScreenPositions();
  if (state.pointer.inside && !state.pointer.down) setHover(pick(state.pointer.x, state.pointer.y));
  updateLabels();

  if (timeMoving || now - lastHeader > 1000) {
    lastHeader = now;
    updateHeader();
    const nowEl = state.selected && els.panelContent.querySelector('.p-now');
    if (nowEl) nowEl.innerHTML = nowLine(state.selected);
  }

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function loadData() {
  const [s, c] = await Promise.all([
    fetch('data/stars.json').then((r) => r.json()),
    fetch('data/constellations.json').then((r) => r.json()),
  ]);
  stars = s;
  consts = c;
  for (const st of stars) starByHip.set(st.hip, st);
  for (const cs of consts) constByAbbr.set(cs.abbr, cs);
  brightStars = stars.filter((st) => st.mag <= 4.2);
}

wireControls();
initLocation();
loadData()
  .then(() => {
    buildStars();
    buildConstellations();
    refreshLineStyles();
    requestAnimationFrame(frame);
  })
  .catch((err) => {
    console.error('Night Sky failed to start:', err);
    els.loc.textContent = `Failed to load star data: ${err.message}`;
  });
