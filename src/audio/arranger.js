/**
 * Two-Hand Piano Arrangement & Musical Polish Engine
 *
 * Turns raw neural pitch frames/notes + beat & harmony analysis into an idiomatic,
 * expressive solo grand piano performance with:
 * - Vibrato-fragment note healing (merges split vocal notes into singing piano notes)
 * - Low-register acoustic mud filtering (cleans narrow intervals below C3)
 * - Skyline + melodic-continuity lead vocal/melody separation
 * - Playable 2-hand span & polyphony voice leading (Left Hand + Right Hand)
 * - Subtle beat-grid quantization & micro-arpeggiated chord bloom
 * - Chord-aware Damper Sustain Pedal (CC64) generation
 */

export const DEFAULT_ARRANGEMENT_SETTINGS = {
  style: 'cover',       // 'cover' | 'ballad' | 'faithful'
  quantize: 0.38,       // 0..1 beat-grid tightening
  melodyBoost: 0.65,    // 0..1 voice separation between melody and accompaniment
  density: 0.65,        // 0..1 accompaniment density
  octaveMelody: false,  // double strong melody notes +12st in chorus/peaks
  pedalMode: 'harmonic', // 'harmonic' | 'lush' | 'dry'
  transpose: 0,         // -12..+12 semitones
};

/**
 * @param {Array<{startTimeSeconds:number, durationSeconds:number, pitchMidi:number, amplitude:number}>} rawNotes
 * @param {object} analysis { bpm, beats, chordChanges, keySignature, durationSec }
 * @param {object} userSettings
 */
