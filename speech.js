// speech.js — narration for Night Sky.
// Kokoro-82M (Apache-2.0) runs in a module Web Worker (tts-worker.js); audio plays through one
// AudioContext with sentence streaming. Falls back to the browser's speechSynthesis.
//
//   import { speech } from './speech.js';
//   speech.onchange = (state, info) => {};  // 'idle'|'loading'|'ready'|'speaking'|'error', {progress?, message?, engine?}
//   speech.preload();                       // optional, starts the model download
//   button.onclick = () => speech.speaking ? speech.stop() : speech.speak(text);
//   speech.speak(text, { cues: [{ index, lead, fn }] })  // fn() fires `lead` s (default 0.6) before
//                                                       // the character at `index` is spoken
//
// Call speak() directly inside the click handler (before any await): it creates/resumes the
// AudioContext synchronously, which browsers only allow during a user gesture.
// URL overrides for debugging: ?engine=webspeech|kokoro  ?ttsdevice=wasm|webgpu  ?ttsdtype=fp32|fp16|q8|q4

const VOICE = 'af_heart';
const SPEED = 1.0;
const SENTENCE_GAP = 0.06;     // seconds of extra silence between sentences (Kokoro adds its own tail)
const CHUNK_TIMEOUT = 30000;   // ms without a generated chunk before giving up on Kokoro
const FIRST_CHUNK_TIMEOUT = 12000; // the first sentence must arrive sooner, or we fall back
const MAX_CHUNK = 220;         // chars; longer sentences are split at commas etc. (model limit ≈ 510 tokens)
const FIRST_CHUNK = 90;        // keep the first chunk short so audio starts sooner

const params = new URLSearchParams(globalThis.location?.search || '');

