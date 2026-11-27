// tts-worker.js — Kokoro-82M text-to-speech in a module Web Worker.
// Loaded by speech.js as `new Worker('./tts-worker.js', { type: 'module' })`.
//
// Protocol (main → worker):
//   { type: 'load', device?: 'webgpu'|'wasm'|'auto', dtype?: string, voice?: string }
//   { type: 'generate', id, text, voice?, speed? }   queued, processed one at a time
//   { type: 'cancel' }                                drops every queued generate
// Protocol (worker → main):
//   { type: 'progress', progress: 0..1, message }
//   { type: 'loaded', device, dtype, loadMs, warmupMs }
//   { type: 'load-error', message }
//   { type: 'audio', id, samples: Float32Array, sampleRate, genMs, rms, seconds }
//   { type: 'gen-error', id, message }

import { KokoroTTS, env } from './vendor/kokoro/kokoro.web.js';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const DTYPE = { webgpu: 'fp32', wasm: 'q8' };

// Hardware-aware WASM: multi-threaded inference needs SharedArrayBuffer, which browsers only
// allow on cross-origin-isolated pages (serve.py sends COOP/COEP). Leave a couple of cores
// for rendering and the audio thread; more than ~8 threads stops helping for an 82M model.
function configureWasm() {
  const wasm = env?.backends?.onnx?.wasm;
  const cores = self.navigator?.hardwareConcurrency || 4;
  const threads = self.crossOriginIsolated ? Math.max(1, Math.min(8, cores - 2)) : 1;
  if (wasm) wasm.numThreads = threads;
  return threads;
}

let tts = null;
let loading = null;
let queue = [];
let busy = false;

// transformers.js reports per-file progress; combine into one 0..1 number by bytes.
function progressReporter() {
  const files = new Map();
  return (p) => {
    if ((p.status === 'progress' || p.status === 'done') && p.file) {
      const f = files.get(p.file) || { loaded: 0, total: 0 };
      if (p.total > 0) f.total = p.total;
      f.loaded = p.status === 'done' ? f.total : (p.loaded > 0 ? p.loaded : f.loaded);
      files.set(p.file, f);
      let loaded = 0, total = 0;
      for (const v of files.values()) { loaded += v.loaded; total += v.total; }
      if (total < 1048576) return; // only report once the big .onnx file is in flight
      const mb = (n) => (n / 1048576).toFixed(0);
      postMessage({
        type: 'progress',
        progress: total ? Math.min(1, loaded / total) : 0,
        message: `Loading voice model ${mb(loaded)} / ${mb(total)} MB`,
      });
    }
  };
}

function rmsOf(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, a.length));
}

async function tryLoad(device, dtype, voice) {
  const t0 = performance.now();
  const threads = device === 'wasm' ? configureWasm() : 0;
  const model = await KokoroTTS.from_pretrained(MODEL_ID, {
    dtype, device, progress_callback: progressReporter(),
  });
  const loadMs = performance.now() - t0;
  // WASM output is reliable; skip the warm-up there (it would only delay the first sentence).
  if (device === 'wasm') return { model, loadMs, warmupMs: 0, threads };
  // Warm up (compiles WebGPU shaders / WASM kernels) and prove the device yields real audio:
  // some GPU drivers run the fp32 graph but return NaN or silence.
  postMessage({ type: 'progress', progress: 1, message: 'Warming up voice…' });
  const t1 = performance.now();
  const out = await model.generate('Hello.', { voice, speed: 1 });
  const rms = rmsOf(out.audio);
  if (!(rms > 0.005) || !Number.isFinite(rms)) throw new Error(`${device} produced silent audio (rms ${rms})`);
  return { model, loadMs, warmupMs: performance.now() - t1, threads };
}

async function load({ device = 'auto', dtype = null, voice = 'af_heart' } = {}) {
  const order = device === 'auto'
    ? (self.navigator?.gpu && (await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null)) ? ['webgpu', 'wasm'] : ['wasm'])
    : [device];
  const errors = [];
  for (const d of order) {
    try {
      const dt = dtype || DTYPE[d];
      const r = await tryLoad(d, dt, voice);
      tts = r.model;
      postMessage({ type: 'loaded', device: d, dtype: dt, loadMs: r.loadMs, warmupMs: r.warmupMs, threads: r.threads, isolated: !!self.crossOriginIsolated, fallbackReasons: errors });
      pump(); // anything queued while loading
      return;
    } catch (e) {
      errors.push(`${d}: ${e?.message || e}`);
    }
  }
  throw new Error(errors.join(' | '));
}

async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const job = queue.shift();
    try {
      const t0 = performance.now();
      const out = await tts.generate(job.text, { voice: job.voice || 'af_heart', speed: job.speed ?? 1 });
      const samples = out.audio; // Float32Array, mono
      postMessage({
        type: 'audio', id: job.id, samples, sampleRate: out.sampling_rate,
        genMs: performance.now() - t0, rms: rmsOf(samples), seconds: samples.length / out.sampling_rate,
      }, [samples.buffer]);
    } catch (e) {
      postMessage({ type: 'gen-error', id: job.id, message: String(e?.message || e) });
    }
  }
  busy = false;
}

self.onmessage = async ({ data }) => {
  if (data.type === 'load') {
    if (!loading) loading = load(data).catch((e) => { loading = null; throw e; });
    try { await loading; } catch (e) { postMessage({ type: 'load-error', message: String(e?.message || e) }); }
  } else if (data.type === 'generate') {
    queue.push(data);
    if (tts) pump();
  } else if (data.type === 'cancel') {
    queue = [];
  }
};
