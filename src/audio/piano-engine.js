/**
 * Acoustic Grand Piano Studio Engine (Live WebAudio + 48kHz Offline WAV Renderer)
 *
 * Uses real multi-velocity recordings of a Yamaha C5 Grand Piano (Salamander Grand Piano V3, CC-BY-3.0):
 * - 4 distinct recorded hammer-velocity layers: v3 (pp), v7 (mp), v11 (mf), v15 (ff)
 * - 30 chromatic minor-third anchor pitches per layer (A0..C8, max pitch shift +/- 1 semitone)
 * - Real mechanical damper pedal down/up recordings (round-robin)
 * - Authentic damper & CC64 sustain pedal physics + undamped top register (A6..C8)
 * - True-stereo Concert Hall Impulse Response + 3 Piano Characters (Concert Grand, Intimate Felt, Bright Studio)
 * - Synchronized A/B playback against the user's original song
 */

const CACHE_NAME = 'music2piano-salamander-v1';
const VELOCITY_LAYERS = [7, 11, 3, 15]; // Load v7 (core mp/mf) first for instant startup, then hydrate v11, v3, v15

// Build the exact 30 Salamander anchor descriptors: { name: 'F#4', midi: 66 }
export const SALAMANDER_ANCHORS = (() => {
  const list = [{ name: 'A0', midi: 21 }];
  for (let oct = 1; oct <= 7; oct++) {
    const base = 12 * (oct + 1);
    list.push({ name: `C${oct}`, midi: base });
    list.push({ name: `D#${oct}`, midi: base + 3 });
    list.push({ name: `F#${oct}`, midi: base + 6 });
    list.push({ name: `A${oct}`, midi: base + 9 });
  }
  list.push({ name: 'C8', midi: 108 });
  return list;
})();

const PEDAL_FILES = ['pedalD1', 'pedalD2', 'pedalU1', 'pedalU2'];

export const PIANO_CHARACTERS = {
  concert: {
    label: 'Concert Grand (Yamaha C5)',
    velBias: 0,
    filterBaseHz: 2600,
    filterMaxHz: 18500,
    reverbSend: 0.28,
    pedalNoiseGain: 0.045,
    eqLowGain: 1.2,
    eqHighGain: 1.0,
    hallDecay: 2.35,
  },
  felt: {
    label: 'Intimate Felt Piano',
    velBias: -22, // Shifts hammer strikes into softer felt layers (v3 & v7)
    filterBaseHz: 1150,
    filterMaxHz: 5400,
    reverbSend: 0.38,
    pedalNoiseGain: 0.075,
    eqLowGain: 2.0,
    eqHighGain: -3.5,
    hallDecay: 2.9,
  },
  studio: {
    label: 'Bright Studio Pop Grand',
    velBias: 10,
    filterBaseHz: 3800,
    filterMaxHz: 20000,
    reverbSend: 0.19,
    pedalNoiseGain: 0.025,
    eqLowGain: 0.6,
    eqHighGain: 2.6,
    hallDecay: 1.65,
  },
};

function sampleUrlForNote(noteName, layer) {
  const encoded = noteName.replace('#', '%23');
  return `https://cdn.jsdelivr.net/npm/@audio-samples/piano-mp3-velocity${layer}@1.0.5/audio/${encoded}v${layer}.mp3`;
}

function sampleUrlForPedal(name) {
  return `https://cdn.jsdelivr.net/npm/@audio-samples/piano-mp3-pedals@1.0.5/audio/${name}.mp3`;
}

async function fetchSampleArrayBuffer(url) {
  if (typeof caches !== 'undefined') {
    try {
      const cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(url);
      if (hit) return await hit.arrayBuffer();
      const res = await fetch(url, { mode: 'cors' });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      cache.put(url, res.clone()).catch(() => {});
      return await res.arrayBuffer();
    } catch {
      // Fallback to direct fetch if CacheStorage is restricted (e.g. private browsing)
    }
  }
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.arrayBuffer();
}

/**
 * Generates a realistic stereo Concert Hall impulse response with wooden stage early reflections
 * and frequency-damped exponential velvet reverb tail.
 */