// ---------- text → chunks ----------
export function splitSentences(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  // Sentence ends: . ! ? … followed by space and an uppercase letter/digit/quote/bracket.
  const sentences = clean.split(/(?<=[.!?…]["'”’)]?)\s+(?=["'“‘(\[]?[A-Z0-9])/u);
  const out = [];
  for (const s of sentences) {
    const limit = out.length === 0 ? FIRST_CHUNK : MAX_CHUNK;
    if (s.length <= limit) { out.push(s); continue; }
    // Split long sentences at clause boundaries, packing pieces up to the limit.
    const parts = s.split(/(?<=[,;:—–])\s+/);
    let cur = '';
    for (const p of parts) {
      const lim = out.length === 0 ? FIRST_CHUNK : MAX_CHUNK;
      if (cur && (cur.length + 1 + p.length) > lim) { out.push(cur); cur = p; }
      else cur = cur ? `${cur} ${p}` : p;
    }
    if (cur) out.push(cur);
  }
  return out;
}

// ---------- Web Speech helpers ----------
function pickWebVoice() {
  const voices = globalThis.speechSynthesis?.getVoices?.() || [];
  const en = voices.filter((v) => /^en[-_](GB|US)/i.test(v.lang));
  const pool = en.length ? en : voices.filter((v) => /^en/i.test(v.lang));
  const score = (v) => {
    let s = 0;
    if (/natural|neural/i.test(v.name)) s += 50;
    if (/premium|enhanced/i.test(v.name)) s += 40;
    if (/samantha|daniel|serena|ava|allison|google uk english|google us english/i.test(v.name)) s += 20;
    if (/en[-_]GB/i.test(v.lang)) s += 2;
    if (v.localService) s += 1;
    if (/compact|novelty|whisper|bells|zarvox|bad news|bahh|boing|bubbles|cellos|jester|organ|trinoids|superstar|wobble|albert|fred|junior|ralph|kathy|grandpa|grandma|rocko|shelley|eddy|flo|reed|sandy/i.test(v.name)) s -= 100;
    return s;
  };
  return pool.sort((a, b) => score(b) - score(a))[0] || null;
}

// iOS returns an empty voice list on the first getVoices() call and fills it in shortly after.
// Ask early (at module load) so the list is ready by the time someone taps Listen.
try {
  globalThis.speechSynthesis?.getVoices();
  globalThis.speechSynthesis?.addEventListener?.('voiceschanged', () => globalThis.speechSynthesis.getVoices());
} catch {}

function webVoicesReady(timeout = 1500) {
  const ss = globalThis.speechSynthesis;
  if (!ss || ss.getVoices().length) return Promise.resolve();
  return new Promise((res) => {
    const done = () => { ss.removeEventListener?.('voiceschanged', done); res(); };
    ss.addEventListener?.('voiceschanged', done);
    setTimeout(done, timeout);
  });
}

// iOS Safari treats page audio (Web Audio and speech) as 'ambient' by default, so the ring/silent
// switch mutes it. Declaring it as media playback lets narration play like a video does.
// (Audio Session API, Safari 16.4+; ignored elsewhere.)
function preferPlaybackAudio() {
  try { if (navigator.audioSession && navigator.audioSession.type !== 'playback') navigator.audioSession.type = 'playback'; } catch {}
}

// ---------- the narrator ----------
class Speech {
  constructor() {
    this.state = 'idle';
    this.engine = null;          // 'kokoro' | 'webspeech' | null
    this.onchange = null;
    this.onmetric = null;        // optional: (event) => {} — timings for the test page
    this.info = {};              // { device, dtype, loadMs, warmupMs, fallbackReason, webVoice }
    this.mode = params.get('engine') || 'auto';     // 'auto' | 'kokoro' | 'webspeech'
    // Phones/tablets (touch only): use the device's own voice — good on iOS/Android, instant,
    // and no 310 MB model download over mobile data. ?engine=kokoro overrides.
    const touchOnly = globalThis.matchMedia?.('(pointer: coarse)').matches && !globalThis.matchMedia?.('(any-pointer: fine)').matches;
    // iPhone/iPad Safari (including iPadOS, which reports a Mac user agent, and devices with a
    // trackpad or the Simulator's mouse): the in-browser model runs on Safari's WASM, which is
    // slow to the point of stalling, so use the system voice there too.
    const nav = globalThis.navigator || {};
    const appleMobile = /iPhone|iPad|iPod/.test(nav.userAgent || '') || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
    if (this.mode === 'auto' && (touchOnly || appleMobile)) this.mode = 'webspeech';
    this.device = params.get('ttsdevice') || 'auto'; // 'auto' | 'webgpu' | 'wasm'
    this.dtype = params.get('ttsdtype') || null;    // override, e.g. 'fp16'
    this.voice = VOICE;
    this.speed = SPEED;
    this._worker = null;
    this._load = null;
    this._ctx = null;
    this._session = null;
    this._pending = new Map();   // chunk id → resolve(msg)
    this._seq = 0;
    this._dbg = {}; // counters for ?debug=speech
  }

  get speaking() { return this.state === 'speaking'; }

  /** Call inside a tap/click that will lead to speech later (e.g. starting the tour):
   *  browsers — iOS Safari especially — only allow audio that starts from a user gesture. */
  unlock(phrase = '') {
    this._ensureAudio();
    const ss = globalThis.speechSynthesis;
    if ((this.mode === 'webspeech' || this.engine === 'webspeech') && ss && !this.speaking) {
      try {
        const u = new SpeechSynthesisUtterance(phrase || ' ');
        const voice = pickWebVoice();
        if (voice) { u.voice = voice; u.lang = voice.lang; }
        if (!phrase) u.volume = 0;
        ss.speak(u);
      } catch {}
    }
  }
  get paused() { return !!this._session?.paused; }

  /** Freeze narration mid-word (audio clock suspended; cues wait too). */
  pause() {
    const s = this._session;
    if (!s || s.paused) return;
    s.paused = true;
    for (const t of s.timers) clearTimeout(t);
    s.timers.length = 0;
    if (this.engine === 'kokoro' && this._ctx) this._ctx.suspend().catch(() => {});
    else globalThis.speechSynthesis?.pause();
    this._set(this.state, { paused: true });
  }

  /** Continue exactly where pause() stopped; pending cues are rescheduled on the audio clock. */
  resume() {
    const s = this._session;
    if (!s || !s.paused) return;
    s.paused = false;
    if (this.engine === 'kokoro' && this._ctx) {
      this._ctx.resume().catch(() => {});
      for (const cue of s.cues) {
        if (cue.fired || cue.at == null) continue;
        s.timers.push(setTimeout(() => this._fireCue(s, cue), Math.max(0, (cue.at - this._ctx.currentTime) * 1000)));
      }
    } else {
      globalThis.speechSynthesis?.resume();
    }
    this._set(this.state, { paused: false });
  }

  _set(state, info = {}) {
    this.state = state;
    try { this.onchange?.(state, { engine: this.engine, ...info }); } catch (e) { console.error(e); }
  }
  _metric(ev) { try { this.onmetric?.(ev); } catch (e) { console.error(e); } }

  _useWebSpeech(reason) {
    if (this.engine === 'kokoro' && !reason) return;
    this.engine = 'webspeech';
    if (reason) { this.info.fallbackReason = reason; console.warn('[speech] falling back to speechSynthesis:', reason); }
    try { this._worker?.terminate(); } catch {}
    this._worker = null;
    for (const r of this._pending.values()) r({ type: 'gen-error', message: reason || 'worker gone' });
    this._pending.clear();
  }

  /** Start loading Kokoro. Never rejects: on failure the engine becomes 'webspeech'. */
  preload() {
    if (this._load) return this._load;
    if (this.mode === 'webspeech' || typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') {
      this._useWebSpeech(this.mode === 'webspeech' ? '' : 'no Worker/WebAssembly support');
      if (this.state === 'idle' && !this._session) this._set('ready', { message: 'Using the browser voice' });
      return (this._load = Promise.resolve());
    }
    const t0 = performance.now();
    this._load = new Promise((resolve) => {
      let worker;
      const fail = (msg) => {
        this._useWebSpeech(msg);
        if (!this._session) this._set('ready', { message: 'Using the browser voice' });
        this._metric({ type: 'load-failed', message: msg });
        resolve();
      };
      try {
        worker = new Worker(new URL('./tts-worker.js', import.meta.url), { type: 'module' });
      } catch (e) { fail(`worker: ${e.message}`); return; }
      this._worker = worker;
      worker.onerror = (e) => { e.preventDefault?.(); fail(`worker error: ${e.message || 'failed to start'}`); };
      worker.onmessageerror = () => fail('worker message error');
      worker.onmessage = ({ data: m }) => {
        if (m.type === 'progress') {
          if (!this.speaking) this._set('loading', { progress: m.progress, message: m.message });
        } else if (m.type === 'loaded') {
          this.engine = 'kokoro';
          Object.assign(this.info, { device: m.device, dtype: m.dtype, threads: m.threads, isolated: m.isolated, loadMs: m.loadMs, warmupMs: m.warmupMs,
            totalLoadMs: performance.now() - t0, deviceFallback: m.fallbackReasons });
          this._metric({ type: 'loaded', ...this.info });
          if (!this._session) this._set('ready', { message: `Voice ready (${m.device})` });
          resolve();
        } else if (m.type === 'load-error') {
          fail(m.message);
        } else if (m.type === 'audio' || m.type === 'gen-error') {
          const r = this._pending.get(m.id);
          if (r) { this._pending.delete(m.id); r(m); }
        }
      };
      this._set('loading', { progress: 0, message: 'Loading voice model…' });
      worker.postMessage({ type: 'load', device: this.device, dtype: this.dtype, voice: this.voice });
    });
    return this._load;
  }

  _ensureAudio() {
    preferPlaybackAudio();
    if (this.mode === 'webspeech' || this.engine === 'webspeech') return;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return;
    if (!this._ctx) // 'playback' asks for larger output buffers: slightly more latency, but the audio
    // thread keeps up when the CPU is busy (small buffers underrun and crackle).
    this._ctx = new AC({ latencyHint: 'playback' });
    if (this._ctx.state === 'suspended') this._ctx.resume().catch(() => {});
  }

  /** Speak text. Resolves when playback ends or stop() is called. */
  speak(text, { cues = [] } = {}) {
    this.stop();
    this._ensureAudio(); // synchronous: still inside the user gesture
    const chunks = splitSentences(text);
    const s = { id: ++this._seq, cancelled: false, sources: [], timers: [], t0: performance.now() };
    s.cues = this._mapCues(text, chunks, cues);
    s.stopped = new Promise((res) => { s.onStop = res; });
    this._session = s;
    if (!chunks.length) return Promise.resolve();

    // Device voice (speechSynthesis): iOS Safari only plays speech that starts *synchronously*
    // inside the tap, so nothing may be awaited before the first speak() on this path.
    const webNow = this.mode === 'webspeech' || this.engine === 'webspeech';
    // On the model path, also unlock the system voice inside this tap (a silent utterance), so a
    // later fallback to it is allowed to play on browsers that gate speech behind a gesture.
    if (!webNow && globalThis.speechSynthesis && !this._webUnlocked) {
      try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; globalThis.speechSynthesis.speak(u); this._webUnlocked = true; } catch {}
    }
    const run = webNow
      ? (async () => {
        if (!this._load) this.preload();
        this._set('speaking');
        await this._speakWeb(chunks, s);
      })()
      : (async () => {
        if (!this._load) this.preload();
        if (this.state !== 'loading') this._set('speaking');
        await this._load;
        if (s.cancelled) return;
        if (this.state !== 'speaking') this._set('speaking');
        if (this.engine === 'kokoro' && this._ctx) await this._speakKokoro(chunks, s);
        else await this._speakWeb(chunks, s);
      })();

    return Promise.race([run, s.stopped]).finally(() => {
      if (this._session === s) {
        this._session = null;
        if (this.state !== 'error') this._set('ready');
      }
    });
  }

  // Cues are character positions in the text; find each one's chunk and how far into it it sits.
  _mapCues(text, chunks, cues) {
    if (!cues.length || !chunks.length) return [];
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    let pos = 0;
    const offsets = chunks.map((ch) => {
      const at = clean.indexOf(ch, pos);
      const start = at >= 0 ? at : pos;
      pos = start + ch.length;
      return start;
    });
    return cues.map((c) => {
      let i = 0;
      while (i + 1 < chunks.length && offsets[i + 1] <= c.index) i++;
      const rel = Math.min(1, Math.max(0, (c.index - offsets[i]) / Math.max(1, chunks[i].length)));
      return { fn: c.fn, lead: c.lead ?? 0.6, chunk: i, rel, relChars: c.index - offsets[i], fired: false };
    });
  }

  _fireCue(s, cue) {
    if (s.cancelled || cue.fired) return;
    cue.fired = true;
    try { cue.fn(); } catch (e) { console.error(e); }
  }

  // Kokoro: the chunk's start time on the audio clock is known exactly; place each cue
  // proportionally inside the sentence, `lead` seconds early.
  _scheduleCues(s, chunk, startCtxTime, duration) {
    const ctx = this._ctx;
    for (const cue of s.cues) {
      if (cue.chunk !== chunk || cue.fired) continue;
      cue.at = startCtxTime + cue.rel * duration - cue.lead; // on the audio clock
      if (s.paused) continue; // resume() schedules it
      s.timers.push(setTimeout(() => this._fireCue(s, cue), Math.max(0, (cue.at - ctx.currentTime) * 1000)));
    }
  }

  stop() {
    const s = this._session;
    if (!s) return;
    s.cancelled = true;
    for (const t of s.timers) clearTimeout(t);
    s.timers.length = 0;
    this._session = null;
    for (const src of s.sources) { try { src.onended = null; src.stop(); } catch {} }
    s.sources.length = 0;
    this._worker?.postMessage({ type: 'cancel' });
    for (const [id, r] of this._pending) if (id.startsWith(`${s.id}:`)) { this._pending.delete(id); r(null); }
    const ss = globalThis.speechSynthesis;
    if (ss && (ss.speaking || ss.pending)) {
      ss.cancel();
      this._cancelledAt = performance.now();
    }
    s.onStop();
    if (this._load && this.engine === null) this._set('loading', { message: 'Loading voice model…' });
    else this._set('ready');
  }

  _requestChunk(id, text) {
    return new Promise((resolve) => {
      this._pending.set(id, resolve);
      this._worker.postMessage({ type: 'generate', id, text, voice: this.voice, speed: this.speed });
    });
  }

  async _speakKokoro(chunks, s) {
    const ctx = this._ctx;
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    // Queue every chunk now; the worker generates them in order while earlier ones play.
    const reqs = chunks.map((text, i) => this._requestChunk(`${s.id}:${i}`, text));
    let nextTime = 0;
    let lastEnded = Promise.resolve();
    // On the CPU (WASM) path generation runs close to real time, so the second sentence can
    // take longer to generate than the first one takes to play. Buffer one sentence ahead
    // there so playback never stalls mid-narration. (WebGPU is ~10x faster; start at once.)
    if (this.info.device === 'wasm' && chunks.length > 1) {
      let timer;
      await Promise.race([reqs[1], s.stopped, new Promise((r) => { timer = setTimeout(r, CHUNK_TIMEOUT); })]);
      clearTimeout(timer);
      if (s.cancelled) return;
    }
    for (let i = 0; i < chunks.length; i++) {
      let timer;
      const m = await Promise.race([reqs[i], new Promise((r) => { timer = setTimeout(() => r({ type: 'timeout' }), i === 0 ? FIRST_CHUNK_TIMEOUT : CHUNK_TIMEOUT); })]);
      clearTimeout(timer);
      if (s.cancelled || !m) return;
      if (m.type === 'timeout' || (m.type === 'gen-error' && !this._worker)) {
        // Kokoro is stuck or dead: let what is scheduled finish, then speak the rest with the browser voice.
        this._useWebSpeech(m.type === 'timeout' ? `generation timed out on chunk ${i}` : m.message);
        this._metric({ type: 'fallback', index: i, message: this.info.fallbackReason });
        await Promise.race([lastEnded, s.stopped]);
        if (s.cancelled) return;
        return this._speakWeb(chunks.slice(i), s, i);
      }
      if (m.type === 'gen-error') { this._metric({ type: 'chunk-error', index: i, text: chunks[i], message: m.message }); continue; }

      this._dbg.generated = (this._dbg.generated || 0) + 1;
      this._dbg.lastRms = m.rms;
      const buf = ctx.createBuffer(1, m.samples.length, m.sampleRate);
      buf.copyToChannel(m.samples, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      const start = Math.max(ctx.currentTime + 0.12, nextTime); // lead time absorbs scheduling jitter
      src.start(start);
      this._dbg.scheduled = (this._dbg.scheduled || 0) + 1;
      src.addEventListener('ended', () => { this._dbg.played = (this._dbg.played || 0) + 1; });
      this._scheduleCues(s, i, start, buf.duration);
      nextTime = start + buf.duration + SENTENCE_GAP;
      s.sources.push(src);
      lastEnded = new Promise((r) => { src.onended = r; });
      this._metric({ type: 'chunk', engine: 'kokoro', index: i, text: chunks[i], genMs: m.genMs, rms: m.rms,
        seconds: m.seconds, rtf: m.genMs / 1000 / m.seconds,
        firstAudioMs: i === 0 ? performance.now() - s.t0 + (start - ctx.currentTime) * 1000 : undefined });
    }
    await Promise.race([lastEnded, s.stopped]);
  }

  async _speakWeb(chunks, s, base = 0) {
    const ss = globalThis.speechSynthesis;
    if (!ss || typeof SpeechSynthesisUtterance === 'undefined') {
      this._set('error', { message: 'No speech engine available in this browser' });
      throw new Error('speechSynthesis unavailable');
    }
    // Never wait before the first sentence: on iOS that would leave the tap's user gesture and the
    // speech would be dropped. If the voice list isn't loaded yet, the system default voice speaks.
    // WebKit silently drops a speak() issued right after cancel(); give it a moment.
    // (Only happens when replacing a narration, by which time speech is already unlocked.)
    const sinceCancel = performance.now() - (this._cancelledAt ?? -1e9);
    if (sinceCancel < 150) await new Promise((r) => setTimeout(r, 150 - sinceCancel));
    if (s.cancelled) return;
    const voice = pickWebVoice();
    this.info.webVoice = voice ? `${voice.name} (${voice.lang})` : 'default';
    for (let i = 0; i < chunks.length; i++) {
      if (s.cancelled) return;
      // One utterance per sentence: avoids Chrome's ~15 s utterance cut-off and makes stop() instant.
      await new Promise((resolve) => {
        const u = new SpeechSynthesisUtterance(chunks[i]);
        if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = 'en-GB';
        u.rate = 0.95;
        const t0 = performance.now();
        // onend sometimes never fires: give up after a generous time, not counting pauses.
        let left = 4000 + chunks[i].length * 150;
        const guard = setInterval(() => { if (!s.paused && (left -= 250) <= 0) { clearInterval(guard); resolve(); } }, 250);
        const cues = s.cues.filter((c) => c.chunk === base + i);
        u.onstart = () => {
          this._metric({ type: 'chunk', engine: 'webspeech', index: i, text: chunks[i], voice: this.info.webVoice,
            firstAudioMs: i === 0 ? performance.now() - s.t0 : undefined, startMs: performance.now() - t0 });
          // No exact timing from speechSynthesis: estimate (~14 chars/s), refined by word boundaries below.
          const est = chunks[i].length / 14 / u.rate;
          if (!s.paused) for (const c of cues) s.timers.push(setTimeout(() => this._fireCue(s, c), Math.max(0, (c.rel * est - c.lead) * 1000)));
        };
        u.onboundary = (e) => { for (const c of cues) if (e.charIndex >= c.relChars - 12) this._fireCue(s, c); };
        u.onend = () => { clearInterval(guard); resolve(); };
        u.onerror = (e) => { this._lastError = `${e.error || 'error'} (sentence ${base + i + 1})`; clearInterval(guard); resolve(); };
        s.stopped.then(() => { clearInterval(guard); resolve(); });
        ss.speak(u);
      });
    }
  }
}

export const speech = new Speech();

// ?debug=speech — a small live readout of what the speech engine is doing (for phones, where
// there's no console): engine, state, speechSynthesis flags, voices, and the last error.
if (params.get('debug') === 'speech' && globalThis.document) {
  const box = document.createElement('pre');
  box.style.cssText = 'position:fixed;left:8px;bottom:120px;z-index:999;margin:0;padding:8px 10px;font:12px/1.35 ui-monospace,monospace;color:#cfe;background:rgba(0,0,0,.8);border:1px solid #456;border-radius:8px;pointer-events:none;white-space:pre';
  const add = () => document.body.appendChild(box);
  if (document.body) add(); else addEventListener('DOMContentLoaded', add);
  let started = 0;
  const origSpeak = globalThis.speechSynthesis?.speak?.bind(globalThis.speechSynthesis);
  if (origSpeak) globalThis.speechSynthesis.speak = (u) => { u.addEventListener('start', () => { started++; }); return origSpeak(u); };
  setInterval(() => {
    const ss = globalThis.speechSynthesis;
    box.textContent = [
      `engine ${speech.engine || '-'}  mode ${speech.mode}  state ${speech.state}`,
      `synth speaking ${ss?.speaking}  pending ${ss?.pending}  paused ${ss?.paused}`,
      `voices ${ss?.getVoices().length ?? 'n/a'}  utterances started ${started}`,
      `last error ${speech._lastError || '-'}`,
      `kokoro ${speech.info.device || '-'}/${speech.info.dtype || '-'}  ctx ${speech._ctx ? `${speech._ctx.state} t=${speech._ctx.currentTime.toFixed(1)} sr=${speech._ctx.sampleRate}` : '-'}`,
      `chunks generated ${speech._dbg.generated || 0} scheduled ${speech._dbg.scheduled || 0} played ${speech._dbg.played || 0} rms ${speech._dbg.lastRms ? speech._dbg.lastRms.toFixed(3) : '-'}`,
      `pointer coarse ${matchMedia('(pointer: coarse)').matches} anyFine ${matchMedia('(any-pointer: fine)').matches} audioSession ${navigator.audioSession ? navigator.audioSession.type : 'n/a'}`,
    ].join('\n');
  }, 250);
}
export default speech;
