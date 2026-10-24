import { arrangeForPiano, DEFAULT_ARRANGEMENT_SETTINGS } from './audio/arranger.js';
import { AcousticPianoEngine, PIANO_CHARACTERS } from './audio/piano-engine.js';
import { NeuralTranscriber } from './audio/neural-transcriber.js';
import { encodeArrangedMidi, parseMidiFile } from './audio/midi-io.js';
import { encodeAudioBufferToWav24 } from './audio/wav-encoder.js';
import { generateDemoBandTrack } from './audio/demo-song.js';
import { PianoVisualizer } from './ui/visualizer.js';

// DOM Elements
const el = {
  sampleDot: document.getElementById('sampleStatusDot'),
  sampleText: document.getElementById('sampleStatusText'),
  songMetrics: document.getElementById('songMetrics'),
  metricBpm: document.getElementById('metricBpm'),
  metricKey: document.getElementById('metricKey'),
  metricNotes: document.getElementById('metricNotes'),
  metricPedals: document.getElementById('metricPedals'),

  exportMidiBtn: document.getElementById('exportMidiBtn'),
  exportWavBtn: document.getElementById('exportWavBtn'),
  exportWavLabel: document.getElementById('exportWavLabel'),

  dropZone: document.getElementById('dropZone'),
  fileInput: document.getElementById('fileInput'),
  chooseFileBtn: document.getElementById('chooseFileBtn'),
  demoSongBtn: document.getElementById('demoSongBtn'),
  sourceBadge: document.getElementById('sourceBadge'),
  sourceTitle: document.getElementById('sourceTitle'),
  sourceHint: document.getElementById('sourceHint'),

  progressDrawer: document.getElementById('progressDrawer'),
  progressStageText: document.getElementById('progressStageText'),
  progressPercentText: document.getElementById('progressPercentText'),
  progressFill: document.getElementById('progressFill'),

  timelineCanvas: document.getElementById('timelineCanvas'),
  rollCanvas: document.getElementById('rollCanvas'),

  restartBtn: document.getElementById('restartBtn'),
  playPauseBtn: document.getElementById('playPauseBtn'),
  playIcon: document.getElementById('playIcon'),
  pauseIcon: document.getElementById('pauseIcon'),
  currentTimeText: document.getElementById('currentTimeText'),
  totalTimeText: document.getElementById('totalTimeText'),

  monitorSegmented: document.getElementById('monitorSegmented'),
  monitorBlendBtn: document.getElementById('monitorBlendBtn'),
  monitorOrigBtn: document.getElementById('monitorOrigBtn'),

  characterGrid: document.getElementById('characterGrid'),
  reverbSlider: document.getElementById('reverbSlider'),
  reverbVal: document.getElementById('reverbVal'),

  styleSegmented: document.getElementById('styleSegmented'),
  melodySlider: document.getElementById('melodySlider'),
  melodyVal: document.getElementById('melodyVal'),
  densitySlider: document.getElementById('densitySlider'),
  densityVal: document.getElementById('densityVal'),
  quantizeSlider: document.getElementById('quantizeSlider'),
  quantizeVal: document.getElementById('quantizeVal'),
  pedalSegmented: document.getElementById('pedalSegmented'),
  transDownBtn: document.getElementById('transDownBtn'),
  transUpBtn: document.getElementById('transUpBtn'),
  transposeVal: document.getElementById('transposeVal'),
  octaveCheck: document.getElementById('octaveCheck'),

  sensitivitySlider: document.getElementById('sensitivitySlider'),
  sensitivityVal: document.getElementById('sensitivityVal'),
  drumSlider: document.getElementById('drumSlider'),
  drumVal: document.getElementById('drumVal'),
  reanalyzeBtn: document.getElementById('reanalyzeBtn'),
};

// Application State
const state = {
  trackBaseName: 'piano-arrangement',
  hasAudioSource: false,
  mono22kSamples: null,
  rawNotes: [],
  analysis: null,
  arrangement: null,
  isBusy: false,
  activeJobId: 0,
  lastAnalyzedDrumRejection: 0.65,
  settings: { ...DEFAULT_ARRANGEMENT_SETTINGS },
  extraction: {
    sensitivity: 0.55,
    drumRejection: 0.65,
  },
};

