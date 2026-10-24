<img src="assets/icon.svg" width="56" height="56" alt="music2piano icon">

# music2piano

**Symbolic Audio-to-Grand-Piano Arrangement Studio** — convert any song (`.mp3`, `.wav`, `.flac`, `.m4a`, `.ogg`, or `.mid`) into an expressive solo piano arrangement rendered through real multi-velocity **Yamaha C5 Salamander Grand Piano V3** recordings.

100% client-side in the browser (Web Audio + Web Workers + TensorFlow.js). Zero backend required, zero generative AI audio artifacts, and ready to deploy directly to **GitHub Pages**.

---

## How It Avoids "AI Slop"

Instead of using generative audio models that produce warbly, low-bitrate waveforms or hallucinated bars, `music2piano` uses a deterministic **symbolic + acoustic sample** pipeline:

1. **Harmonic-Percussive Source Separation (HPSS)** (`src/audio/dsp.js`): Strips drums, snares, and hi-hat transients in the STFT domain before pitch detection so percussion doesn't turn into random piano clusters.
2. **Beat, Tempo & Chroma Harmony Tracking** (`src/audio/dsp.js`): Locks onto the song's BPM, beat grid, key signature, and harmonic chord-change boundaries.
3. **Polyphonic Neural Pitch Transcription** (`src/workers/transcribe-worker.js`): Runs Spotify's `@spotify/basic-pitch` off-thread in a Web Worker using locally hosted neural weights (`assets/model/`).
4. **Two-Hand Piano Cover Arranger** (`src/audio/arranger.js`):
   - Heals vibrato-split vocal fragments into sustained singing piano notes.
   - Separates the top-line lead melody in the right hand with dynamic velocity layering.
   - Filters muddy narrow intervals below `C3` into clean root/5th/octave left-hand bass voicings.
   - Generates authentic **Damper Sustain Pedal (`CC64`)** lifts and re-pedals on detected chord changes.
5. **4-Velocity-Layer Acoustic Grand Piano Engine** (`src/audio/piano-engine.js`):
   - Streams & caches real **Yamaha C5 Salamander Grand Piano V3** recordings across 4 dynamic hammer-strike layers (`pp`, `mp`, `mf`, `ff`) + real mechanical damper pedal sounds (`CC-BY-3.0`, Alexander Holm).
   - Models undamped upper strings (`A6–C8`), felt-damper release curves, stereo soundboard perspective, and a Concert Hall impulse response.
   - Exports **24-bit / 48 kHz stereo `.wav`** (rendered faster-than-realtime via `OfflineAudioContext`) and **Format 1 `.mid`** (with separate Right/Left Hand tracks + `CC64` sustain pedal for Logic, Ableton, GarageBand, Pianoteq, or MuseScore).

---

## Run Locally

No build step or Node installation is required:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

---

## Deploy to GitHub Pages

This repository includes `.nojekyll`, relative asset paths (works at both root domains and `/<repo-name>/` subpaths), and an automated GitHub Actions workflow at `.github/workflows/deploy.yml`:

1. Push this repository to GitHub (`main` branch).
2. In your GitHub repo, go to **Settings → Pages**.
3. Under **Build and deployment → Source**, select **GitHub Actions** (or **Deploy from a branch → `main` / `/ (root)`** — both work out of the box!).