export function arrangeForPiano(rawNotes, analysis, userSettings = {}) {
  const settings = { ...DEFAULT_ARRANGEMENT_SETTINGS, ...userSettings };
  const bpm = analysis?.bpm || 116;
  const durationSec = analysis?.durationSec || (rawNotes.length ? Math.max(...rawNotes.map((n) => n.startTimeSeconds + n.durationSeconds)) : 0);
  const scaleMask = analysis?.keySignature?.scaleMask || null;

  if (!rawNotes || rawNotes.length === 0) {
    return {
      notes: [],
      pedalIntervals: [],
      cc64Events: [],
      stats: { totalNotes: 0, rhNotes: 0, lhNotes: 0, pedalChanges: 0 },
    };
  }

  // 1. Copy, filter extreme noise & transient blips
  const isFaithful = settings.style === 'faithful';
  const isBallad = settings.style === 'ballad';
  const minAmp = isFaithful ? 0.16 : 0.22 - settings.density * 0.08;
  const minDur = isFaithful ? 0.045 : 0.068;

  let notes = [];
  for (const r of rawNotes) {
    const pitch = Math.round(r.pitchMidi) + (settings.transpose || 0);
    if (pitch < 21 || pitch > 105) continue;
    // Extreme piano registers rarely hold musical fundamentals in pop mixes (usually sub rumble or cymbal)
    if (!isFaithful && (pitch < 26 || pitch > 98) && r.amplitude < 0.48) continue;
    if (r.durationSeconds < minDur && r.amplitude < 0.42) continue;
    if (r.amplitude < minAmp) continue;

    // Subtle out-of-key short-blip rejection (keeps intentional accidentals that have real energy/duration)
    if (!isFaithful && scaleMask) {
      const origPc = ((Math.round(r.pitchMidi) % 12) + 12) % 12;
      if (!scaleMask[origPc] && r.amplitude < 0.33 && r.durationSeconds < 0.14) {
        continue;
      }
    }

    notes.push({
      start: Math.max(0, r.startTimeSeconds),
      duration: Math.max(0.055, r.durationSeconds),
      pitch,
      amp: Math.min(1, Math.max(0.05, r.amplitude)),
      role: 'harmony',
      hand: pitch >= 59 ? 'RH' : 'LH',
    });
  }

  notes.sort((a, b) => a.start - b.start || b.pitch - a.pitch);

  // 2. Heal vocal vibrato / retrigger fragmentation on identical or +/-1 semitone pitches
  notes = healFragmentedNotes(notes, isFaithful ? 0.025 : 0.055);

  // 3. Gentle humanized beat-grid quantization (16th-note subdivisions)
  if (settings.quantize > 0.01) {
    const gridStep = 60 / bpm / 4; // 16th note
    const beatAnchor = analysis?.beats?.[0] ?? 0;
    const maxPull = gridStep * 0.46;

    for (const n of notes) {
      const rel = n.start - beatAnchor;
      const nearest = Math.round(rel / gridStep) * gridStep + beatAnchor;
      const diff = nearest - n.start;
      if (Math.abs(diff) <= maxPull) {
        n.start = Math.max(0, n.start + diff * settings.quantize);
      }
    }
    notes.sort((a, b) => a.start - b.start || b.pitch - a.pitch);
  }

  // 4. Cluster simultaneous attacks (~42ms window), separate Skyline Lead Melody, and enforce 2-hand piano voicing
  const clusters = buildOnsetClusters(notes, 0.042);
  let prevMelodyPitch = 67; // G4 reference
  const voicedNotes = [];

  for (const cluster of clusters) {
    // Sort cluster high to low
    cluster.sort((a, b) => b.pitch - a.pitch);

    // Deduplicate identical pitches in same cluster (keep strongest)
    const unique = [];
    const seenPitch = new Set();
    for (const n of cluster) {
      if (!seenPitch.has(n.pitch)) {
        seenPitch.add(n.pitch);
        unique.push(n);
      }
    }

    // Identify lead melody candidate in singing register (F3=53 .. G6=91)
    let melodyNote = null;
    let bestMelScore = -Infinity;
    for (const n of unique) {
      if (n.pitch >= 53 && n.pitch <= 91) {
        const isTop = n === unique[0] ? 0.35 : 0;
        const leapPenalty = Math.min(0.45, Math.abs(n.pitch - prevMelodyPitch) * 0.018);
        const score = n.amp * 0.8 + isTop + (n.pitch - 53) * 0.008 - leapPenalty;
        if (score > bestMelScore) {
          bestMelScore = score;
          melodyNote = n;
        }
      }
    }
    if (melodyNote) {
      melodyNote.role = 'melody';
      melodyNote.hand = 'RH';
      prevMelodyPitch = melodyNote.pitch;
    }

    if (isFaithful) {
      // Minimal intervention: just clean overlapping ultra-dense clusters (>10 notes)
      const kept = unique.slice(0, 10);
      for (const n of kept) {
        if (n !== melodyNote) {
          n.hand = n.pitch >= 58 ? 'RH' : 'LH';
          if (n === kept[kept.length - 1] && n.pitch < 55) n.role = 'bass';
        }
        voicedNotes.push(n);
      }
      continue;
    }

    // Solo Piano Cover / Intimate Ballad 2-Hand Voicing
    // Split into LH candidates and RH candidates
    const splitPoint = melodyNote ? Math.min(60, melodyNote.pitch - 5) : 58;
    const rhCand = [];
    const lhCand = [];

    for (const n of unique) {
      if (n === melodyNote || n.pitch >= splitPoint) {
        n.hand = 'RH';
        rhCand.push(n);
      } else {
        n.hand = 'LH';
        lhCand.push(n);
      }
    }

    // --- LEFT HAND VOICING (Clean Bass + Open 5th/Octave/10th, Zero Low Mud) ---
    lhCand.sort((a, b) => a.pitch - b.pitch); // lowest first
    const keptLH = [];
    if (lhCand.length > 0) {
      // Pick strongest low root among bottom candidates
      let bassRoot = lhCand[0];
      if (lhCand.length > 1 && lhCand[1].pitch - lhCand[0].pitch <= 4 && lhCand[1].amp > lhCand[0].amp * 1.25) {
        bassRoot = lhCand[1];
      }
      bassRoot.role = 'bass';
      // Give bass notes natural harmonic sustain minimum
      bassRoot.duration = Math.max(bassRoot.duration, isBallad ? 0.55 : 0.35);
      keptLH.push(bassRoot);

      const maxLH = isBallad ? 2 : settings.density > 0.75 ? 3 : 2;
      for (const cand of lhCand) {
        if (cand === bassRoot) continue;
        if (keptLH.length >= maxLH) break;
        const intervalFromRoot = cand.pitch - bassRoot.pitch;
        if (intervalFromRoot < 0 || intervalFromRoot > 15) continue;

        // Acoustic mud rule: below C3 (48), require at least Perfect 5th (7st); below G3 (55), at least Perfect 4th (5st)
        const minInterval = bassRoot.pitch < 45 ? 7 : 5;
        const tooClose = keptLH.some((k) => Math.abs(cand.pitch - k.pitch) < minInterval);
        if (!tooClose) {
          keptLH.push(cand);
        }
      }
    }

    // --- RIGHT HAND VOICING (Melody on Top + Playable 1-Octave Chord Support) ---
    rhCand.sort((a, b) => b.pitch - a.pitch); // highest first
    const keptRH = [];
    if (melodyNote) {
      melodyNote.duration = Math.max(melodyNote.duration, 0.16);
      keptRH.push(melodyNote);
    }

    const maxRH = isBallad
      ? Math.max(1, Math.round(1 + settings.density * 2))
      : Math.max(2, Math.round(2 + settings.density * 2.5));

    // Sort remaining RH candidates by amplitude
    const rhSupport = rhCand.filter((n) => n !== melodyNote).sort((a, b) => b.amp - a.amp);
    for (const cand of rhSupport) {
      if (keptRH.length >= maxRH) break;
      const topPitch = keptRH[0]?.pitch ?? cand.pitch;
      // Keep RH playable within an octave (12 semitones) below top note
      if (topPitch - cand.pitch > 12) continue;
      // Avoid harsh minor-2nd cluster rubs next to melody unless very strong
      const rub = keptRH.some((k) => Math.abs(k.pitch - cand.pitch) === 1 && cand.amp < 0.62);
      if (rub) continue;
      keptRH.push(cand);
    }

    // Optional Octave Melody Doubling on expressive chorus peaks
    if (settings.octaveMelody && melodyNote && melodyNote.amp > 0.52 && melodyNote.pitch <= 84) {
      const octPitch = melodyNote.pitch + 12;
      if (!keptRH.some((k) => k.pitch === octPitch)) {
        keptRH.push({
          start: melodyNote.start + 0.006,
          duration: melodyNote.duration,
          pitch: octPitch,
          amp: melodyNote.amp * 0.88,
          role: 'melody',
          hand: 'RH',
        });
      }
    }

    // Subtle pianist upward chord bloom (6-9ms per voice on 3+ note chords)
    const combined = [...keptLH, ...keptRH].sort((a, b) => a.pitch - b.pitch);
    if (combined.length >= 3) {
      const rollStep = isBallad ? 0.011 : 0.006;
      for (let i = 0; i < combined.length; i++) {
        combined[i].start += i * rollStep;
      }
    }

    voicedNotes.push(...combined);
  }

  // 5. Dynamic Velocity Sculpting & Same-Pitch Overlap Prevention
  voicedNotes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);

  const lastByPitch = new Map();
  for (const n of voicedNotes) {
    const prev = lastByPitch.get(n.pitch);
    if (prev) {
      const maxPrevEnd = n.start - 0.016;
      if (prev.start + prev.duration > maxPrevEnd) {
        prev.duration = Math.max(0.045, maxPrevEnd - prev.start);
      }
    }
    lastByPitch.set(n.pitch, n);

    // Musical dynamic curve
    const curved = Math.pow(n.amp, 0.78);
    let vel = Math.round(30 + curved * 76); // Base 30..106

    if (n.role === 'melody') {
      vel += Math.round(settings.melodyBoost * 22);
    } else if (n.role === 'bass') {
      vel += Math.round(settings.melodyBoost * 6);
    } else {
      vel -= Math.round(settings.melodyBoost * 11);
    }

    if (isBallad) {
      vel = Math.round(vel * 0.82); // Shifts more into soft felt hammer velocity layers (v3 & v7)
    }

    n.velocity = Math.max(20, Math.min(122, vel));
  }

  // Remove any degenerate collapsed notes
  const finalNotes = voicedNotes
    .filter((n) => n.duration >= 0.04)
    .map((n, idx) => ({
      id: idx,
      startTime: Number(n.start.toFixed(4)),
      duration: Number(n.duration.toFixed(4)),
      pitch: n.pitch,
      velocity: n.velocity,
      hand: n.hand,
      role: n.role,
    }));

  // 6. Damper Sustain Pedal (CC64) Generation
  const { pedalIntervals, cc64Events } = generateSustainPedal(
    finalNotes,
    analysis?.chordChanges || [],
    bpm,
    durationSec,
    settings.pedalMode
  );

  const rhCount = finalNotes.filter((n) => n.hand === 'RH').length;
  return {
    notes: finalNotes,
    pedalIntervals,
    cc64Events,
    stats: {
      totalNotes: finalNotes.length,
      rhNotes: rhCount,
      lhNotes: finalNotes.length - rhCount,
      pedalChanges: pedalIntervals.length,
    },
  };
}