const neuralTranscriber = new NeuralTranscriber();

// Initialize Acoustic Piano Engine
const pianoEngine = new AcousticPianoEngine((status) => {
  if (status.allLayersReady) {
    el.sampleDot.className = 'status-dot ready';
    el.sampleText.textContent = 'Yamaha C5 Grand • 4/4 Velocity Layers Ready';
  } else if (status.coreReady) {
    el.sampleDot.className = 'status-dot ready';
    const pct = Math.round(status.progress * 100);
    el.sampleText.textContent = `Yamaha C5 Ready (Hydrating Dynamics ${pct}%)`;
  } else {
    el.sampleDot.className = 'status-dot loading';
    const pct = Math.round(status.progress * 100);
    el.sampleText.textContent = `Loading Salamander Grand (${pct}%)…`;
  }
});

// Initialize Waterfall & 88-Key Visualizer
const visualizer = new PianoVisualizer({
  rollCanvas: el.rollCanvas,
  timelineCanvas: el.timelineCanvas,
  onSeek: (timeSec) => {
    pianoEngine.seek(timeSec);
    updateTimecodeUI();
  },
  onNoteDown: (midi, vel) => {
    pianoEngine.noteOnInteractive(midi, vel);
  },
  onNoteUp: (midi) => {
    pianoEngine.noteOffInteractive(midi);
  },
});

visualizer.setTimeProvider(
  () => pianoEngine.getCurrentTime(),
  () => pianoEngine.isPlaying
);

pianoEngine.onPlaybackEnded = () => {
  syncPlayButtonUI();
  updateTimecodeUI();
};

// Warm up sample engine on first user gesture (satisfies browser AudioContext autoplay policy cleanly)
let gestureInitialized = false;
function warmUpOnFirstGesture() {
  if (gestureInitialized) return;
  gestureInitialized = true;
  pianoEngine.initSamples().catch(() => {});
}
window.addEventListener('pointerdown', warmUpOnFirstGesture, { once: true, passive: true });
window.addEventListener('keydown', warmUpOnFirstGesture, { once: true, passive: true });

function formatTime(sec) {
  const s = Math.max(0, sec || 0);
  const mins = Math.floor(s / 60);
  const rem = s - mins * 60;
  return `${String(mins).padStart(2, '0')}:${rem.toFixed(1).padStart(4, '0')}`;
}

function updateTimecodeUI() {
  el.currentTimeText.textContent = formatTime(pianoEngine.getCurrentTime());
  el.totalTimeText.textContent = formatTime(pianoEngine.duration);
}

setInterval(() => {
  if (pianoEngine.isPlaying) {
    updateTimecodeUI();
  }
}, 50);

// Initialize Web Worker for off-thread STFT HPSS + Beat/Harmony DSP
let worker = null;
function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./workers/transcribe-worker.js', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = handleWorkerMessage;
    worker.onerror = (err) => {
      setProgressVisible(false);
      state.isBusy = false;
      el.sourceBadge.textContent = 'ERROR';
      el.sourceHint.textContent = `Worker error: ${err.message || 'Failed to analyze audio'}`;
    };
  }
  return worker;
}

async function handleWorkerMessage(event) {
  const msg = event.data;
  if (msg.jobId !== state.activeJobId) return;

  if (msg.type === 'progress') {
    setProgress(msg.progress * 0.38, msg.stage);
  } else if (msg.type === 'dsp-result') {
    try {
      const { harmonicSamples, analysis } = msg;
      state.analysis = analysis;
      state.lastAnalyzedDrumRejection = state.extraction.drumRejection;
      el.reanalyzeBtn.hidden = true;

      // Stage 2: GPU WebGL2 Polyphonic Neural Transcription
      const rawNotes = await neuralTranscriber.transcribeHarmonicAudio(
        harmonicSamples,
        state.extraction.sensitivity,
        (pct, label) => {
          if (msg.jobId === state.activeJobId) {
            setProgress(0.38 + pct * 0.62, label);
          }
        }
      );

      if (msg.jobId !== state.activeJobId) return;
      state.rawNotes = rawNotes;
      state.isBusy = false;
      setProgressVisible(false);
      rebuildArrangementAndBind(true);
    } catch (err) {
      state.isBusy = false;
      setProgressVisible(false);
      el.sourceBadge.textContent = 'ERROR';
      el.sourceHint.textContent = `Transcription error: ${err.message || err}`;
    }
  } else if (msg.type === 'error') {
    state.isBusy = false;
    setProgressVisible(false);
    el.sourceBadge.textContent = 'ERROR';
    el.sourceHint.textContent = msg.message;
  }
}