function createConcertHallImpulse(ctx, decaySeconds = 2.35) {
  const sr = ctx.sampleRate;
  const length = Math.floor(sr * decaySeconds);
  const impulse = ctx.createBuffer(2, length, sr);
  const left = impulse.getChannelData(0);
  const right = impulse.getChannelData(1);

  // Discrete wooden concert stage early reflections (ms, pan, gain)
  const earlyReflections = [
    { ms: 12.4, gainL: 0.26, gainR: 0.14 },
    { ms: 19.1, gainL: 0.13, gainR: 0.25 },
    { ms: 28.7, gainL: 0.20, gainR: 0.18 },
    { ms: 39.3, gainL: 0.14, gainR: 0.21 },
    { ms: 52.8, gainL: 0.15, gainR: 0.15 },
    { ms: 68.5, gainL: 0.11, gainR: 0.13 },
  ];

  for (const er of earlyReflections) {
    const idx = Math.floor((er.ms / 1000) * sr);
    if (idx < length) {
      left[idx] += er.gainL;
      right[idx] += er.gainR;
    }
  }

  // Smooth pre-delay buildup (16ms) + air-damped stereo diffuse tail
  const preDelaySamples = Math.floor(0.016 * sr);
  let lpL = 0;
  let lpR = 0;

  for (let i = preDelaySamples; i < length; i++) {
    const t = (i - preDelaySamples) / (length - preDelaySamples);
    const fadeIn = Math.min(1, (i - preDelaySamples) / (0.025 * sr));
    const env = Math.pow(1 - t, 2.8) * Math.exp(-3.2 * t) * fadeIn;

    // Progressive high-frequency air absorption over time
    const damp = 0.18 + 0.55 * (1 - t);
    const whiteL = (Math.random() * 2 - 1) * 0.24;
    const whiteR = (Math.random() * 2 - 1) * 0.24;

    lpL = lpL + damp * (whiteL - lpL);
    lpR = lpR + damp * (whiteR - lpR);

    left[i] += lpL * env;
    right[i] += lpR * env;
  }

  return impulse;
}

/**
 * Finds closest recorded Salamander anchor for a MIDI note (max |detune| <= 1 semitone, +2 for B0).
 */
function findClosestAnchor(midi) {
  const clamped = Math.max(21, Math.min(108, Math.round(midi)));
  let best = SALAMANDER_ANCHORS[0];
  let bestDist = Math.abs(clamped - best.midi);
  for (let i = 1; i < SALAMANDER_ANCHORS.length; i++) {
    const d = Math.abs(clamped - SALAMANDER_ANCHORS[i].midi);
    if (d < bestDist) {
      best = SALAMANDER_ANCHORS[i];
      bestDist = d;
    }
  }
  return { anchor: best, semitoneOffset: clamped - best.midi };
}

/**
 * Computes exact acoustic string ring-out end time accounting for CC64 sustain pedal,
 * undamped high register (A6..C8), and same-pitch key re-strikes.
 */
function computeAcousticRingEnd(note, nextSamePitchStart, pedalIntervals) {
  const noteEnd = note.startTime + note.duration;

  // Real grand pianos have NO dampers from A6 (MIDI 93) to C8 (MIDI 108)
  if (note.pitch >= 93) {
    const naturalCap = note.startTime + 6.5;
    return nextSamePitchStart ? Math.min(naturalCap, nextSamePitchStart - 0.01) : naturalCap;
  }

  let ringEnd = noteEnd;
  // Check if sustain pedal is depressed at or during noteEnd
  for (let i = 0; i < pedalIntervals.length; i++) {
    const ped = pedalIntervals[i];
    if (ped.endTime < noteEnd - 0.02) continue;
    if (ped.startTime <= ringEnd + 0.03 && ped.endTime > ringEnd) {
      ringEnd = ped.endTime;
    } else if (ped.startTime > ringEnd + 0.03) {
      break;
    }
  }

  const maxStringDecay = note.startTime + 10.5;
  ringEnd = Math.min(ringEnd, maxStringDecay);
  if (nextSamePitchStart && nextSamePitchStart > note.startTime + 0.04) {
    ringEnd = Math.min(ringEnd, nextSamePitchStart - 0.008);
  }
  return Math.max(note.startTime + 0.06, ringEnd);
}