function healFragmentedNotes(notes, maxGapSec) {
  if (notes.length === 0) return notes;
  const byPitch = new Map();
  for (const n of notes) {
    let arr = byPitch.get(n.pitch);
    if (!arr) {
      arr = [];
      byPitch.set(n.pitch, arr);
    }
    arr.push(n);
  }

  const healed = [];
  for (const [, pNotes] of byPitch) {
    pNotes.sort((a, b) => a.start - b.start);
    let curr = pNotes[0];
    for (let i = 1; i < pNotes.length; i++) {
      const next = pNotes[i];
      const currEnd = curr.start + curr.duration;
      const gap = next.start - currEnd;
      // Merge if overlapping or separated by tiny vibrato dropout without a hard louder re-attack
      if (gap <= maxGapSec && next.amp <= curr.amp * 1.28) {
        const newEnd = Math.max(currEnd, next.start + next.duration);
        curr.duration = newEnd - curr.start;
        curr.amp = Math.max(curr.amp, next.amp);
      } else {
        healed.push(curr);
        curr = next;
      }
    }
    healed.push(curr);
  }

  healed.sort((a, b) => a.start - b.start || b.pitch - a.pitch);
  return healed;
}

function buildOnsetClusters(notes, windowSec) {
  const clusters = [];
  let current = [];
  let clusterStart = -999;

  for (const n of notes) {
    if (current.length === 0 || n.start - clusterStart <= windowSec) {
      if (current.length === 0) clusterStart = n.start;
      current.push(n);
    } else {
      clusters.push(current);
      current = [n];
      clusterStart = n.start;
    }
  }
  if (current.length > 0) clusters.push(current);
  return clusters;
}