function setProgressVisible(visible) {
  el.progressDrawer.hidden = !visible;
}

function setProgress(pct01, stageLabel) {
  setProgressVisible(true);
  const pct = Math.max(0, Math.min(100, Math.round(pct01 * 100)));
  el.progressStageText.textContent = stageLabel;
  el.progressPercentText.textContent = `${pct}%`;
  el.progressFill.style.width = `${pct}%`;
}

async function resampleToMono22050(audioBuffer) {
  const targetRate = 22050;
  const numFrames = Math.max(1, Math.ceil(audioBuffer.duration * targetRate));
  const offline = new OfflineAudioContext(1, numFrames, targetRate);
  const src = offline.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(offline.destination);
  src.start(0);
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

async function loadUserFile(file) {
  if (!file || state.isBusy) return;
  pianoEngine.pause();
  syncPlayButtonUI();

  const cleanName = file.name.replace(/\.[^/.]+$/, '') || 'piano-cover';
  state.trackBaseName = cleanName;
  el.sourceTitle.textContent = file.name;

  const isMidi = /\.(mid|midi)$/i.test(file.name) || file.type.includes('midi');
  if (isMidi) {
    try {
      el.sourceBadge.textContent = 'MIDI';
      setProgress(0.4, 'Parsing MIDI file…');
      const ab = await file.arrayBuffer();
      const parsed = parseMidiFile(ab);

      state.hasAudioSource = false;
      state.mono22kSamples = null;
      state.rawNotes = parsed.rawNotes;
      state.analysis = parsed.analysis;
      pianoEngine.setOriginalAudioBuffer(null);
      updateMonitorButtonsAvailability(false);
      setProgressVisible(false);

      el.sourceHint.textContent =
        'Imported MIDI • Rendered through 4-velocity-layer Yamaha C5 Salamander Grand';
      rebuildArrangementAndBind(true);
    } catch (err) {
      setProgressVisible(false);
      el.sourceBadge.textContent = 'ERROR';
      el.sourceHint.textContent = `Could not read MIDI file: ${err.message}`;
    }
    return;
  }

  try {
    state.isBusy = true;
    el.sourceBadge.textContent = 'DECODING';
    el.sourceHint.textContent = 'Decoding full-resolution audio & preparing harmonic analysis…';
    setProgress(0.02, 'Decoding audio file…');

    const ctx = pianoEngine.ensureContext();
    pianoEngine.initSamples().catch(() => {});
    const arrayBuffer = await file.arrayBuffer();
    const decodedBuffer = await ctx.decodeAudioData(arrayBuffer);

    await processDecodedAudioBuffer(decodedBuffer, file.name);
  } catch (err) {
    state.isBusy = false;
    setProgressVisible(false);
    el.sourceBadge.textContent = 'ERROR';
    el.sourceHint.textContent = `Audio decode error: ${err.message || 'Unsupported audio format'}`;
  }
}

async function processDecodedAudioBuffer(decodedBuffer, displayTitle) {
  state.isBusy = true;
  state.hasAudioSource = true;
  pianoEngine.setOriginalAudioBuffer(decodedBuffer);
  updateMonitorButtonsAvailability(true);

  setProgress(0.04, 'Resampling to 22.05 kHz analysis stream…');
  const mono22k = await resampleToMono22050(decodedBuffer);
  state.mono22kSamples = mono22k;

  el.sourceBadge.textContent = 'ARRANGING';
  el.sourceTitle.textContent = displayTitle;
  el.sourceHint.textContent = `${formatTime(decodedBuffer.duration)} • Running HPSS drum removal + polyphonic piano arrangement…`;

  runWorkerDspAndTranscription(mono22k);
}

function runWorkerDspAndTranscription(monoSamples) {
  const jobId = ++state.activeJobId;
  state.isBusy = true;
  const copy = new Float32Array(monoSamples);
  getWorker().postMessage(
    {
      type: 'analyze-dsp',
      jobId,
      payload: {
        samples: copy,
        sampleRate: 22050,
        drumRejection: state.extraction.drumRejection,
      },
    },
    [copy.buffer]
  );
}

function rebuildArrangementAndBind(autoPlay = false) {
  if (!state.rawNotes || !state.analysis) return;

  const arranged = arrangeForPiano(state.rawNotes, state.analysis, state.settings);
  state.arrangement = arranged;

  pianoEngine.setArrangement(arranged, state.analysis.durationSec);
  visualizer.setData({
    notes: arranged.notes,
    pedalIntervals: arranged.pedalIntervals,
    beats: state.analysis.beats,
    chordChanges: state.analysis.chordChanges,
    duration: pianoEngine.duration,
  });

  el.songMetrics.hidden = false;
  el.metricBpm.textContent = state.analysis.bpm;
  el.metricKey.textContent = state.analysis.keySignature?.name || 'Chromatic';
  el.metricNotes.textContent = arranged.stats.totalNotes;
  el.metricPedals.textContent = arranged.stats.pedalChanges;

  el.sourceBadge.textContent = 'READY';
  el.sourceHint.textContent = `${arranged.stats.rhNotes} Right-Hand notes • ${arranged.stats.lhNotes} Left-Hand bass notes • ${arranged.stats.pedalChanges} chord-synced damper pedals`;

  const hasNotes = arranged.notes.length > 0;
  el.playPauseBtn.disabled = !hasNotes;
  el.restartBtn.disabled = !hasNotes;
  el.exportMidiBtn.disabled = !hasNotes;
  el.exportWavBtn.disabled = !hasNotes;

  updateTimecodeUI();

  if (autoPlay && hasNotes) {
    pianoEngine.play(0).then(() => syncPlayButtonUI());
  }
}

function updateMonitorButtonsAvailability(hasOriginalAudio) {
  el.monitorBlendBtn.disabled = !hasOriginalAudio;
  el.monitorOrigBtn.disabled = !hasOriginalAudio;
  if (!hasOriginalAudio && pianoEngine.monitorMode !== 'piano') {
    setMonitorModeUI('piano');
  }
}

function setMonitorModeUI(mode) {
  pianoEngine.setMonitorMode(mode);
  for (const btn of el.monitorSegmented.querySelectorAll('.seg-btn')) {
    btn.classList.toggle('active', btn.dataset.monitor === mode);
  }
}

function syncPlayButtonUI() {
  const playing = pianoEngine.isPlaying;
  el.playIcon.style.display = playing ? 'none' : 'block';
  el.pauseIcon.style.display = playing ? 'block' : 'none';
  visualizer.syncAnimationState();
}

// --- Event Listeners ---

el.chooseFileBtn.addEventListener('click', () => el.fileInput.click());
el.fileInput.addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  if (f) loadUserFile(f);
  e.target.value = '';
});

