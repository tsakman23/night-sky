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
  toggleVoice: $('#toggle-voice'),
  search: $('#search'),
  results: $('#search-results'),
  tourBtn: $('#tour-btn'),
  fullscreen: $('#fullscreen-btn'),
  toast: $('#toast'),
  marker: $('#marker'),
  tourCursor: $('#tour-cursor'),
  tourBar: $('#tour-bar'),
  tourProgress: $('#tour-progress'),
  tourPause: $('#tour-pause'),
  tourRestart: $('#tour-restart'),
  tourStop: $('#tour-stop'),
  voiceStatus: $('#voice-status'),
  loading: $('#loading'),
  loadingText: $('#loading-text'),
  loadingSub: $('#loading-sub'),
  locBtn: $('#location-btn'),
  locPicker: $('#loc-picker'),
  locSearch: $('#loc-search'),
  locResults: $('#loc-results'),
  locClose: $('#loc-close'),
  locMine: $('#loc-mine'),
  locNote: $('#loc-note'),
  peek: $('#peek'),
  peekName: $('#peek-name'),
  peekSub: $('#peek-sub'),
  peekStar: $('#peek-star'),
  peekOpen: $('#peek-open'),
  searchToggle: $('#search-toggle'),
  sheetHandle: $('#sheet-handle'),
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
  pitch: (matchMedia('(max-width: 720px)').matches ? 26 : 32) * DEG, // altitude the camera faces
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
  voice: true, // narrate during the tour
  anim: null, // camera slew in progress
  markStar: null, // star picked from search
  pointing: null, // { star, c, moving } while the narrator points at a star
  peek: null, // { cst, star } shown in the tap bubble on touch screens
  manualLocation: false, // the user picked a place; ignore late geolocation results
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
const renderer = new THREE.WebGLRenderer({ canvas: els.canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); // adapted at runtime (adaptResolution)
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

// Milky Way: a soft, mottled band along the real galactic plane, in the equatorial
// frame (inside skyGroup) so it rises and sets with the stars. The noise is
// expensive (10 octaves per pixel) and never changes relative to the stars, so it
// is baked once into an equirectangular texture (RA × Dec) and only sampled per frame.
const MILKY_WAY_GLSL = /* glsl */ `
  uniform vec3 uNgp;
  uniform vec3 uGc;
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
  float milkyWay(vec3 d) {
    float b = asin(clamp(dot(d, uNgp), -1.0, 1.0));              // galactic latitude
    vec3 gcPerp = normalize(uGc - dot(uGc, uNgp) * uNgp);
    float cosl = dot(normalize(d - dot(d, uNgp) * uNgp), gcPerp); // cos(galactic longitude)
    float width = 0.16 + 0.08 * (0.5 + 0.5 * cosl);
    float band = exp(-pow(b / width, 2.0));
    float core = 0.55 + 0.45 * pow(0.5 + 0.5 * cosl, 2.0);         // brighter toward Sagittarius
    float mottling = fbm(d * 7.0) * 0.9 + fbm(d * 19.0) * 0.35;
    float dust = smoothstep(0.03, 0.0, abs(b + 0.012 * sin(cosl * 9.0))) * smoothstep(0.2, 0.75, cosl);
    return band * core * mottling * (1.0 - 0.6 * dust);
  }`;

function bakeMilkyWay(width = 2048) {
  const target = new THREE.WebGLRenderTarget(width, width / 2, {
    type: THREE.HalfFloatType, // smooth faint gradients without 8-bit banding
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
    depthBuffer: false,
    wrapS: THREE.RepeatWrapping,
  });
  const material = new THREE.ShaderMaterial({
    uniforms: { uNgp: { value: eqVec(12.8572, 27.1283) }, uGc: { value: eqVec(17.7611, -28.9362) } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `${MILKY_WAY_GLSL}
      varying vec2 vUv;
      void main() {
        float ra = vUv.x * 6.28318530718;
        float dec = (vUv.y - 0.5) * 3.14159265359;
        vec3 d = vec3(cos(dec) * cos(ra), cos(dec) * sin(ra), sin(dec));
        gl_FragColor = vec4(milkyWay(d), 0.0, 0.0, 1.0);
      }`,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  const bakeScene = new THREE.Scene();
  bakeScene.add(quad);
  renderer.setRenderTarget(target);
  renderer.render(bakeScene, new THREE.Camera());
  renderer.setRenderTarget(null);
  material.dispose();
  quad.geometry.dispose();
  return target.texture;
}

const milkyWayMaterial = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  transparent: true,
  depthWrite: false,
  depthTest: false,
  blending: THREE.AdditiveBlending,
  uniforms: { uMap: { value: bakeMilkyWay() } },
  vertexShader: /* glsl */ `
    varying vec3 vEq;
    varying float vAlt;
    void main() {
      vEq = position;
      vec4 world = modelMatrix * vec4(position, 1.0);
      vAlt = normalize(world.xyz).y;
      gl_Position = projectionMatrix * viewMatrix * world;
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D uMap;
    varying vec3 vEq;
    varying float vAlt;
    void main() {
      vec3 d = normalize(vEq);
      vec2 uv = vec2(fract(atan(d.y, d.x) / 6.28318530718), asin(clamp(d.z, -1.0, 1.0)) / 3.14159265359 + 0.5);
      float v = texture2D(uMap, uv).r;
      float fade = smoothstep(0.0, 0.25, vAlt);                    // washed out near the horizon
      gl_FragColor = vec4(vec3(0.62, 0.70, 0.88) * v * 0.17 * fade, 1.0);
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
function pick(px, py, scale = 1) {
  let star = null;
  let bestStar = 10 * scale;
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
  let bestD = 12 * scale;
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
  els.time.textContent = new Intl.DateTimeFormat('en-GB', isCompact()
    ? { timeZone: state.timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }
    : { timeZone: state.timeZone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false },
  ).format(new Date(now)) + (state.manualLocation && !isCompact() ? ' (local time)' : '');
  els.loc.textContent = isCompact()
    ? state.place
    : state.locKnown ? `${state.place} · ${fmtLatLon(state.lat, state.lon)}` : `${state.place} — click to choose a location`;

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
    if (state.manualLocation) return false;
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
      if (state.manualLocation) return;
      const { latitude, longitude } = pos.coords;
      setLocation(latitude, longitude, 'Your location', true);
      const name = await reverseGeocode(latitude, longitude);
      if (name && !state.manualLocation) setLocation(latitude, longitude, name, true);
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
function setHover(result, pos = state.pointer) {
  const prev = state.hovered;
  state.hovered = result?.cst || null;
  state.hoveredStar = result?.star || null;
  if (prev !== state.hovered) refreshLineStyles();
  const key = `${state.hovered?.abbr}|${state.hoveredStar?.hip}|${pos.x}|${pos.y}`;
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
  let x = pos.x + 16;
  let y = pos.y + 16;
  if (x + tw > W - 8) x = pos.x - tw - 12;
  if (y + th > H - 8) y = pos.y - th - 12;
  x = THREE.MathUtils.clamp(x, 8, Math.max(8, W - tw - 8)); // never off-screen (narrow phones)
  y = THREE.MathUtils.clamp(y, 8, Math.max(8, H - th - 8));
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
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  lastPointerType = e.pointerType;
  interruptTour();
  cancelAnim();
  activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  els.canvas.setPointerCapture(e.pointerId);
  const p = state.pointer;
  if (activeTouches.size === 2) {
    // Second finger: pinch to zoom (and never treat this gesture as a tap).
    const [a, b] = [...activeTouches.values()];
    pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, fov0: state.fov };
    p.moved = 999;
    hidePeek();
    return;
  }
  if (activeTouches.size > 2) return;
  p.down = true;
  p.moved = 0;
  p.lastX = p.x = e.clientX;
  p.lastY = p.y = e.clientY;
  downAt = performance.now();
  els.canvas.classList.add('dragging');
}

function onPointerMove(e) {
  lastInput = performance.now();
  lastPointerType = e.pointerType;
  if (activeTouches.has(e.pointerId)) activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && activeTouches.size >= 2) {
    const [a, b] = [...activeTouches.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    state.fov = THREE.MathUtils.clamp((pinch.fov0 * pinch.d0) / d, 18, 110);
    state.userMoved = true;
    return;
  }
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
    // "Grab the sky": the point under the finger/cursor follows it.
    const radPerPx = (state.fov * DEG) / H;
    state.yaw -= dx * radPerPx;
    state.pitch = clampPitch(state.pitch + dy * radPerPx);
    state.userMoved = true;
    els.tooltip.hidden = true;
    if (p.moved > 12) hidePeek();
  }
}

function onPointerUp(e) {
  activeTouches.delete(e.pointerId);
  if (els.canvas.hasPointerCapture(e.pointerId)) els.canvas.releasePointerCapture(e.pointerId);
  const p = state.pointer;
  if (pinch) {
    if (activeTouches.size < 2) {
      pinch = null;
      const rest = [...activeTouches.values()][0];
      if (rest) { p.lastX = rest.x; p.lastY = rest.y; } // keep dragging with the remaining finger
      else { p.down = false; els.canvas.classList.remove('dragging'); }
    }
    return;
  }
  if (!p.down) return;
  p.down = false;
  els.canvas.classList.remove('dragging');
  if (e.type === 'pointercancel') return;
  const touch = e.pointerType !== 'mouse';
  const isTap = p.moved < (touch ? 12 : 5) && (!touch || performance.now() - downAt < 600);
  if (isTap && !tour.active) handleTap(e.clientX, e.clientY, touch);
}

function onWheel(e) {
  e.preventDefault();
  lastInput = performance.now();
  interruptTour();
  cancelAnim();
  state.fov = THREE.MathUtils.clamp(state.fov * Math.exp(e.deltaY * 0.0012), 18, 110);
}

function onKey(e) {
  if (e.target instanceof HTMLInputElement) return;
  lastInput = performance.now();
  const step = 4 * DEG * (state.fov / 80);
  if (e.key.startsWith('Arrow') || e.key === '+' || e.key === '=' || e.key === '-') { interruptTour(); cancelAnim(); }
  if (e.key === 'Escape') {
    if (!els.locPicker.hidden) closeLocPicker();
    else if (state.peek) hidePeek();
    else if (tour.active) stopTour();
    else closePanel();
  }
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
  state.edgePanning = false;
  if (lastPointerType !== 'mouse') return;
  if (!p.inside || p.down || (tour.active && !tour.paused) || state.anim) return;
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
  state.edgePanning = true;
  if (tour.active) tour.viewDirty = true;
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
  els.canvas.addEventListener('pointerleave', (e) => {
    if (state.pointer.down) return;
    state.pointer.inside = false;
    if (e.pointerType === 'mouse') setHover(null);
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
  const placed = []; // label boxes already drawn, brightest stars first
  const overlaps = (b) => placed.some((q) => b.x < q.x + q.w && b.x + b.w > q.x && b.y < q.y + q.h && b.y + b.h > q.y);
  named.forEach(({ s, p }, i) => {
    const hl = s.hip === highlightHip;
    dots += `<circle data-hip="${s.hip}" cx="${X(p)}" cy="${Y(p)}" r="${(rOf(s.mag) + (hl ? 1.5 : 0)).toFixed(2)}" fill="${fill(s)}"${hl ? ' stroke="#9cc0ff" stroke-width="1.5"' : ''}/>`;
    const text = i < 4 && s.name ? s.name : s.bayer && s.mag < 4.3 ? `${s.bayer}${s.bayerSup || ''}` : '';
    if (!text) return;
    const lx = p.x * scale + ox + rOf(s.mag) + 3;
    const ly = p.y * scale + oy + 3.5;
    const box = { x: lx, y: ly - 9, w: text.length * 5.8 + 2, h: 11 };
    if (overlaps(box) || box.x + box.w > Wc) return;
    placed.push(box);
    labels += `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}">${escapeHtml(text)}</text>`;
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
    return `<tr data-hip="${s.hip}" class="${s.hip === highlightHip ? 'hl' : ''}">
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
    <div class="p-actions"><button class="p-listen" type="button" data-listen hidden>▶ Listen</button></div>
    <div class="p-now ${visHtml(c).cls}">${visHtml(c).html}</div>
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
  if (!tour.active && narratingFor && narratingFor !== c) stopNarration();
  state.markStar = star;
  renderPanel(c);
  updateListenButton();
  els.panel.classList.add('open');
  document.body.classList.add('panel-open');
  state.edgeArmed = false;
  els.panel.setAttribute('aria-hidden', 'false');
  els.panel.scrollTop = 0;
  refreshLineStyles();
}

function closePanel() {
  if (!tour.active) stopNarration();
  state.markStar = null;
  state.selected = null;
  state.panelStar = null;
  els.panel.classList.remove('open');
  document.body.classList.remove('panel-open');
  state.edgeArmed = false;
  els.panel.setAttribute('aria-hidden', 'true');
  refreshLineStyles();
}

// ---------------------------------------------------------------------------
// Visibility: is it in the sky tonight, from here?
// ---------------------------------------------------------------------------
const _vm = new THREE.Matrix4();
const _vv = new THREE.Vector3();
function altAzAt(eqUnit, ms, precessed = true) {
  const M = precessed ? skyMatrixAt(ms, state.lat, state.lon, _vm) : eqToHorizon(ms, state.lat, state.lon, _vm);
  return altAz(_vv.copy(eqUnit).applyMatrix4(M));
}
function sunAltAt(ms) {
  const s = sunRaDec(ms);
  return altAzAt(eqVec(s.ra, s.dec), ms, false).alt;
}
const fmtLat = (lat) => `${Math.abs(Math.round(lat))}° ${lat >= 0 ? 'N' : 'S'}`;
const DARK_SUN = -12; // nautical twilight or darker counts as night
const GOOD_ALT = 10; // degrees up to count as comfortably visible

function visibility(c, t0 = skyTime()) {
  const lat = state.lat;
  const maxAlt = 90 - Math.abs(lat - c.decCenter);
  const minAlt = Math.abs(lat + c.decCenter) - 90;
  const now = altAzAt(c.center, t0);
  const v = { now, maxAlt, status: '', title: '', detail: '', jumpMs: null };
  const hemi = c.decCenter < 0 ? 'southern' : 'northern';

  if (maxAlt <= 0) {
    const limit = c.decCenter < 0 ? c.decCenter + 90 : c.decCenter - 90;
    v.status = 'never';
    v.title = `Never rises from ${fmtLat(lat)}`;
    v.detail = `${c.name} lies in the far ${hemi} sky. You'd need to be ${c.decCenter < 0 ? 'south' : 'north'} of about ${fmtLat(limit)} to see it.`;
    return v;
  }

  // Scan the next 24 h in 10-minute steps for the dark window and the figure's altitude.
  const threshold = Math.min(GOOD_ALT, maxAlt - 2);
  const step = 10 * 60000;
  let darkStart = null, darkEnd = null, visStart = null, visEnd = null, peak = null;
  for (let i = 0; i <= 144; i++) {
    const t = t0 + i * step;
    const dark = sunAltAt(t) < DARK_SUN;
    if (darkStart === null) {
      if (dark) darkStart = t;
      else continue;
    }
    if (!dark) { darkEnd = t; break; }
    const a = i === 0 ? now.alt : altAzAt(c.center, t).alt;
    if (a > threshold) {
      if (visStart === null) visStart = t;
      visEnd = t;
      if (!peak || a > peak.alt) peak = { t, alt: a, az: altAzAt(c.center, t).az };
    } else if (visStart !== null && visEnd !== null && visEnd < t - step / 2) {
      break; // first visible stretch has ended
    }
  }
  const circ = minAlt > 0 ? ` From here it never sets.` : '';
  const sunNow = sunAltAt(t0);
  const darkNow = sunNow < DARK_SUN;

  if (darkNow && now.alt > 0) {
    v.status = 'up';
    v.title = `Up now — ${Math.round(now.alt)}° above the horizon, toward the ${COMPASS_WORDS[compass(now.az)]}`;
    const parts = [];
    if (peak && peak.t > t0 + 20 * 60000 && peak.alt > now.alt + 3) parts.push(`It climbs to ${Math.round(peak.alt)}° around ${fmtClock(peak.t)}.`);
    if (visEnd && (!darkEnd || visEnd < darkEnd - step)) parts.push(`Visible until about ${fmtClock(visEnd)}.`);
    else if (darkEnd) parts.push(`Visible until dawn (${fmtClock(darkEnd)}).`);
    v.detail = parts.join(' ') + circ;
    return v;
  }
  if (visStart !== null) {
    v.status = 'later';
    const when = fmtClock(visStart);
    v.title = darkNow ? `Below the horizon now — rises into view at ${when}` : `Visible tonight from ${when}`;
    v.detail = `Up from ${when} to ${fmtClock(visEnd)}, highest around ${fmtClock(peak.t)} (${Math.round(peak.alt)}° toward the ${COMPASS_WORDS[compass(peak.az)]}).${circ}`;
    v.jumpMs = peak.t;
    if (!darkNow && now.alt > 0) v.title = `Above the horizon, but it's still light — best tonight from ${when}`;
    return v;
  }
  v.status = 'not-tonight';
  v.title = now.alt > 0 ? 'Up only in daylight at this time of year' : `Not in tonight's dark sky`;
  v.detail = `From ${fmtLat(lat)} ${c.name} is ${now.alt > 0 ? 'above the horizon now, but the Sun is up' : 'up during daylight'} this time of year. Best seen on evenings in ${bestMonth(c.raCenter)}.${circ}`;
  return v;
}

function visHtml(c) {
  const v = visibility(c);
  let jump = '';
  if (v.jumpMs) {
    const offset = Math.round(state.offsetMin + (v.jumpMs - skyTime()) / 60000);
    if (Math.abs(offset) <= 720) jump = `<button class="p-jump" type="button" data-jump="${offset}">Show me at ${fmtClock(v.jumpMs)}</button>`;
  }
  return { cls: v.status, html: `<div class="v-title">${escapeHtml(v.title)}</div>${v.detail ? `<div class="v-detail">${escapeHtml(v.detail)}</div>` : ''}${jump}` };
}

function refreshVisBox() {
  const box = state.selected && els.panelContent.querySelector('.p-now');
  if (!box) return;
  const { cls, html } = visHtml(state.selected);
  box.className = `p-now ${cls}`;
  if (box.innerHTML !== html) box.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Camera slews (search, tour)
// ---------------------------------------------------------------------------
const easeInOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function slewTo(c, { ms = skyTime(), panel = true, dur = 1700 } = {}) {
  const { alt, az } = altAzAt(c.center, ms);
  const extent = Math.max(...c.figure.map((s) => s.vec.angleTo(c.center))) / DEG;
  let fov = THREE.MathUtils.clamp(extent * 2.7, 38, 95);
  let pitch = THREE.MathUtils.clamp(alt < 0 ? 12 : alt, -5, 80) * DEG;
  let yaw = az * DEG;
  if (panel && isCompact()) {
    // Bottom sheet covers ~58% of a phone screen: fit the figure into the strip above it.
    const visible = Math.max(0.3, 1 - 0.58);
    fov = THREE.MathUtils.clamp((extent * 2.5) / visible, 50, 110);
    const f = H / 2 / Math.tan((fov * DEG) / 2);
    pitch = clampPitch(pitch - Math.atan((H * 0.58) / 2 / f));
  } else if (panel && W > 900) {
    // Keep the figure centred in the part of the sky the panel doesn't cover.
    const panelW = Math.min(400, W);
    const f = H / 2 / Math.tan((fov * DEG) / 2);
    yaw += Math.atan(panelW / 2 / f) / Math.max(Math.cos(pitch), 0.35);
  }
  state.anim = {
    elapsed: 0,
    last: performance.now(),
    dur,
    from: { yaw: state.yaw, pitch: state.pitch, fov: state.fov },
    to: { yaw: state.yaw + wrapAngle(yaw - state.yaw), pitch, fov },
  };
  state.userMoved = true;
  return new Promise((resolve) => { state.anim.done = resolve; });
}

function stepAnim(now) {
  const a = state.anim;
  if (!a) return;
  if (!tour.paused) a.elapsed += now - a.last; // a paused tour freezes mid-slew
  a.last = now;
  const k = Math.min(1, a.elapsed / a.dur);
  const e = easeInOut(k);
  state.yaw = a.from.yaw + (a.to.yaw - a.from.yaw) * e;
  state.pitch = a.from.pitch + (a.to.pitch - a.from.pitch) * e;
  state.fov = a.from.fov + (a.to.fov - a.from.fov) * e;
  if (k >= 1) {
    state.anim = null;
    a.done?.();
  }
}

function cancelAnim() {
  if (!state.anim) return;
  const done = state.anim.done;
  state.anim = null;
  done?.();
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
let toastTimer = 0;
function showToast(html, ms = 7000) {
  els.toast.innerHTML = html;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, ms);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
const norm = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
let searchIndex = [];
let searchResults = [];
let searchActive = -1;

function buildSearchIndex() {
  searchIndex = consts.map((c) => ({
    type: 'con', c, s: null, label: c.name,
    sub: meaningOf(c) ? `The ${meaningOf(c)} · constellation` : 'Constellation',
    keys: [c.name, c.abbr, c.meaning, c.genitive].filter(Boolean).map(norm),
  }));
  for (const s of stars) {
    const c = constByAbbr.get(s.con);
    if (!s.name || !c) continue;
    searchIndex.push({ type: 'star', c, s, label: s.name, sub: `Star in ${c.name} · mag ${fmtMag(s.mag)}`, keys: [norm(s.name)] });
  }
}

function runSearch(q) {
  const nq = norm(q.trim());
  if (!nq) return [];
  const scored = [];
  for (const e of searchIndex) {
    let best = 9;
    for (const k of e.keys) {
      if (k === nq) best = Math.min(best, 0);
      else if (k.startsWith(nq)) best = Math.min(best, 1);
      else if (k.split(/[\s-]+/).some((w) => w.startsWith(nq))) best = Math.min(best, 2);
      else if (nq.length > 2 && k.includes(nq)) best = Math.min(best, 3);
    }
    if (best < 9) scored.push({ e, score: best + (e.type === 'star' ? 0.5 : 0) + (e.s ? e.s.mag * 0.01 : 0) });
  }
  return scored.sort((a, b) => a.score - b.score || a.e.label.localeCompare(b.e.label)).slice(0, 8).map((x) => x.e);
}

function quickChip(c) {
  const maxAlt = 90 - Math.abs(state.lat - c.decCenter);
  if (maxAlt <= 0) return '<span class="chip never">Never visible here</span>';
  const { alt } = altAzAt(c.center, skyTime());
  const dark = sunAltAt(skyTime()) < DARK_SUN;
  if (alt > 0 && dark) return '<span class="chip up">Up now</span>';
  if (alt > 0) return '<span class="chip down">Up, sky light</span>';
  return '<span class="chip down">Below horizon</span>';
}

function highlight(label, q) {
  const i = norm(label).indexOf(norm(q.trim()));
  if (i < 0 || !q.trim()) return escapeHtml(label);
  const n = q.trim().length;
  return `${escapeHtml(label.slice(0, i))}<mark>${escapeHtml(label.slice(i, i + n))}</mark>${escapeHtml(label.slice(i + n))}`;
}

function renderResults() {
  const q = els.search.value;
  if (!q.trim()) { els.results.hidden = true; return; }
  if (!searchResults.length) {
    els.results.innerHTML = `<li class="r-empty">No constellation or named star matches “${escapeHtml(q)}”.</li>`;
  } else {
    els.results.innerHTML = searchResults.map((e, i) => `
      <li role="option" data-i="${i}" class="${i === searchActive ? 'active' : ''}" aria-selected="${i === searchActive}">
        <div class="r-main"><div class="r-name">${highlight(e.label, q)}</div><div class="r-sub">${escapeHtml(e.sub)}</div></div>
        ${quickChip(e.c)}
      </li>`).join('');
  }
  els.results.hidden = false;
}

function chooseResult(e) {
  if (!e) return;
  els.search.value = e.label;
  els.results.hidden = true;
  els.search.blur();
  document.body.classList.remove('searching');
  stopTour();
  focusOn(e.c, e.s);
}

function focusOn(c, star = null) {
  const v = visibility(c);
  state.markStar = star;
  openPanel(c, star);
  // The panel's visibility box explains anything that isn't up right now.
  if (v.status === 'never') return;
  slewTo(c, { panel: true });
}

function wireSearch() {
  els.search.addEventListener('input', () => {
    searchResults = runSearch(els.search.value);
    searchActive = searchResults.length ? 0 : -1;
    renderResults();
  });
  els.search.addEventListener('focus', () => {
    stopTour();
    if (els.search.value.trim()) { searchResults = runSearch(els.search.value); renderResults(); }
  });
  els.search.addEventListener('blur', () => setTimeout(() => { els.results.hidden = true; document.body.classList.remove('searching'); }, 150));
  els.search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!searchResults.length) return;
      searchActive = (searchActive + (e.key === 'ArrowDown' ? 1 : -1) + searchResults.length) % searchResults.length;
      renderResults();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      chooseResult(searchResults[Math.max(0, searchActive)]);
    } else if (e.key === 'Escape') {
      els.search.value = '';
      els.results.hidden = true;
      els.search.blur();
    }
  });
  els.results.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-i]');
    if (!li) return;
    e.preventDefault();
    chooseResult(searchResults[Number(li.dataset.i)]);
  });
}