function generateSustainPedal(notes, chordChanges, bpm, durationSec, pedalMode) {
  if (pedalMode === 'dry' || notes.length === 0) {
    return { pedalIntervals: [], cc64Events: [] };
  }

  const minPhrase = pedalMode === 'lush' ? (60 / bpm) * 2.0 : (60 / bpm) * 1.0;
  const maxPhrase = pedalMode === 'lush' ? (60 / bpm) * 6.0 : (60 / bpm) * 4.0;

  // Merge harmonic chord-change boundaries with low bass root shifts
  const changePoints = new Set();
  const firstNoteTime = notes[0].startTime;
  changePoints.add(Math.max(0, firstNoteTime - 0.01));

  for (const ch of chordChanges) {
    if (ch.time >= firstNoteTime) {
      changePoints.add(ch.time);
    }
  }

  let prevBassPc = -1;
  for (const n of notes) {
    if (n.role === 'bass' || n.pitch < 50) {
      const pc = n.pitch % 12;
      if (prevBassPc !== -1 && pc !== prevBassPc) {
        changePoints.add(n.startTime);
      }
      prevBassPc = pc;
    }
  }

  const sortedRaw = Array.from(changePoints).sort((a, b) => a - b);
  const boundaries = [];
  for (const t of sortedRaw) {
    if (boundaries.length === 0 || t - boundaries[boundaries.length - 1] >= minPhrase) {
      // Split overly long pedal holds so strings don't accumulate excessive blur
      while (boundaries.length > 0 && t - boundaries[boundaries.length - 1] > maxPhrase) {
        boundaries.push(boundaries[boundaries.length - 1] + maxPhrase);
      }
      boundaries.push(t);
    }
  }

  const lastNoteEnd = Math.max(...notes.map((n) => n.startTime + n.duration));
  const endLimit = Math.min(durationSec + 0.8, lastNoteEnd + 0.6);
  while (boundaries.length > 0 && endLimit - boundaries[boundaries.length - 1] > maxPhrase) {
    boundaries.push(boundaries[boundaries.length - 1] + maxPhrase);
  }
  boundaries.push(endLimit);

  const pedalIntervals = [];
  const cc64Events = [];
  const clearGap = 0.055; // 55ms real pianist pedal-up/pedal-down re-pedal gap on chord changes

  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i] + (i === 0 ? 0 : clearGap * 0.5);
    const end = boundaries[i + 1] - clearGap * 0.5;
    if (end - start < 0.18) continue;

    // Only depress pedal if notes actually sound during this window
    const hasNotes = notes.some((n) => n.startTime < end && n.startTime + n.duration > start);
    if (!hasNotes) continue;

    const s = Number(start.toFixed(4));
    const e = Number(end.toFixed(4));
    pedalIntervals.push({ startTime: s, endTime: e });
    cc64Events.push({ time: s, value: 127 });
    cc64Events.push({ time: e, value: 0 });
  }

  return { pedalIntervals, cc64Events };
}