window.addEventListener('dragover', (e) => {
  e.preventDefault();
  el.dropZone.classList.add('drag-over');
});
window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) {
    el.dropZone.classList.remove('drag-over');
  }
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  el.dropZone.classList.remove('drag-over');
  const f = e.dataTransfer?.files?.[0];
  if (f) loadUserFile(f);
});

el.demoSongBtn.addEventListener('click', async () => {
  if (state.isBusy) return;
  pianoEngine.pause();
  syncPlayButtonUI();

  try {
    state.isBusy = true;
    state.trackBaseName = 'midnight-skyline-piano-cover';
    el.sourceBadge.textContent = 'SYNTHESIZING';
    el.sourceTitle.textContent = 'Midnight Skyline (Demo Band Mix — Drums + Bass + Chords + Lead)';
    setProgress(0.02, 'Generating full-band demo mix (drums, bass, chords & vibrato lead)…');

    pianoEngine.ensureContext();
    pianoEngine.initSamples().catch(() => {});
    const demoBuffer = await generateDemoBandTrack();
    await processDecodedAudioBuffer(demoBuffer, 'Midnight Skyline (Full-Band Demo → Solo Piano Cover)');
  } catch (err) {
    state.isBusy = false;
    setProgressVisible(false);
    el.sourceBadge.textContent = 'ERROR';
    el.sourceHint.textContent = err.message;
  }
});