// ---------------------------------------------------------------------------
// Full screen (the interface fades out while you're not moving)
// ---------------------------------------------------------------------------
let idleTimer = 0;
const isFullscreen = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
function toggleFullscreen() {
  const root = document.documentElement;
  if (!isFullscreen()) (root.requestFullscreen || root.webkitRequestFullscreen)?.call(root);
  else (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
}
function wakeUi() {
  document.body.classList.remove('ui-idle');
  clearTimeout(idleTimer);
  if (isFullscreen()) {
    idleTimer = setTimeout(() => {
      if (document.activeElement !== els.search) document.body.classList.add('ui-idle');
    }, 2600);
  }
}
function wireFullscreen() {
  els.fullscreen.addEventListener('click', toggleFullscreen);
  const onChange = () => {
    const fs = isFullscreen();
    document.body.classList.toggle('is-fullscreen', fs);
    els.fullscreen.classList.toggle('on', fs);
    els.fullscreen.title = fs ? 'Exit full screen (F)' : 'Full screen (F)';
    wakeUi();
  };
  document.addEventListener('fullscreenchange', onChange);
  document.addEventListener('webkitfullscreenchange', onChange);
  window.addEventListener('pointermove', wakeUi, { passive: true });
  window.addEventListener('keydown', wakeUi);
}

// ---------------------------------------------------------------------------
// Narration (in-browser Kokoro voice via speech.js, loaded on demand)
// ---------------------------------------------------------------------------
let speech = null;
let speechInfo = {};
let narratingFor = null;
import('./speech.js')
  .then((m) => {
    speech = m.speech;
    speech.onchange = (st, info = {}) => {
      speechInfo = { st, ...info };
      updateListenButton();
      updateVoiceStatus();
    };
    updateListenButton();
    maybePreloadVoice();
  })
  .catch((err) => console.warn('Narration unavailable:', err));

// Load the voice as soon as the sky is up, in idle time, so Listen and the tour start at once.
// Skipped on Save-Data / 2G connections (first use downloads the model: ~310 MB on WebGPU).
let skyReady = false;
let voiceStatusTimer = 0;
function maybePreloadVoice() {
  if (!speech || !skyReady || speech.state !== 'idle') return;
  const conn = navigator.connection;
  if (conn?.saveData || /2g$/.test(conn?.effectiveType || '')) {
    els.voiceStatus.textContent = 'loads on first use';
    return;
  }
  const start = () => speech.preload();
  if ('requestIdleCallback' in window) requestIdleCallback(start, { timeout: 2000 });
  else setTimeout(start, 500);
}

function updateVoiceStatus() {
  const el = els.voiceStatus;
  clearTimeout(voiceStatusTimer);
  el.classList.remove('fade');
  if (!speech) return;
  if (speech.state === 'loading') {
    const pct = speechInfo.progress != null && speechInfo.progress > 0 ? ` ${Math.round(speechInfo.progress * 100)}%` : '…';
    el.textContent = /warming/i.test(speechInfo.message || '') ? 'warming up…' : `loading${pct}`;
  } else if (speech.state === 'error') {
    el.textContent = 'unavailable';
  } else if (speech.engine === 'webspeech') {
    el.textContent = 'browser voice';
  } else if (speech.engine === 'kokoro' && speech.state === 'ready') {
    el.textContent = 'ready';
    voiceStatusTimer = setTimeout(() => el.classList.add('fade'), 2500);
  }
}

const GREEK_NAMES = {
  α: 'Alpha', β: 'Beta', γ: 'Gamma', δ: 'Delta', ε: 'Epsilon', ζ: 'Zeta', η: 'Eta', θ: 'Theta', ι: 'Iota',
  κ: 'Kappa', λ: 'Lambda', μ: 'Mu', ν: 'Nu', ξ: 'Xi', ο: 'Omicron', π: 'Pi', ρ: 'Rho', σ: 'Sigma', τ: 'Tau',
  υ: 'Upsilon', φ: 'Phi', χ: 'Chi', ψ: 'Psi', ω: 'Omega',
};
const aOrAn = (w) => (/^[aeiou]/i.test(w) ? `an ${w}` : `a ${w}`);
function spokenStar(s, c) {
  if (s.name) return s.name;
  if (s.bayer && GREEK_NAMES[s.bayer]) return `${GREEK_NAMES[s.bayer]} ${c.genitive || c.name}`;
  return designation(s, c);
}
function spokenDistance(ly) {
  const r = ly < 100 ? Math.round(ly) : ly < 1000 ? Math.round(ly / 10) * 10 : Math.round(ly / 100) * 100;
  return `${r.toLocaleString('en-US')} light-years`;
}
const spokenClock = (ms) => new Intl.DateTimeFormat('en-US', { timeZone: state.timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
function kindPhrase(s) {
  const k = starKind(s.spect);
  return /[a-z]/.test(k) && !/[0-9]/.test(k) ? aOrAn(k.toLowerCase()) : 'a star';
}
function cleanSummary(text, maxSentences) {
  const t = String(text || '').replace(/\s*\([^()]*\)/g, '').replace(/\s*\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
  const sentences = t.split(/(?<=[.!?])\s+(?=[A-Z])/);
  return sentences.slice(0, maxSentences).join(' ');
}

// Builds the narration text and records where each star is named, so the cursor can
// point at it just before the voice says it.
function narration(c) {
  let text = '';
  const marks = [];
  const say = (...pieces) => {
    if (text) text += ' ';
    for (const p of pieces) {
      if (typeof p === 'string') text += p;
      else { marks.push({ index: text.length, star: p.star }); text += p.label; }
    }
  };
  const starRef = (s) => ({ star: s, label: spokenStar(s, c) });

  const m = meaningOf(c);
  say(`${c.name}${m ? `, the ${m}` : ''}.`);
  const v = visibility(c);
  if (v.status === 'up') say(`Right now it is ${Math.round(v.now.alt)} degrees above the horizon, toward the ${COMPASS_WORDS[compass(v.now.az)]}.`);
  else if (v.status === 'later') say(`It's not up yet. Look for it from about ${spokenClock(v.jumpMs)} tonight.`);
  else if (v.status === 'never') say(`From where you are, it never rises above the horizon. It lies in the far ${c.decCenter < 0 ? 'southern' : 'northern'} sky.`);
  else say(`It isn't in tonight's dark sky from where you are.`);

  const fig = c.figure.slice().sort((a, b) => a.mag - b.mag);
  const brightest = starByHip.get(c.brightest) || fig[0];
  if (brightest) {
    say('Its brightest star is ', starRef(brightest), `, ${kindPhrase(brightest)}${brightest.dist ? ` about ${spokenDistance(brightest.dist)} away` : ''}.`);
  }
  const second = fig.find((s) => s !== brightest && s.name);
  if (second) say('Look also for ', starRef(second), `, ${kindPhrase(second)}.`);

  const about = cleanSummary(c.summary, 3);
  if (about) {
    const at = text.length + 1;
    say(about);
    // Figure stars the Wikipedia text happens to name get pointed at too.
    for (const s of c.figure) {
      if (!s.name || s.name.length < 4) continue;
      const re = new RegExp(`\\b${s.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
      for (const hit of about.matchAll(re)) marks.push({ index: at + hit.index, star: s });
    }
  }
  say(`${c.name} is best seen on evenings in ${bestMonth(c.raCenter)}.`);
  marks.sort((a, b) => a.index - b.index);
  return { text, marks };
}

function updateListenButton() {
  const b = els.panelContent.querySelector('[data-listen]');
  if (!b) return;
  if (!speech) { b.hidden = true; return; }
  b.hidden = false;
  const mine = narratingFor && narratingFor === state.selected;
  b.classList.toggle('busy', mine && speech.state === 'loading');
  if (mine && speech.state === 'loading') {
    const pct = speechInfo.progress != null ? ` ${Math.round(speechInfo.progress * 100)}%` : '';
    b.textContent = `Loading voice${pct}…`;
  } else if (mine && speech.speaking) b.textContent = '■ Stop';
  else b.textContent = '▶ Listen';
}

const narr = { token: 0 };

async function narrate(c) {
  if (!speech) return;
  if (narratingFor === c && (speech.speaking || speech.state === 'loading')) {
    speech.stop();
    narratingFor = null;
    endPointing();
    updateListenButton();
    return;
  }
  speech.stop();
  narratingFor = c;
  const token = ++narr.token;
  const { text, marks } = narration(c);
  const cues = marks.map((m) => ({ index: m.index, lead: 0.65, fn: () => pointAtStar(m.star, c, token) }));
  updateListenButton();
  try {
    await speech.speak(text, { cues }); // called synchronously in the click: allowed to start audio
  } catch (err) {
    console.warn('Narration failed:', err);
    showToast('Sorry — the narration voice could not play.');
  }
  if (token === narr.token) endPointing();
  if (narratingFor === c) narratingFor = null;
  updateListenButton();
}

function stopNarration() {
  if (speech && (speech.speaking || narratingFor)) speech.stop();
  narratingFor = null;
  narr.token++;
  endPointing();
}

// --- pointing at stars while they are named ---------------------------------
function highlightStarInPanel(hip) {
  for (const el of els.panelContent.querySelectorAll('[data-hip].speaking')) el.classList.remove('speaking');
  if (hip == null) return;
  for (const el of els.panelContent.querySelectorAll(`[data-hip="${hip}"]`)) el.classList.add('speaking');
}

function starOnScreen(star) {
  horizonVec(star.vec, _h);
  if (_h.y <= 0) return null;
  const p = toScreen(_h);
  const open = els.panel.classList.contains('open');
  const right = open && !isCompact() ? els.panel.getBoundingClientRect().left : W;
  const bottom = open && isCompact() ? sheetTop() : H;
  return p && p.x > 8 && p.x < right - 8 && p.y > 8 && p.y < bottom - 8 ? p : null;
}

function pointAtStar(star, c, token) {
  if (token !== narr.token || state.selected !== c) return;
  highlightStarInPanel(star.hip);
  const p = starOnScreen(star);
  if (!p) return; // below the horizon or out of view: the panel highlight still shows it
  if (els.tourCursor.hidden) {
    // The narrator's pointer comes in from the panel, next to the Listen button.
    const b = els.panelContent.querySelector('[data-listen]')?.getBoundingClientRect();
    const left = els.panel.classList.contains('open') ? els.panel.getBoundingClientRect().left : W;
    tour.cursor = isCompact() ? { x: W / 2, y: sheetTop() - 30 } : { x: left - 36, y: b ? b.top + b.height / 2 : H * 0.3 };
    placeTourCursor();
    els.tourCursor.hidden = false;
  }
  state.pointing = { star, c, moving: true };
  const alive = () => token === narr.token;
  moveTourCursor({ x: p.x - 4, y: p.y - 2 }, 600, alive).then(() => {
    if (!alive() || state.pointing?.star !== star) return;
    state.pointing.moving = false;
    state.markStar = star;
  });
}

// Keep the pointer and its tooltip on the star while it's being talked about.
function followPointing(now) {
  const pt = state.pointing;
  if (!pt || pt.moving) return;
  const p = starOnScreen(pt.star);
  // If the view is moved so the star leaves the screen, hide the pointer until it's back.
  els.tourCursor.hidden = !p;
  if (!p) return;
  tour.cursor = { x: p.x - 4, y: p.y - 2 };
  placeTourCursor();
  const userHovering = state.pointer.inside && now - lastInput < 1500;
  if (!userHovering) setHover({ cst: pt.c, star: pt.star }, tour.cursor);
}

function endPointing() {
  if (!state.pointing && !els.panelContent.querySelector('.speaking')) return;
  state.pointing = null;
  state.markStar = null;
  highlightStarInPanel(null);
  if (!tour.active) {
    els.tourCursor.hidden = true;
    setHover(null);
  }
}

// ---------------------------------------------------------------------------
// Planetarium tour
// ---------------------------------------------------------------------------
const tour = {
  active: false, paused: false, token: 0, cursor: { x: 0, y: 0 },
  stops: [], index: 0, current: null, phase: '', viewDirty: false,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Waits that only count time while the tour is running (not paused).
async function gate(alive) { while (alive() && tour.paused) await sleep(80); }
async function pwait(ms, alive) {
  let left = ms;
  while (alive() && left > 0) {
    await sleep(80);
    if (!tour.paused) left -= 80;
  }
}
// After a pause: if the user looked around, fly back to the current stop first.
async function settle(c, alive) {
  await gate(alive);
  if (!alive() || !tour.viewDirty) return false;
  tour.viewDirty = false;
  await slewTo(c, { panel: true, dur: 1000 });
  await gate(alive);
  return true;
}

function placeTourCursor() {
  els.tourCursor.style.transform = `translate(${tour.cursor.x.toFixed(1)}px, ${tour.cursor.y.toFixed(1)}px)`;
}

function moveTourCursor(target, dur, alive) {
  const from = { ...tour.cursor };
  // a gentle arc rather than a straight line
  const mid = { x: (from.x + target.x) / 2 + (target.y - from.y) * 0.15, y: (from.y + target.y) / 2 - (target.x - from.x) * 0.15 };
  let elapsed = 0;
  let last = performance.now();
  return new Promise((resolve) => {
    const tick = (now) => {
      if (!alive()) return resolve();
      if (!tour.paused) elapsed += now - last; // the glide freezes while paused
      last = now;
      const k = easeInOut(Math.min(1, elapsed / dur));
      const u = 1 - k;
      tour.cursor.x = u * u * from.x + 2 * u * k * mid.x + k * k * target.x;
      tour.cursor.y = u * u * from.y + 2 * u * k * mid.y + k * k * target.y;
      placeTourCursor();
      if (k < 1) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
}

function figureScreenCentre(c) {
  horizonVec(c.center, _h);
  return toScreen(_h);
}

async function pointCursorAtFigure(c, dur, alive) {
  const target = figureScreenCentre(c);
  if (target) await moveTourCursor({ x: target.x - 4, y: target.y - 2 }, dur, alive);
}

function tourStops() {
  const t = skyTime();
  const prominence = (c) => c.figure.reduce((sum, s) => sum + Math.pow(10, -0.4 * s.mag), 0);
  const up = consts
    .map((c) => ({ c, h: altAzAt(c.center, t) }))
    .filter((o) => o.h.alt > 18)
    .sort((a, b) => prominence(b.c) - prominence(a.c))
    .slice(0, 8);
  // Sweep around the sky starting from where you're looking.
  const yawDeg = ((state.yaw / DEG) % 360 + 360) % 360;
  const rel = (az) => (((az - yawDeg + 30) % 360) + 360) % 360;
  return up.sort((a, b) => rel(a.h.az) - rel(b.h.az)).map((o) => o.c);
}

async function startTour() {
  if (tour.active) { stopTour(); return; }
  const stops = tourStops();
  if (!stops.length) {
    showToast('No constellations are high enough in your sky right now for a tour.');
    return;
  }
  Object.assign(tour, { active: true, paused: false, stops, index: 0, current: null, phase: '', viewDirty: false });
  const token = ++tour.token;
  const alive = () => token === tour.token;
  document.body.classList.add('touring');
  els.tourBtn.textContent = isCompact() ? '■ Stop' : '■ Stop tour';
  els.tourBtn.classList.add('on');
  els.results.hidden = true;
  closePanel();
  setHover(null);
  const voiceOn = () => state.voice && speech;
  if (voiceOn()) speech.preload?.();
  tour.cursor = { x: W * 0.5, y: H * 0.62 };
  placeTourCursor();
  els.tourCursor.hidden = false;
  updateTourBar();
  showToast(`<strong>Tour:</strong> ${stops.length} constellations in your sky right now. Space pauses · Esc stops.`, 5000);

  for (let i = 0; i < stops.length; i++) {
    const c = stops[i];
    Object.assign(tour, { index: i, current: c, phase: 'slew' });
    updateTourBar();
    await gate(alive);
    if (!alive()) return;
    tour.viewDirty = false;
    await slewTo(c, { panel: true, dur: 2600 });
    await settle(c, alive);
    if (!alive()) return;

    tour.phase = 'point';
    await pointCursorAtFigure(c, 1200, alive);
    if (await settle(c, alive)) await pointCursorAtFigure(c, 500, alive);
    if (!alive()) return;
    setHover({ cst: c, star: null }, tour.cursor);
    await pwait(1300, alive);
    if (await settle(c, alive)) await pointCursorAtFigure(c, 500, alive);
    if (!alive()) return;

    els.tourCursor.classList.remove('click');
    void els.tourCursor.offsetWidth;
    els.tourCursor.classList.add('click');
    setHover(null);
    openPanel(c);
    tour.phase = 'narrate';
    if (voiceOn()) {
      await narrate(c);
      if (!alive()) return;
      await pwait(900, alive);
    } else {
      await pwait(8000, alive);
    }
  }
  if (alive()) {
    stopTour();
    showToast('That’s the end of the tour. Clear skies!', 5000);
  }
}

function pauseTour() {
  if (!tour.active || tour.paused) return;
  tour.paused = true;
  speech?.pause?.();
  updateTourBar();
}

function resumeTour() {
  if (!tour.active || !tour.paused) return;
  tour.paused = false;
  speech?.resume?.();
  // Mid-narration and the user looked away: fly back while the voice carries on.
  if (tour.phase === 'narrate' && tour.viewDirty && tour.current) {
    tour.viewDirty = false;
    slewTo(tour.current, { panel: true, dur: 1000 });
  }
  updateTourBar();
}

const toggleTourPause = () => (tour.paused ? resumeTour() : pauseTour());
function restartTour() {
  stopTour();
  startTour();
}

// User input during a tour pauses it (so you can look around) instead of ending it.
function interruptTour() {
  if (!tour.active) return;
  pauseTour();
  tour.viewDirty = true;
}

function stopTour() {
  if (!tour.active) return;
  tour.active = false;
  tour.paused = false;
  tour.token++;
  stopNarration();
  cancelAnim();
  els.tourCursor.hidden = true;
  document.body.classList.remove('touring');
  els.tourBtn.textContent = '▶ Tour';
  els.tourBtn.classList.remove('on');
  setHover(null);
  updateListenButton();
  updateTourBar();
}

const ICON_PAUSE = '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="5" y="4" width="3.4" height="12" rx="1"/><rect x="11.6" y="4" width="3.4" height="12" rx="1"/></svg>';
const ICON_PLAY = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 4.2v11.6a.8.8 0 0 0 1.2.7l9.3-5.8a.8.8 0 0 0 0-1.4L7.2 3.5A.8.8 0 0 0 6 4.2z"/></svg>';
function updateTourBar() {
  els.tourBar.hidden = !tour.active;
  if (!tour.active) return;
  els.tourBar.classList.toggle('paused', tour.paused);
  els.tourProgress.textContent = `${tour.index + 1} / ${tour.stops.length}${tour.current ? ` · ${tour.current.name}` : ''}`;
  els.tourPause.innerHTML = tour.paused ? `${ICON_PLAY}<span>Resume</span>` : `${ICON_PAUSE}<span>Pause</span>`;
  els.tourPause.title = tour.paused ? 'Resume (Space)' : 'Pause (Space)';
}

function wireExtras() {
  wireSearch();
  wireFullscreen();
  els.tourBtn.addEventListener('click', () => {
    if (!tour.active && state.voice) speech?.unlock?.('Starting the tour.'); // inside the tap: unlocks speech on iOS
    startTour();
  });
  els.tourPause.addEventListener('click', toggleTourPause);
  els.tourRestart.addEventListener('click', restartTour);
  els.tourStop.addEventListener('click', stopTour);
  els.toggleVoice.addEventListener('change', () => {
    state.voice = els.toggleVoice.checked;
    if (!state.voice && tour.active) stopNarration();
  });
  els.toast.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tonight]');
    if (!b) return;
    setTimeTarget(Number(b.dataset.tonight));
    els.toast.hidden = true;
  });
  els.panelContent.addEventListener('click', (e) => {
    if (e.target.closest('[data-listen]') && state.selected) narrate(state.selected);
    const jump = e.target.closest('[data-jump]');
    if (jump && state.selected) {
      const c = state.selected;
      setTimeTarget(Number(jump.dataset.jump));
      slewTo(c, { ms: Date.now() + Number(jump.dataset.jump) * 60000, panel: true, dur: 2200 });
    }
  });
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === '/') { e.preventDefault(); els.search.focus(); els.search.select(); }
    else if (e.key === ' ' && tour.active) { e.preventDefault(); toggleTourPause(); }
    else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
  });
}

// Marker ring on a star picked from search.
function updateMarker() {
  const s = state.markStar;
  if (!s || !state.selected) { els.marker.hidden = true; return; }
  horizonVec(s.vec, _h);
  const p = _h.y > 0 ? toScreen(_h) : null;
  if (!p) { els.marker.hidden = true; return; }
  els.marker.hidden = false;
  els.marker.style.setProperty('--t', `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`);
}

// ---------------------------------------------------------------------------
// Touch, phones and small screens
// ---------------------------------------------------------------------------
const mqCompact = matchMedia('(max-width: 720px)');
const isCompact = () => mqCompact.matches;
let lastPointerType = matchMedia('(hover: none)').matches ? 'touch' : 'mouse';
const activeTouches = new Map(); // pointerId -> { x, y }
let pinch = null; // { d0, fov0 } while two fingers are down
let downAt = 0;

const sheetTop = () => (els.panel.classList.contains('open') ? els.panel.getBoundingClientRect().top : H);

// Tap bubble: on touch screens the first tap names a constellation, the second opens it.
function showPeek(hit, x, y) {
  state.peek = hit;
  state.hovered = hit.cst;
  refreshLineStyles();
  els.peekName.textContent = hit.cst.name;
  els.peekSub.textContent = meaningOf(hit.cst) ? `The ${meaningOf(hit.cst)}` : '';
  els.peekStar.textContent = hit.star ? `★ ${hit.star.name || designation(hit.star, hit.cst)} · mag ${fmtMag(hit.star.mag)}` : '';
  els.peek.hidden = false;
  const bw = els.peek.offsetWidth;
  const bh = els.peek.offsetHeight;
  const left = THREE.MathUtils.clamp(x - bw / 2, 12, W - bw - 12);
  let top = y - bh - 26; // above the finger, so it isn't hidden under it
  if (top < 70) top = y + 30;
  els.peek.style.left = `${left}px`;
  els.peek.style.top = `${top}px`;
}

function hidePeek() {
  if (!state.peek) return;
  state.peek = null;
  els.peek.hidden = true;
  if (lastPointerType !== 'mouse') {
    state.hovered = null;
    refreshLineStyles();
  }
}

function handleTap(x, y, touch) {
  updateScreenPositions();
  const hit = pick(x, y, touch ? 2.2 : 1);
  if (!touch) {
    if (hit.cst) openPanel(hit.cst, hit.star);
    else closePanel();
    return;
  }
  if (!hit.cst) {
    hidePeek();
    closePanel();
    return;
  }
  const again = state.peek && state.peek.cst === hit.cst;
  if (again || els.panel.classList.contains('open')) {
    hidePeek();
    openFromTap(hit.cst, hit.star, y);
    return;
  }
  showPeek(hit, x, y);
}

// Opening the sheet covers the lower part of a phone screen: lift the figure into view.
function openFromTap(c, star, tapY) {
  openPanel(c, star);
  if (isCompact() && tapY > H * 0.36) slewTo(c, { panel: true, dur: 700 });
}

// Bottom sheet: drag the handle down to close, up to expand; tap it to toggle.
function wireSheet() {
  let startY = 0;
  let dy = 0;
  let dragging = false;
  els.sheetHandle.addEventListener('pointerdown', (e) => {
    dragging = true;
    startY = e.clientY;
    dy = 0;
    els.sheetHandle.setPointerCapture(e.pointerId);
    els.panel.classList.add('dragging');
  });
  els.sheetHandle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dy = e.clientY - startY;
    els.panel.style.transform = dy > 0 ? `translateY(${dy}px)` : '';
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    els.panel.classList.remove('dragging');
    els.panel.style.transform = '';
    if (Math.abs(dy) < 6) els.panel.classList.toggle('expanded');
    else if (dy > 90) closePanel();
    else if (dy < -40) els.panel.classList.add('expanded');
    else if (dy > 30) els.panel.classList.remove('expanded');
  };
  els.sheetHandle.addEventListener('pointerup', end);
  els.sheetHandle.addEventListener('pointercancel', end);
}

function wireMobile() {
  wireSheet();
  els.peekOpen.addEventListener('click', () => {
    const p = state.peek;
    if (!p) return;
    hidePeek();
    const s = p.star ? starOnScreen(p.star) : figureScreenCentre(p.cst);
    openFromTap(p.cst, p.star, s ? s.y : H);
  });
  els.searchToggle.addEventListener('click', () => {
    document.body.classList.add('searching');
    els.search.focus();
  });
  const fsOk = document.fullscreenEnabled || document.webkitFullscreenEnabled;
  if (!fsOk) els.fullscreen.hidden = true; // e.g. iPhone Safari: use "Add to Home Screen" instead
  mqCompact.addEventListener('change', () => {
    updateHeader();
    if (!isCompact()) els.panel.classList.remove('expanded');
  });
}

// ---------------------------------------------------------------------------
// Loading screen
// ---------------------------------------------------------------------------
let loadingShownAt = 0;
function showLoading(text, sub = '') {
  els.loadingText.textContent = text;
  els.loadingSub.textContent = sub;
  els.loading.hidden = false;
  els.loading.classList.remove('hide');
  loadingShownAt = performance.now();
}
async function hideLoading(minMs = 0) {
  const left = minMs - (performance.now() - loadingShownAt);
  if (left > 0) await sleep(left);
  // wait for a rendered frame of the new sky before revealing it
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  els.loading.classList.add('hide');
  setTimeout(() => { if (els.loading.classList.contains('hide')) els.loading.hidden = true; }, 650);
}

// ---------------------------------------------------------------------------
// Location picker: see the sky from anywhere
// ---------------------------------------------------------------------------
const SUGGESTED_PLACES = [
  { name: 'Sydney', region: 'Australia', lat: -33.8688, lon: 151.2093, tz: 'Australia/Sydney' },
  { name: 'Atacama Desert', region: 'San Pedro de Atacama, Chile', lat: -22.9087, lon: -68.1997, tz: 'America/Santiago' },
  { name: 'Cape Town', region: 'South Africa', lat: -33.9249, lon: 18.4241, tz: 'Africa/Johannesburg' },
  { name: 'Quito', region: 'Ecuador · on the equator', lat: -0.1807, lon: -78.4678, tz: 'America/Guayaquil' },
  { name: 'Reykjavík', region: 'Iceland', lat: 64.1466, lon: -21.9426, tz: 'Atlantic/Reykjavik' },
  { name: 'Mauna Kea', region: 'Hawaii, United States', lat: 19.8207, lon: -155.4681, tz: 'Pacific/Honolulu' },
  { name: 'Tokyo', region: 'Japan', lat: 35.6762, lon: 139.6503, tz: 'Asia/Tokyo' },
];
let locResults = [];
let locActive = -1;
let locAbort = null;
let locTimer = 0;

function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}
function tzOffsetLabel(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date());
    return parts.find((p) => p.type === 'timeZoneName')?.value || '';
  } catch {
    return '';
  }
}
const localClockAt = (tz) => new Intl.DateTimeFormat('en-GB', { timeZone: validTimeZone(tz), hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());

function renderLocResults(title) {
  const items = locResults.map((r, i) => {
    const hemi = Math.abs(r.lat) < 5 ? 'Both skies' : r.lat < 0 ? '<span class="hemi">Southern sky</span>' : 'Northern sky';
    return `<li role="option" data-i="${i}" class="${i === locActive ? 'active' : ''}">
      <div class="lr-main"><div class="lr-name">${escapeHtml(r.name)}</div><div class="lr-sub">${escapeHtml(r.region)}</div></div>
      <div class="lr-side">${localClockAt(r.tz)} ${escapeHtml(tzOffsetLabel(r.tz))}<br>${hemi}</div>
    </li>`;
  }).join('');
  els.locResults.innerHTML = (title ? `<li class="lr-head">${escapeHtml(title)}</li>` : '') + items;
}

function showSuggestions() {
  locResults = SUGGESTED_PLACES;
  locActive = -1;
  renderLocResults('Dark-sky and far-away places');
  els.locNote.textContent = '';
}

async function searchPlaces(q) {
  locAbort?.abort();
  locAbort = new AbortController();
  els.locNote.textContent = 'Searching…';
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=8&language=en&format=json`;
    const r = await fetch(url, { signal: locAbort.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    locResults = (j.results || []).map((p) => ({
      name: p.name,
      region: [p.admin1, p.country].filter((x) => x && x !== p.name).join(', '),
      country: p.country,
      lat: p.latitude,
      lon: p.longitude,
      tz: validTimeZone(p.timezone || 'UTC'),
    }));
    const seen = new Set(); // the geocoder sometimes returns the same place twice
    locResults = locResults.filter((r) => {
      const k = `${r.name}|${r.region}`;
      return !seen.has(k) && seen.add(k);
    });
    locActive = locResults.length ? 0 : -1;
    renderLocResults();
    els.locNote.textContent = locResults.length ? '' : `No places match “${q}”.`;
  } catch (err) {
    if (err.name === 'AbortError') return;
    els.locNote.textContent = 'Place search is unavailable right now (offline?). Try a suggestion.';
  }
}

function openLocPicker() {
  stopTour();
  hidePeek();
  els.locPicker.hidden = false;
  els.locSearch.value = '';
  showSuggestions();
  if (lastPointerType === 'mouse') setTimeout(() => els.locSearch.focus(), 30);
}
const closeLocPicker = () => { els.locPicker.hidden = true; };

function wireLocPicker() {
  els.locBtn.addEventListener('click', openLocPicker);
  els.locClose.addEventListener('click', closeLocPicker);
  els.locPicker.addEventListener('click', (e) => { if (e.target === els.locPicker) closeLocPicker(); });
  els.locSearch.addEventListener('input', () => {
    clearTimeout(locTimer);
    const q = els.locSearch.value.trim();
    if (q.length < 2) { showSuggestions(); return; }
    locTimer = setTimeout(() => searchPlaces(q), 250);
  });
  els.locSearch.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!locResults.length) return;
      locActive = (locActive + (e.key === 'ArrowDown' ? 1 : -1) + locResults.length) % locResults.length;
      renderLocResults(els.locSearch.value.trim().length < 2 ? 'Dark-sky and far-away places' : '');
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = locResults[Math.max(0, locActive)];
      if (r) travelTo(r);
    } else if (e.key === 'Escape') {
      closeLocPicker();
    }
  });
  els.locResults.addEventListener('mousedown', (e) => e.preventDefault());
  els.locResults.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-i]');
    if (li) travelTo(locResults[Number(li.dataset.i)]);
  });
  els.locMine.addEventListener('click', useMyLocation);
}

// Switch the whole sky to another place (and its time zone), behind a loading screen.
async function travelTo(r) {
  closeLocPicker();
  stopNarration();
  closePanel();
  showLoading(`Travelling to ${r.name}…`, `${r.region ? `${r.region} · ` : ''}${fmtLatLon(r.lat, r.lon)}`);
  state.manualLocation = true;
  state.timeZone = validTimeZone(r.tz);
  setTimeTarget(0);
  state.offsetMin = 0;
  setLocation(r.lat, r.lon, r.region ? `${r.name}, ${r.country || r.region.split(', ').pop()}` : r.name, true);
  resetView();
  await hideLoading(900);
  offerTonight(r.name);
}

function resetView() {
  cancelAnim();
  state.yaw = (state.lat >= 0 ? 180 : 0) * DEG; // face the celestial equator
  state.pitch = (isCompact() ? 26 : 32) * DEG;
  state.fov = isCompact() ? 75 : 80;
  state.userMoved = false;
}

// If it's daytime there, offer to jump to tonight's dark sky.
function offerTonight(name) {
  const t0 = Date.now();
  if (sunAltAt(t0) < DARK_SUN) {
    showToast(`<strong>${escapeHtml(name)}:</strong> it's night there right now (${fmtClock(t0)} local time).`, 5000);
    return;
  }
  for (let m = 10; m <= 720; m += 10) {
    if (sunAltAt(t0 + m * 60000) < DARK_SUN) {
      const at = t0 + (m + 60) * 60000; // an hour into darkness
      const off = Math.min(720, m + 60);
      els.toast.innerHTML = `<strong>${escapeHtml(name)}:</strong> it's ${fmtClock(t0)} there and the Sun is up. <button type="button" data-tonight="${off}">Show tonight at ${fmtClock(at)}</button>`;
      els.toast.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { els.toast.hidden = true; }, 12000);
      return;
    }
  }
  showToast(`<strong>${escapeHtml(name)}:</strong> the Sun doesn't set there in the next 12 hours (midnight sun).`, 7000);
}

