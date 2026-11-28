# Night Sky

The sky above you right now. The app detects your time zone, date/time and
location, and draws the stars exactly where they are from where you stand.
You look up from the ground at the sky hemisphere; anything below the horizon
is hidden. Hover over a constellation to see its name; click it for a side panel
with a star chart, the named stars in its figure, when and where to see it, and
a short description.

**Live:** https://night-sky-nine.vercel.app (open it on your phone; add it to the home screen for full-screen)

## Run

```sh
cd ~/Projects/personal/night-sky
python3 serve.py          # http://localhost:8000/  (no-cache, so edits show on reload)
```

On a phone (same Wi-Fi): `python3 serve.py 8000 --lan` prints an address to open on the phone.
Over plain http phones won't share GPS, so the app uses an approximate location; tap the
location title to pick any place. Add it to the home screen for full-screen.

Allow location access when the browser asks. Without it the app falls back to
an approximate location from your IP address, then to Greenwich.

## Controls

**Phone / touch:** drag to look around, pinch to zoom, tap a constellation to see its name and
tap again (or **Details ›**) for the bottom sheet; drag the sheet's handle up to expand or down to close.
Narration uses the device's own voice on phones (no model download); `?engine=kokoro` opts in.

**Location:** click/tap the location in the header to search any city (Open-Meteo geocoding,
with its time zone) or pick a dark-sky site; the sky, clock and Sun switch to that place behind
a loading screen, with a "Show tonight" shortcut if it's daytime there.

**Mouse / keyboard:**

- **Look around:** drag the sky, rest the cursor near an edge of the window, or use the arrow keys
- **Zoom:** mouse wheel over the sky (or `+` / `-`)
- **Time:** the slider (or the mouse wheel over it) shifts the sky ±12 h; **Now** returns to live
- **Lines / Names / Voice:** toggle constellation figures, labels, and tour narration
- **Search** (`/`): constellations and named stars; says when something isn't in tonight's sky and why
- **▶ Listen** (panel) reads an overview aloud; a pointer glides to each star just before it's named
- **▶ Tour** runs a narrated planetarium tour. Its bar has **Pause/Resume** (Space), **Restart** and **Stop** (Esc);
  dragging or scrolling the sky pauses it, and Resume flies back to the current constellation
- **Full screen** (`F`): the interface fades until you move the mouse
- **Esc** stops the tour / closes the panel

## How it works

- The observer is at the origin of a horizon frame (x east, y up, −z north). Star
  positions (J2000) are rotated to that frame every frame using IAU 1976
  precession, Greenwich mean sidereal time, and your latitude/longitude.
  Checked against astropy: positions agree to 0.01° (stars and Sun).
- Stars are additive point sprites sized and dimmed by magnitude, coloured from
  their B−V index, fading toward the horizon. The Milky Way is a procedural band
  along the real galactic plane. The ground silhouette is drawn last, so nothing
  below the horizon shows.
- Hover picks the nearest figure line, or the smallest figure whose outline
  contains the cursor; bright stars are named individually.

## Voice

Narration uses **Kokoro-82M** (Apache-2.0) running entirely in the browser via kokoro-js
(`speech.js` + `tts-worker.js`, bundle in `vendor/kokoro/`). It starts loading in idle time as
soon as the sky is drawn (skipped on Save-Data / 2G connections; then it loads on first use).
First load downloads the model from Hugging Face and caches it in the browser:

| Hardware path | Model | Download | Warm start → first word | Speed (this M5 Pro) |
|---|---|---|---|---|
| WebGPU (default when available) | fp32 | 310 MB | ~0.9 s | ~0.08× real time |
| WASM (no WebGPU) | q8 | 88 MB | ~6.8 s (buffers a sentence ahead) | ~0.8–0.9× real time (Chrome) |
| Fallback | browser `speechSynthesis` | none | instant | — |

`speech.speak(text, { cues })` fires callbacks just before given character positions are spoken
(exact on the Kokoro audio clock; word-boundary events on the browser voice) — used to point at
stars. `speech.pause()` / `resume()` suspend the audio clock, so cues wait too.

**iPhone / iPad:** narration uses the system voice. Kokoro's text-to-phoneme step (eSpeak-NG
compiled to WASM, the `phonemizer` package) never returns in iOS Safari: a bare
`phonemize('Orion, the Hunter.')` times out after 60 s on iOS 26.5 (Simulator) with or without
cross-origin isolation, versus 45 ms in desktop Chrome. The neural network itself works there
(1.85 s of audio in 2.5 s on WASM when given phonemes directly).

Debug overrides: `?engine=webspeech|kokoro`, `?ttsdevice=webgpu|wasm`, `?ttsdtype=…`; `speech-test.html` logs timings.

## Performance

- Render cost on an M5 Pro at Retina scale: 1.6 ms/frame (was 3.2 ms before baking the
  Milky Way noise into a texture). `nightSky.bench(n, dpr)` in the console measures it.
- Frame rate: full speed only while the view moves; ~30 fps when idle or narrating, leaving
  GPU/CPU for the voice model.
- Adaptive resolution: drops the pixel ratio in 0.25 steps if the frame rate falls under ~40 fps while moving.
- Audio uses `latencyHint: 'playback'` (larger buffers) so speech doesn't crackle when the CPU is busy.
- `serve.py` / `vercel.json` send COOP/COEP (cross-origin isolation), which lets ONNX Runtime's WASM backend use threads by default.

## Data

`scripts/generate_data.py` builds both files:

- `data/stars.json` — 8,872 stars (all with mag ≤ 6.5 plus every figure star) from
  the HYG v3.6.1 catalogue (astronexus/HYG-Database): position, magnitude,
  colour index, distance (ly), spectral type, proper name, Bayer/Flamsteed designation.
- `data/constellations.json` — the 88 IAU constellations: stick figures (HIP
  polylines) from Stellarium's *modern* sky culture, genitive and area from
  Wikipedia's "IAU designated constellations" table, and a summary from the
  Wikipedia REST API.

External services at runtime: `api.bigdatacloud.net` (place name for your
coordinates) and, only if geolocation is refused, `ipapi.co` (approximate location).

## Deploy

Static site, no build step. `vercel.json` adds the COOP/COEP headers (multi-threaded WASM for the
voice fallback); `.vercelignore` leaves out dev-only files. `vercel deploy --prod` publishes it.

## Files

- `index.html`, `style.css`, `main.js` — the app (no build step)
- `vendor/three.module.js`, `vendor/three.core.js` — Three.js 0.187.0
- `serve.py` — tiny no-cache, cross-origin-isolated static server (`--lan` for phones)
- `vercel.json`, `.vercelignore` — Vercel deployment config
- `speech.js`, `tts-worker.js`, `vendor/kokoro/` — in-browser narration voice

## Roadmap (planned extensions)

- **AI planetarium assistant** — ask questions by voice or text about what you're looking at
  (constellations, stars, planets); answers grounded in the live sky data (`window.nightSky`)
  and spoken with the Kokoro voice.
- **Voice questions with Whisper** — free speech-to-text in the browser (transformers.js,
  whisper-tiny/base on WebGPU) feeding the assistant.
- **Planets, Moon and Sun** in the sky (an ephemeris such as astronomy-engine), so the
  assistant can answer planet-specific questions.
- **"Point your phone at the sky"** — orient the view with the phone's compass/gyroscope
  (DeviceOrientation; needs HTTPS).