el.playPauseBtn.addEventListener('click', async () => {
  if (pianoEngine.isPlaying) {
    pianoEngine.pause();
  } else {
    const startAt =
      pianoEngine.getCurrentTime() >= pianoEngine.duration - 0.15 ? 0 : pianoEngine.getCurrentTime();
    await pianoEngine.play(startAt);
  }
  syncPlayButtonUI();
});

el.restartBtn.addEventListener('click', () => {
  pianoEngine.seek(0);
  updateTimecodeUI();
  visualizer.requestRender();
});

el.monitorSegmented.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn || btn.disabled) return;
  setMonitorModeUI(btn.dataset.monitor);
});

el.characterGrid.addEventListener('click', (e) => {
  const card = e.target.closest('.char-card');
  if (!card) return;
  const key = card.dataset.character;
  pianoEngine.setCharacter(key);

  for (const c of el.characterGrid.querySelectorAll('.char-card')) {
    c.classList.toggle('active', c === card);
  }

  const presetMix = Math.round((PIANO_CHARACTERS[key]?.reverbSend ?? 0.28) * 100);
  el.reverbSlider.value = String(presetMix);
  el.reverbVal.textContent = `${presetMix}%`;
});

el.reverbSlider.addEventListener('input', () => {
  const pct = Number(el.reverbSlider.value);
  el.reverbVal.textContent = `${pct}%`;
  pianoEngine.setReverbMix(pct / 100);
});

el.styleSegmented.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  state.settings.style = btn.dataset.style;
  for (const b of el.styleSegmented.querySelectorAll('.seg-btn')) {
    b.classList.toggle('active', b === btn);
  }
  rebuildArrangementAndBind(false);
});

el.melodySlider.addEventListener('input', () => {
  const v = Number(el.melodySlider.value);
  el.melodyVal.textContent = `${v}%`;
  state.settings.melodyBoost = v / 100;
  rebuildArrangementAndBind(false);
});

el.densitySlider.addEventListener('input', () => {
  const v = Number(el.densitySlider.value);
  el.densityVal.textContent = `${v}%`;
  state.settings.density = v / 100;
  rebuildArrangementAndBind(false);
});

el.quantizeSlider.addEventListener('input', () => {
  const v = Number(el.quantizeSlider.value);
  el.quantizeVal.textContent = `${v}%`;
  state.settings.quantize = v / 100;
  rebuildArrangementAndBind(false);
});

el.pedalSegmented.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  state.settings.pedalMode = btn.dataset.pedal;
  for (const b of el.pedalSegmented.querySelectorAll('.seg-btn')) {
    b.classList.toggle('active', b === btn);
  }
  rebuildArrangementAndBind(false);
});

function updateTranspose(delta) {
  state.settings.transpose = Math.max(-12, Math.min(12, state.settings.transpose + delta));
  const t = state.settings.transpose;
  el.transposeVal.textContent = `${t > 0 ? `+${t}` : t} st`;
  rebuildArrangementAndBind(false);
}
el.transDownBtn.addEventListener('click', () => updateTranspose(-1));
el.transUpBtn.addEventListener('click', () => updateTranspose(1));

el.octaveCheck.addEventListener('change', () => {
  state.settings.octaveMelody = el.octaveCheck.checked;
  rebuildArrangementAndBind(false);
});

