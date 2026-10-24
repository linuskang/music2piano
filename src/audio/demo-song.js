/**
 * Renders a realistic multi-instrument 8-bar pop/indie band demo AudioBuffer
 * (Kick + Snare + Hi-Hat drums + Bass + Pad Chords + Expressive Vibrato Lead Melody)
 * so users can test the full Drum-Removal (HPSS) -> Neural Transcription -> 2-Hand Piano Cover pipeline in 1 click.
 */

function midiToHz(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export async function generateDemoBandTrack() {
  const sampleRate = 44100;
  const bpm = 104;
  const beat = 60 / bpm;
  const bar = beat * 4;
  const totalBars = 8;
  const duration = totalBars * bar + 1.2;

  const ctx = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate);

  const master = ctx.createGain();
  master.gain.value = 0.72;
  master.connect(ctx.destination);

  // Progression: Dm7 | Bbmaj7 | F | C (2 cycles = 8 bars, Key of F Major / D Minor)
  const progression = [
    { bass: 38, chords: [57, 60, 65], barIdx: 0 }, // Dm7 (D2, A3-C4-F4)
    { bass: 34, chords: [58, 62, 65], barIdx: 1 }, // Bb (Bb1, Bb3-D4-F4)
    { bass: 41, chords: [57, 60, 65], barIdx: 2 }, // F (F2, A3-C4-F4)
    { bass: 36, chords: [55, 60, 64], barIdx: 3 }, // C (C2, G3-C4-E4)
    { bass: 38, chords: [57, 60, 65], barIdx: 4 }, // Dm7
    { bass: 34, chords: [58, 62, 65], barIdx: 5 }, // Bb
    { bass: 41, chords: [57, 60, 65], barIdx: 6 }, // F
    { bass: 36, chords: [55, 60, 64], barIdx: 7 }, // C
  ];

  // Noise buffer for snare & hi-hats (tests HPSS drum rejection!)
  const noiseBuf = ctx.createBuffer(1, sampleRate, sampleRate);
  const noiseData = noiseBuf.getChannelData(0);
  for (let i = 0; i < sampleRate; i++) {
    noiseData[i] = Math.random() * 2 - 1;
  }

  // 1. Drums (Kick on 1 & 3+, Snare on 2 & 4, 8th-note Hi-Hats)
  for (let b = 0; b < totalBars; b++) {
    const tBar = b * bar;
    // Kick hits
    for (const kb of [0, 1.5, 2.0]) {
      const t = tBar + kb * beat;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(135, t);
      osc.frequency.exponentialRampToValueAtTime(42, t + 0.09);
      g.gain.setValueAtTime(0.45, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
      osc.connect(g).connect(master);
      osc.start(t);
      osc.stop(t + 0.24);
    }

    // Snare hits on beats 2 & 4
    for (const sb of [1, 3]) {
      const t = tBar + sb * beat;
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1800;
      bp.Q.value = 0.9;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.24, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      src.connect(bp).connect(g).connect(master);
      src.start(t);
      src.stop(t + 0.18);
    }

    // 8th-note closed hi-hats
    for (let hh = 0; hh < 8; hh++) {
      const t = tBar + hh * 0.5 * beat;
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 7500;
      const g = ctx.createGain();
      g.gain.setValueAtTime(hh % 2 === 0 ? 0.08 : 0.045, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.045);
      src.connect(hp).connect(g).connect(master);
      src.start(t);
      src.stop(t + 0.05);
    }
  }

  // 2. Warm Electric Bass + Poly Synth Chords
  for (const item of progression) {
    const tBar = item.barIdx * bar;

    // Bass groove (beat 1 sustained + beat 3 pickup + octave passing)
    const bassPattern = [
      { offset: 0, dur: 2.2 * beat, pitch: item.bass },
      { offset: 2.5 * beat, dur: 1.4 * beat, pitch: item.bass + 12 },
    ];
    for (const bp of bassPattern) {
      const t = tBar + bp.offset;
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = midiToHz(bp.pitch);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 520;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.001, t);
      g.gain.linearRampToValueAtTime(0.32, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.08, t + bp.dur);
      g.gain.linearRampToValueAtTime(0.0001, t + bp.dur + 0.04);
      osc.connect(lp).connect(g).connect(master);
      osc.start(t);
      osc.stop(t + bp.dur + 0.05);
    }

    // Rhythmic electric-keys chord stabs (beats 1 & 3)
    for (const cb of [0, 2]) {
      const t = tBar + cb * beat;
      const dur = 1.85 * beat;
      for (const p of item.chords) {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = midiToHz(p);
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(1600, t);
        lp.frequency.exponentialRampToValueAtTime(650, t + dur);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.001, t);
        g.gain.linearRampToValueAtTime(0.085, t + 0.025);
        g.gain.exponentialRampToValueAtTime(0.02, t + dur);
        g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.05);
        osc.connect(lp).connect(g).connect(master);
        osc.start(t);
        osc.stop(t + dur + 0.06);
      }
    }
  }

  // 3. Singing Lead Melody (with gentle vocal-like vibrato!)
  const melodyNotes = [
    // Phrase 1 (Bars 1-4)
    { b: 0.0, d: 1.5, p: 72 }, { b: 1.5, d: 0.5, p: 74 }, { b: 2.0, d: 2.0, p: 69 },
    { b: 4.0, d: 1.5, p: 70 }, { b: 5.5, d: 0.5, p: 72 }, { b: 6.0, d: 2.0, p: 74 },
    { b: 8.0, d: 1.5, p: 77 }, { b: 9.5, d: 0.5, p: 76 }, { b: 10.0, d: 1.5, p: 72 }, { b: 11.5, d: 0.5, p: 69 },
    { b: 12.0, d: 3.5, p: 72 },
    // Phrase 2 (Bars 5-8, soaring higher)
    { b: 16.0, d: 1.0, p: 74 }, { b: 17.0, d: 1.0, p: 77 }, { b: 18.0, d: 2.0, p: 81 },
    { b: 20.0, d: 1.5, p: 79 }, { b: 21.5, d: 0.5, p: 77 }, { b: 22.0, d: 2.0, p: 74 },
    { b: 24.0, d: 1.5, p: 77 }, { b: 25.5, d: 0.5, p: 76 }, { b: 26.0, d: 1.5, p: 72 }, { b: 27.5, d: 0.5, p: 74 },
    { b: 28.0, d: 3.8, p: 76 },
  ];

  for (const m of melodyNotes) {
    const t = m.b * beat;
    const dur = m.d * beat * 0.94;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = midiToHz(m.p);

    // Subtle vocal vibrato after 180ms
    const vib = ctx.createOscillator();
    const vibGain = ctx.createGain();
    vib.frequency.value = 5.4;
    vibGain.gain.setValueAtTime(0, t);
    vibGain.gain.linearRampToValueAtTime(3.2, t + Math.min(dur, 0.25));
    vib.connect(vibGain).connect(osc.frequency);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2600;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(0.24, t + 0.03);
    g.gain.setValueAtTime(0.21, t + Math.max(0.04, dur - 0.06));
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur + 0.04);

    osc.connect(lp).connect(g).connect(master);
    vib.start(t);
    osc.start(t);
    vib.stop(t + dur + 0.05);
    osc.stop(t + dur + 0.05);
  }

  return await ctx.startRendering();
}