function useMyLocation() {
  closeLocPicker();
  showLoading('Finding where you are…', 'Allow location access when your browser asks');
  const done = async (lat, lon, place) => {
    state.manualLocation = false;
    state.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    setTimeTarget(0);
    state.offsetMin = 0;
    setLocation(lat, lon, place, true);
    resetView();
    await hideLoading(600);
  };
  if (!navigator.geolocation) { ipLocation().then(() => hideLoading(300)); return; }
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude, longitude } = pos.coords;
      els.loadingText.textContent = 'Looking up the place name…';
      const name = await reverseGeocode(latitude, longitude);
      await done(latitude, longitude, name || 'Your location');
    },
    async () => {
      els.loadingSub.textContent = 'Location access was refused — using an approximate location instead';
      const ok = await ipLocation();
      if (ok) {
        state.manualLocation = false;
        state.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        resetView();
      }
      await hideLoading(1200);
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 },
  );
}

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------
function updateLabels() {
  // Compass labels sit just below the horizon, but never under the footer controls.
  const footerTop = els.controls.getBoundingClientRect().top + 10;
  for (const c of CARDINALS) {
    const p = toScreen(c.vec);
    if (!p || p.x < -40 || p.x > W + 40 || p.y < -40 || p.y > H + 40) {
      c.el.style.display = 'none';
      continue;
    }
    c.el.style.display = '';
    const y = Math.min(p.y, footerTop);
    c.el.style.transform = `translate(${p.x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
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
let lastInput = 0;
// Full frame rate only while the view is moving; otherwise ~30 fps, which leaves
// CPU/GPU for the in-browser voice model and keeps its audio from stuttering.
const IDLE_FRAME_MS = 1000 / 30;
function viewIsMoving(now) {
  return !!state.anim || state.pointer.down || state.edgePanning || now - lastInput < 600 ||
    Math.abs(state.offsetTarget - state.offsetMin) > 0.05 || (tour.active && !tour.paused && !speech?.speaking) || !!state.pointing?.moving;
}
// Adaptive resolution: judged only while the view is moving (uncapped frame rate).
// Below ~40 fps render fewer pixels; with lots of headroom go back up to the display's sharpness.
const MAX_DPR = Math.min(window.devicePixelRatio || 1, 2);
const perf = { dpr: MAX_DPR, frames: 0, sum: 0 };
function adaptResolution(interval, moving) {
  if (!moving || interval > 250) { perf.frames = 0; perf.sum = 0; return; }
  perf.frames++;
  perf.sum += interval;
  if (perf.frames < 45) return;
  const avg = perf.sum / perf.frames;
  perf.frames = 0;
  perf.sum = 0;
  let next = perf.dpr;
  if (avg > 25 && perf.dpr > 1) next = Math.max(1, perf.dpr - 0.25);
  else if (avg < 12 && perf.dpr < MAX_DPR) next = Math.min(MAX_DPR, perf.dpr + 0.25);
  if (next === perf.dpr) return;
  perf.dpr = next;
  renderer.setPixelRatio(next);
  renderer.setSize(W, H, false);
  starMaterial.uniforms.uPixelRatio.value = next;
}

function frame(now) {
  requestAnimationFrame(frame);
  const moving = viewIsMoving(now);
  if (!moving && now - lastFrame < IDLE_FRAME_MS - 2) return;
  const interval = now - lastFrame;
  adaptResolution(interval, moving);
  const dt = Math.min(0.05, interval / 1000);
  lastFrame = now;

  stepAnim(now);
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
  const narratorPointing = state.pointing && now - lastInput >= 1500;
  if (lastPointerType === 'mouse' && state.pointer.inside && !state.pointer.down && (!tour.active || tour.paused) && !narratorPointing) setHover(pick(state.pointer.x, state.pointer.y));
  followPointing(now);
  updateLabels();
  updateMarker();

  if (timeMoving || now - lastHeader > 1000) {
    lastHeader = now;
    updateHeader();
    refreshVisBox();
  }

  renderer.render(scene, camera);
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

// Small debugging/scripting hook (also the seam for a future assistant).
window.nightSky = {
  narration: (name) => narration(consts.find((c) => c.abbr === name || norm(c.name) === norm(name))),
  visibility: (name) => visibility(consts.find((c) => c.abbr === name || norm(c.name) === norm(name))),
  layers: () => ({ milkyWay, starPoints, dome, ground }),
  perf: () => ({ dpr: perf.dpr, maxDpr: MAX_DPR }),
  // Where a constellation's figure is on screen right now (null if not in view) — handy for tests.
  screenOf: (name) => { const c = consts.find((k) => k.abbr === name || norm(k.name) === norm(name)); return c ? figureScreenCentre(c) : null; },
  view: () => ({ yaw: +(state.yaw / DEG).toFixed(2), pitch: +(state.pitch / DEG).toFixed(2), fov: +state.fov.toFixed(1), anim: !!state.anim, edge: !!state.edgePanning, edgeArmed: state.edgeArmed, pointer: { ...state.pointer }, pointing: state.pointing?.star?.name || null }),
  // Render n frames synchronously (GPU forced to finish each one) and return ms per frame.
  bench(n = 60, dpr = renderer.getPixelRatio()) {
    const prev = renderer.getPixelRatio();
    renderer.setPixelRatio(dpr);
    renderer.setSize(W, H, false);
    const gl = renderer.getContext();
    const px = new Uint8Array(4);
    renderer.render(scene, camera);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      renderer.render(scene, camera);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    }
    const ms = (performance.now() - t0) / n;
    renderer.setPixelRatio(prev);
    renderer.setSize(W, H, false);
    return +ms.toFixed(2);
  },
};

wireControls();
wireExtras();
wireMobile();
wireLocPicker();
initLocation();
loadData()
  .then(() => {
    buildStars();
    buildConstellations();
    buildSearchIndex();
    refreshLineStyles();
    requestAnimationFrame(frame);
    skyReady = true;
    maybePreloadVoice();
    hideLoading(0);
    // Deep link: ?c=Orion (or ?c=Ori) opens that constellation, e.g. for sharing.
    const want = new URLSearchParams(location.search).get('c');
    const linked = want && consts.find((k) => k.abbr.toLowerCase() === want.toLowerCase() || norm(k.name) === norm(want));
    if (linked) focusOn(linked);
  })
  .catch((err) => {
    console.error('Night Sky failed to start:', err);
    showLoading('Could not load the star data', String(err.message || err));
    els.loc.textContent = `Failed to load star data: ${err.message}`;
  });