let sensitivityDebounce = null;
el.sensitivitySlider.addEventListener('input', () => {
  const v = Number(el.sensitivitySlider.value);
  el.sensitivityVal.textContent = `${v}%`;
  state.extraction.sensitivity = v / 100;

  if (state.hasAudioSource && !state.isBusy && neuralTranscriber.cachedFrames) {
    clearTimeout(sensitivityDebounce);
    sensitivityDebounce = setTimeout(() => {
      state.rawNotes = neuralTranscriber.extractNotesFromCached(state.extraction.sensitivity);
      rebuildArrangementAndBind(false);
    }, 55);
  }
});

el.drumSlider.addEventListener('input', () => {
  const v = Number(el.drumSlider.value);
  el.drumVal.textContent = `${v}%`;
  state.extraction.drumRejection = v / 100;
  if (
    state.mono22kSamples &&
    Math.abs(state.extraction.drumRejection - state.lastAnalyzedDrumRejection) > 0.02
  ) {
    el.reanalyzeBtn.hidden = false;
  } else {
    el.reanalyzeBtn.hidden = true;
  }
});

el.reanalyzeBtn.addEventListener('click', () => {
  if (!state.mono22kSamples || state.isBusy) return;
  pianoEngine.pause();
  syncPlayButtonUI();
  el.reanalyzeBtn.hidden = true;
  runWorkerDspAndTranscription(state.mono22kSamples);
});

el.exportMidiBtn.addEventListener('click', () => {
  if (!state.arrangement || state.arrangement.notes.length === 0) return;
  const midiBytes = encodeArrangedMidi({
    notes: state.arrangement.notes,
    cc64Events: state.arrangement.cc64Events,
    bpm: state.analysis?.bpm || 116,
    title: state.trackBaseName,
  });
  const blob = new Blob([midiBytes], { type: 'audio/midi' });
  triggerDownload(blob, `${state.trackBaseName}-piano.mid`);
});

el.exportWavBtn.addEventListener('click', async () => {
  if (!state.arrangement || state.arrangement.notes.length === 0 || state.isBusy) return;
  const origLabel = el.exportWavLabel.textContent;
  try {
    el.exportWavBtn.disabled = true;
    el.exportWavLabel.textContent = 'Rendering 48kHz WAV…';
    setProgress(0.05, 'Preparing 4-layer Salamander Grand Piano studio render…');

    const renderedBuffer = await pianoEngine.renderOfflineStudioAudio((pct, msg) => {
      setProgress(pct * 0.88, msg);
    });

    setProgress(0.94, 'Encoding 24-bit stereo PCM WAV…');
    await new Promise((r) => setTimeout(r, 20));
    const wavBlob = encodeAudioBufferToWav24(renderedBuffer, -1.0);
    triggerDownload(wavBlob, `${state.trackBaseName}-grand-piano.wav`);
    setProgressVisible(false);
  } catch (err) {
    setProgressVisible(false);
    el.sourceBadge.textContent = 'ERROR';
    el.sourceHint.textContent = `WAV render failed: ${err.message}`;
  } finally {
    el.exportWavBtn.disabled = false;
    el.exportWavLabel.textContent = origLabel;
  }
});

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const KEY_TO_MIDI = {
  KeyA: 60, KeyW: 61, KeyS: 62, KeyE: 63, KeyD: 64,
  KeyF: 65, KeyT: 66, KeyG: 67, KeyY: 68, KeyH: 69,
  KeyU: 70, KeyJ: 71, KeyK: 72, KeyO: 73, KeyL: 74,
};
const heldQwerty = new Set();

window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) return;

  if (e.code === 'Space') {
    e.preventDefault();
    if (!el.playPauseBtn.disabled) el.playPauseBtn.click();
    return;
  }

  const midi = KEY_TO_MIDI[e.code];
  if (midi && !e.repeat && !heldQwerty.has(e.code)) {
    heldQwerty.add(e.code);
    visualizer.manualPressed.add(midi);
    visualizer.syncAnimationState();
    pianoEngine.noteOnInteractive(midi, 90);
  }
});

window.addEventListener('keyup', (e) => {
  const midi = KEY_TO_MIDI[e.code];
  if (midi && heldQwerty.has(e.code)) {
    heldQwerty.delete(e.code);
    visualizer.manualPressed.delete(midi);
    visualizer.syncAnimationState();
    pianoEngine.noteOffInteractive(midi);
  }
});