export class AcousticPianoEngine {
  constructor(onSampleStatus = () => {}) {
    this.ctx = null;
    this.onSampleStatus = onSampleStatus;

    // Map<layerNumber, Map<anchorName, AudioBuffer>>
    this.layerBuffers = new Map();
    for (const l of VELOCITY_LAYERS) this.layerBuffers.set(l, new Map());
    this.pedalBuffers = new Map();

    this.coreReadyPromise = null;
    this.fullReadyPromise = null;
    this.loadedCount = 0;
    this.totalCount = VELOCITY_LAYERS.length * SALAMANDER_ANCHORS.length + PEDAL_FILES.length; // 124

    this.characterKey = 'concert';
    this.reverbMix = 0.28;
    this.pianoVolume = 0.92;
    this.originalVolume = 0.75;
    this.monitorMode = 'piano'; // 'piano' | 'blend' | 'original'

    // Arrangement & Original Audio state
    this.notes = [];
    this.pedalIntervals = [];
    this.nextSamePitchMap = new Map();
    this.duration = 0;
    this.originalBuffer = null;

    // Transport & Lookahead Scheduler state
    this.isPlaying = false;
    this.playStartCtxTime = 0;
    this.playStartOffset = 0;
    this.nextNoteIdx = 0;
    this.nextPedalIdx = 0;
    this.schedulerTimer = null;
    this.activeSources = new Set();
    this.originalSourceNode = null;
    this.liveHeldSources = new Map();
    this.onPlaybackEnded = null;
  }

  ensureContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx({ latencyHint: 'interactive' });
      this._buildMasterBus();
    }
    return this.ctx;
  }

  _buildMasterBus() {
    const ctx = this.ctx;
    const char = PIANO_CHARACTERS[this.characterKey];

    this.pianoDryBus = ctx.createGain();
    this.pianoReverbSend = ctx.createGain();
    this.convolver = ctx.createConvolver();
    this.convolver.buffer = createConcertHallImpulse(ctx, char.hallDecay);

    this.eqHighPass = ctx.createBiquadFilter();
    this.eqHighPass.type = 'highpass';
    this.eqHighPass.frequency.value = 26;

    this.eqWarmth = ctx.createBiquadFilter();
    this.eqWarmth.type = 'lowshelf';
    this.eqWarmth.frequency.value = 185;
    this.eqWarmth.gain.value = char.eqLowGain;

    this.eqAir = ctx.createBiquadFilter();
    this.eqAir.type = 'highshelf';
    this.eqAir.frequency.value = 6200;
    this.eqAir.gain.value = char.eqHighGain;

    this.pianoMasterGain = ctx.createGain();

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -2.4;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.14;

    this.originalGain = ctx.createGain();

    // Signal routing
    this.pianoDryBus.connect(this.eqHighPass);
    this.pianoReverbSend.connect(this.convolver);
    this.convolver.connect(this.eqHighPass);

    this.eqHighPass
      .connect(this.eqWarmth)
      .connect(this.eqAir)
      .connect(this.pianoMasterGain)
      .connect(this.limiter)
      .connect(ctx.destination);

    this.originalGain.connect(this.limiter);

    this._applyMixGains();
  }

  _applyMixGains() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const wantPiano = this.monitorMode === 'piano' || this.monitorMode === 'blend';
    const wantOrig = this.monitorMode === 'original' || this.monitorMode === 'blend';

    const pGain = wantPiano ? this.pianoVolume : 0.0;
    const oGain = wantOrig ? (this.monitorMode === 'blend' ? this.originalVolume * 0.48 : this.originalVolume) : 0.0;

    this.pianoMasterGain.gain.setTargetAtTime(pGain, now, 0.02);
    this.originalGain.gain.setTargetAtTime(oGain, now, 0.02);
    this.pianoReverbSend.gain.setTargetAtTime(this.reverbMix, now, 0.03);
    this.pianoDryBus.gain.setTargetAtTime(1.0 - this.reverbMix * 0.22, now, 0.03);
  }

  setMonitorMode(mode) {
    this.monitorMode = mode;
    this._applyMixGains();
  }

  setReverbMix(mix) {
    this.reverbMix = Math.max(0, Math.min(0.85, mix));
    this._applyMixGains();
  }

  setCharacter(key) {
    if (!PIANO_CHARACTERS[key]) return;
    this.characterKey = key;
    const char = PIANO_CHARACTERS[key];
    this.reverbMix = char.reverbSend;
    if (this.ctx) {
      this.eqWarmth.gain.setTargetAtTime(char.eqLowGain, this.ctx.currentTime, 0.04);
      this.eqAir.gain.setTargetAtTime(char.eqHighGain, this.ctx.currentTime, 0.04);
      this.convolver.buffer = createConcertHallImpulse(this.ctx, char.hallDecay);
      this._applyMixGains();
    }
  }

  /**
   * Starts loading the core Salamander Grand Piano layer immediately and hydrates remaining 3 dynamic layers in background.
   */
  async initSamples() {
    const ctx = this.ensureContext();
    if (this.coreReadyPromise) return this.coreReadyPromise;

    const loadBatch = async (tasks, concurrency = 8) => {
      let i = 0;
      const workers = Array.from({ length: concurrency }, async () => {
        while (i < tasks.length) {
          const task = tasks[i++];
          await task();
          this.loadedCount++;
          this.onSampleStatus({
            loaded: this.loadedCount,
            total: this.totalCount,
            progress: this.loadedCount / this.totalCount,
            coreReady: this.layerBuffers.get(7).size === SALAMANDER_ANCHORS.length,
            allLayersReady: this.loadedCount >= this.totalCount,
          });
        }
      });
      await Promise.all(workers);
    };

    // Stage 1: Core velocity7 + mechanical pedals (instant playability)
    this.coreReadyPromise = (async () => {
      const coreTasks = [];
      for (const anchor of SALAMANDER_ANCHORS) {
        coreTasks.push(async () => {
          const ab = await fetchSampleArrayBuffer(sampleUrlForNote(anchor.name, 7));
          const audioBuf = await ctx.decodeAudioData(ab.slice(0));
          this.layerBuffers.get(7).set(anchor.name, audioBuf);
        });
      }
      for (const pf of PEDAL_FILES) {
        coreTasks.push(async () => {
          const ab = await fetchSampleArrayBuffer(sampleUrlForPedal(pf));
          const audioBuf = await ctx.decodeAudioData(ab.slice(0));
          this.pedalBuffers.set(pf, audioBuf);
        });
      }
      await loadBatch(coreTasks, 10);

      // Kick off background hydration of v11 (mf), v3 (pp), and v15 (ff)
      this.fullReadyPromise = (async () => {
        const extraTasks = [];
        for (const layer of [11, 3, 15]) {
          for (const anchor of SALAMANDER_ANCHORS) {
            extraTasks.push(async () => {
              const ab = await fetchSampleArrayBuffer(sampleUrlForNote(anchor.name, layer));
              const audioBuf = await ctx.decodeAudioData(ab.slice(0));
              this.layerBuffers.get(layer).set(anchor.name, audioBuf);
            });
          }
        }
        await loadBatch(extraTasks, 6);
      })();
    })();

    return this.coreReadyPromise;
  }

  async ensureAllLayersLoaded() {
    await this.initSamples();
    if (this.fullReadyPromise) {
      await this.fullReadyPromise;
    }
  }

  _pickVelocityBuffer(anchorName, effectiveVel) {
    let targetLayer = 7;
    if (effectiveVel <= 44) targetLayer = 3;
    else if (effectiveVel <= 76) targetLayer = 7;
    else if (effectiveVel <= 102) targetLayer = 11;
    else targetLayer = 15;

    const preferred = this.layerBuffers.get(targetLayer)?.get(anchorName);
    if (preferred) return { buffer: preferred, actualLayer: targetLayer };

    // Fallback to nearest hydrated layer while background streaming finishes
    for (const fallback of [7, 11, 3, 15]) {
      const buf = this.layerBuffers.get(fallback)?.get(anchorName);
      if (buf) return { buffer: buf, actualLayer: fallback };
    }
    return { buffer: null, actualLayer: 7 };
  }

  setArrangement({ notes, pedalIntervals }, durationSec) {
    this.notes = notes || [];
    this.pedalIntervals = pedalIntervals || [];

    // Precompute next same-pitch onset for clean string re-strike damping
    this.nextSamePitchMap.clear();
    const lastSeen = new Map();
    for (let i = this.notes.length - 1; i >= 0; i--) {
      const n = this.notes[i];
      const nextStart = lastSeen.get(n.pitch) || null;
      this.nextSamePitchMap.set(n.id, nextStart);
      lastSeen.set(n.pitch, n.startTime);
    }

    const lastNoteEnd = this.notes.length
      ? Math.max(...this.notes.map((n) => n.startTime + n.duration)) + 1.2
      : 0;
    this.duration = Math.max(durationSec || 0, lastNoteEnd);

    // Re-index lookahead pointer if currently playing so live parameter tweaks apply seamlessly!
    if (this.isPlaying) {
      const nowSong = this.getCurrentTime() + 0.05;
      this.nextNoteIdx = this.notes.findIndex((n) => n.startTime >= nowSong);
      if (this.nextNoteIdx === -1) this.nextNoteIdx = this.notes.length;
    }
  }

  setOriginalAudioBuffer(audioBuffer) {
    this.originalBuffer = audioBuffer;
    if (audioBuffer) {
      this.duration = Math.max(this.duration, audioBuffer.duration);
    }
  }

  getCurrentTime() {
    if (!this.isPlaying || !this.ctx) return this.playStartOffset;
    return Math.min(this.duration, this.playStartOffset + (this.ctx.currentTime - this.playStartCtxTime));
  }

  async play(fromOffset = this.playStartOffset) {
    const ctx = this.ensureContext();
    await this.initSamples();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    this.stopVoicesOnly();
    const offset = Math.max(0, Math.min(this.duration > 0.2 ? this.duration - 0.05 : 0, fromOffset));
    this.playStartOffset = offset;
    this.playStartCtxTime = ctx.currentTime + 0.03;
    this.isPlaying = true;

    this.nextNoteIdx = this.notes.findIndex((n) => n.startTime >= offset - 0.005);
    if (this.nextNoteIdx === -1) this.nextNoteIdx = this.notes.length;

    this.nextPedalIdx = this.pedalIntervals.findIndex((p) => p.startTime >= offset - 0.005);
    if (this.nextPedalIdx === -1) this.nextPedalIdx = this.pedalIntervals.length;

    // Start original song buffer in sample-accurate lockstep for instant A/B comparison!
    if (this.originalBuffer && offset < this.originalBuffer.duration) {
      const origSrc = ctx.createBufferSource();
      origSrc.buffer = this.originalBuffer;
      origSrc.connect(this.originalGain);
      origSrc.start(this.playStartCtxTime, offset);
      this.originalSourceNode = origSrc;
    }

    this._runSchedulerTick();
    this.schedulerTimer = window.setInterval(() => this._runSchedulerTick(), 40);
  }

  pause() {
    if (!this.isPlaying) return;
    this.playStartOffset = this.getCurrentTime();
    this.isPlaying = false;
    this.stopVoicesOnly();
  }

  seek(timeSec) {
    const clamped = Math.max(0, Math.min(this.duration, timeSec));
    if (this.isPlaying) {
      this.play(clamped);
    } else {
      this.playStartOffset = clamped;
    }
  }

  stopVoicesOnly() {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    if (this.originalSourceNode) {
      try {
        this.originalSourceNode.stop();
        this.originalSourceNode.disconnect();
      } catch {}
      this.originalSourceNode = null;
    }
    if (this.ctx) {
      const now = this.ctx.currentTime;
      for (const entry of this.activeSources) {
        try {
          entry.gainNode.gain.cancelScheduledValues(now);
          entry.gainNode.gain.setValueAtTime(entry.gainNode.gain.value, now);
          entry.gainNode.gain.exponentialRampToValueAtTime(0.0001, now + 0.045);
          entry.source.stop(now + 0.05);
        } catch {}
      }
    }
    this.activeSources.clear();
  }

  _runSchedulerTick() {
    if (!this.isPlaying || !this.ctx) return;

    const currentSongTime = this.getCurrentTime();
    if (currentSongTime >= this.duration && this.duration > 0) {
      this.isPlaying = false;
      this.playStartOffset = 0;
      this.stopVoicesOnly();
      if (this.onPlaybackEnded) this.onPlaybackEnded();
      return;
    }

    const lookaheadSongEnd = currentSongTime + 0.24;

    while (this.nextNoteIdx < this.notes.length) {
      const note = this.notes[this.nextNoteIdx];
      if (note.startTime > lookaheadSongEnd) break;
      const whenCtx = this.playStartCtxTime + (note.startTime - this.playStartOffset);
      if (whenCtx >= this.ctx.currentTime - 0.02) {
        const ringEndSong = computeAcousticRingEnd(
          note,
          this.nextSamePitchMap.get(note.id),
          this.pedalIntervals
        );
        const ringDur = Math.max(0.06, ringEndSong - note.startTime);
        this._scheduleSingleNoteOnContext(
          this.ctx,
          this.pianoDryBus,
          this.pianoReverbSend,
          note.pitch,
          note.velocity,
          Math.max(this.ctx.currentTime, whenCtx),
          ringDur,
          true
        );
      }
      this.nextNoteIdx++;
    }

    // Subtle mechanical damper pedal down/up acoustics
    const char = PIANO_CHARACTERS[this.characterKey];
    while (this.nextPedalIdx < this.pedalIntervals.length) {
      const ped = this.pedalIntervals[this.nextPedalIdx];
      if (ped.startTime > lookaheadSongEnd) break;
      const whenDown = this.playStartCtxTime + (ped.startTime - this.playStartOffset);
      if (whenDown >= this.ctx.currentTime && char.pedalNoiseGain > 0.005) {
        this._schedulePedalSound(
          this.ctx,
          this.pianoDryBus,
          this.nextPedalIdx % 2 === 0 ? 'pedalD1' : 'pedalD2',
          whenDown,
          char.pedalNoiseGain
        );
      }
      this.nextPedalIdx++;
    }
  }

  _schedulePedalSound(ctx, dest, key, when, gainVal) {
    const buf = this.pedalBuffers.get(key);
    if (!buf) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = gainVal;
    src.connect(g).connect(dest);
    src.start(when);
  }

  _scheduleSingleNoteOnContext(ctx, dryDest, reverbDest, pitch, velocity, startTime, ringDuration, trackLive = false) {
    const { anchor, semitoneOffset } = findClosestAnchor(pitch);
    const char = PIANO_CHARACTERS[this.characterKey];
    const effVel = Math.max(12, Math.min(127, velocity + char.velBias));

    const { buffer } = this._pickVelocityBuffer(anchor.name, effVel);
    if (!buffer) return null;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    if (semitoneOffset !== 0) {
      source.playbackRate.setValueAtTime(Math.pow(2, semitoneOffset / 12), startTime);
    }

    // Dynamic hammer-brightness lowpass filter
    const velNorm = (velocity - 1) / 126;
    const cutoff = char.filterBaseHz + Math.pow(velNorm, 1.35) * (char.filterMaxHz - char.filterBaseHz);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(Math.min(ctx.sampleRate * 0.47, cutoff), startTime);
    filter.Q.value = 0.35;

    // Natural grand piano soundboard stereo perspective (-0.30 low bass -> +0.30 high treble)
    const panVal = ((Math.max(21, Math.min(108, pitch)) - 21) / 87) * 0.6 - 0.3;
    const panner = ctx.createStereoPanner();
    panner.pan.setValueAtTime(panVal, startTime);

    // Fine dynamic gain envelope + authentic felt-damper release
    const gainNode = ctx.createGain();
    const noteGain = 0.16 + Math.pow(velNorm, 1.45) * 0.68;

    // Heavy bass dampers take slightly longer (~230ms) to mute vibrating wound strings than treble dampers (~105ms)
    const damperRelease = pitch >= 93 ? 0.45 : pitch < 48 ? 0.23 : pitch < 72 ? 0.15 : 0.105;
    const dampStart = startTime + ringDuration;
    const stopTime = dampStart + damperRelease + 0.02;

    gainNode.gain.setValueAtTime(0.0001, startTime);
    gainNode.gain.linearRampToValueAtTime(noteGain, startTime + 0.003);
    gainNode.gain.setValueAtTime(noteGain, dampStart);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, dampStart + damperRelease);

    source.connect(filter).connect(panner).connect(gainNode);
    gainNode.connect(dryDest);
    gainNode.connect(reverbDest);

    source.start(startTime);
    source.stop(Math.min(startTime + buffer.duration + 0.1, stopTime));

    if (trackLive) {
      const entry = { source, gainNode };
      this.activeSources.add(entry);
      source.onended = () => {
        this.activeSources.delete(entry);
      };
    }

    return { source, gainNode };
  }

  /**
   * Audition a single piano key interactively (mouse click / computer keyboard).
   */
  async noteOnInteractive(pitch, velocity = 92) {
    const ctx = this.ensureContext();
    await this.initSamples();
    if (ctx.state === 'suspended') await ctx.resume();

    this.noteOffInteractive(pitch);
    const now = ctx.currentTime;
    const voice = this._scheduleSingleNoteOnContext(
      ctx,
      this.pianoDryBus,
      this.pianoReverbSend,
      pitch,
      velocity,
      now,
      8.0,
      false
    );
    if (voice) {
      this.liveHeldSources.set(pitch, voice);
    }
  }

  noteOffInteractive(pitch) {
    const voice = this.liveHeldSources.get(pitch);
    if (!voice || !this.ctx) return;
    this.liveHeldSources.delete(pitch);
    const now = this.ctx.currentTime;
    const rel = pitch >= 93 ? 1.2 : pitch < 48 ? 0.24 : 0.15;
    try {
      voice.gainNode.gain.cancelScheduledValues(now);
      voice.gainNode.gain.setValueAtTime(Math.max(0.0002, voice.gainNode.gain.value), now);
      voice.gainNode.gain.exponentialRampToValueAtTime(0.0001, now + rel);
      voice.source.stop(now + rel + 0.03);
    } catch {}
  }

  /**
   * Renders the full arranged performance faster-than-realtime at studio 48 kHz using all 4 Salamander velocity layers.
   */
  async renderOfflineStudioAudio(onProgress = () => {}) {
    onProgress(0.05, 'Ensuring all 4 velocity layers of Salamander Grand Piano are loaded...');
    await this.ensureAllLayersLoaded();

    const sampleRate = 48000;
    const char = PIANO_CHARACTERS[this.characterKey];
    const lastEnd = this.notes.length
      ? Math.max(...this.notes.map((n) => n.startTime + n.duration))
      : 1;
    const totalDuration = Math.max(2.0, lastEnd + char.hallDecay + 1.2);
    const totalFrames = Math.ceil(totalDuration * sampleRate);

    onProgress(0.25, 'Building 48 kHz studio acoustic piano & concert hall graph...');
    const offline = new OfflineAudioContext(2, totalFrames, sampleRate);

    const dryBus = offline.createGain();
    dryBus.gain.value = 1.0 - this.reverbMix * 0.22;

    const reverbSend = offline.createGain();
    reverbSend.gain.value = this.reverbMix;

    const convolver = offline.createConvolver();
    convolver.buffer = createConcertHallImpulse(offline, char.hallDecay);

    const hp = offline.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 26;

    const warmth = offline.createBiquadFilter();
    warmth.type = 'lowshelf';
    warmth.frequency.value = 185;
    warmth.gain.value = char.eqLowGain;

    const air = offline.createBiquadFilter();
    air.type = 'highshelf';
    air.frequency.value = 6200;
    air.gain.value = char.eqHighGain;

    const masterGain = offline.createGain();
    masterGain.gain.value = 0.92;

    const limiter = offline.createDynamicsCompressor();
    limiter.threshold.value = -2.0;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.14;

    dryBus.connect(hp);
    reverbSend.connect(convolver);
    convolver.connect(hp);
    hp.connect(warmth).connect(air).connect(masterGain).connect(limiter).connect(offline.destination);

    onProgress(0.45, `Scheduling ${this.notes.length} multi-velocity piano notes & sustain pedal events...`);

    const leadIn = 0.08;
    for (const note of this.notes) {
      const ringEnd = computeAcousticRingEnd(note, this.nextSamePitchMap.get(note.id), this.pedalIntervals);
      const ringDur = Math.max(0.06, ringEnd - note.startTime);
      this._scheduleSingleNoteOnContext(
        offline,
        dryBus,
        reverbSend,
        note.pitch,
        note.velocity,
        leadIn + note.startTime,
        ringDur,
        false
      );
    }

    if (char.pedalNoiseGain > 0.005) {
      this.pedalIntervals.forEach((ped, idx) => {
        this._schedulePedalSound(
          offline,
          dryBus,
          idx % 2 === 0 ? 'pedalD1' : 'pedalD2',
          leadIn + ped.startTime,
          char.pedalNoiseGain
        );
        this._schedulePedalSound(
          offline,
          dryBus,
          idx % 2 === 0 ? 'pedalU1' : 'pedalU2',
          leadIn + ped.endTime,
          char.pedalNoiseGain * 0.7
        );
      });
    }

    onProgress(0.65, 'Rendering 24-bit studio acoustic piano audio...');
    const rendered = await offline.startRendering();
    onProgress(1.0, 'Render complete');
    return rendered;
  }
}
