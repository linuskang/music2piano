/**
 * Standard MIDI File (.mid) Format 1 Encoder & Parser
 * - Exports 2-Hand Piano Arrangement (Right Hand + Left Hand tracks) with Tempo, Track Names, Program 0 (Acoustic Grand), and CC64 Damper Sustain Pedal
 * - Parses imported .mid / .midi files (Format 0 & Format 1, running status, tempo maps, CC64 pedal)
 */

const PPQ = 480;

function writeVarLen(value) {
  let v = Math.max(0, Math.round(value));
  const bytes = [v & 0x7f];
  while ((v >>= 7) > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
  }
  return bytes;
}

function stringToBytes(str) {
  return Array.from(new TextEncoder().encode(str));
}

function buildTrackChunk(events) {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);

  const body = [];
  let prevTick = 0;
  for (const ev of events) {
    const delta = Math.max(0, ev.tick - prevTick);
    prevTick = ev.tick;
    body.push(...writeVarLen(delta), ...ev.data);
  }
  body.push(0x00, 0xff, 0x2f, 0x00);

  const len = body.length;
  return new Uint8Array([
    0x4d, 0x54, 0x72, 0x6b,
    (len >>> 24) & 0xff,
    (len >>> 16) & 0xff,
    (len >>> 8) & 0xff,
    len & 0xff,
    ...body,
  ]);
}

/**
 * Encodes arranged piano notes + CC64 sustain pedal into a Format 1 Standard MIDI File (.mid).
 */
export function encodeArrangedMidi({ notes, cc64Events = [], bpm = 116, title = 'music2piano Arrangement' }) {
  const safeBpm = Math.max(30, Math.min(260, Math.round(bpm || 116)));
  const mpqn = Math.round(60_000_000 / safeBpm);
  const secToTick = (sec) => Math.max(0, Math.round(sec * (safeBpm / 60) * PPQ));

  const titleBytes = stringToBytes(title);
  const conductorEvents = [
    { tick: 0, order: 0, data: [0xff, 0x03, ...writeVarLen(titleBytes.length), ...titleBytes] },
    { tick: 0, order: 1, data: [0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08] },
    {
      tick: 0,
      order: 2,
      data: [0xff, 0x51, 0x03, (mpqn >>> 16) & 0xff, (mpqn >>> 8) & 0xff, mpqn & 0xff],
    },
  ];

  const rhName = stringToBytes('Piano Right Hand');
  const rhEvents = [
    { tick: 0, order: 0, data: [0xff, 0x03, ...writeVarLen(rhName.length), ...rhName] },
    { tick: 0, order: 1, data: [0xc0, 0x00] },
  ];

  const lhName = stringToBytes('Piano Left Hand');
  const lhEvents = [
    { tick: 0, order: 0, data: [0xff, 0x03, ...writeVarLen(lhName.length), ...lhName] },
    { tick: 0, order: 1, data: [0xc1, 0x00] },
  ];

  for (const cc of cc64Events) {
    const tick = secToTick(cc.time);
    const val = Math.max(0, Math.min(127, Math.round(cc.value)));
    const order = val === 0 ? 2 : 5;
    rhEvents.push({ tick, order, data: [0xb0, 0x40, val] });
    lhEvents.push({ tick, order, data: [0xb1, 0x40, val] });
  }

  for (const n of notes) {
    const startTick = secToTick(n.startTime);
    const endTick = Math.max(startTick + 12, secToTick(n.startTime + n.duration));
    const pitch = Math.max(0, Math.min(127, Math.round(n.pitch)));
    const vel = Math.max(1, Math.min(127, Math.round(n.velocity)));

    if (n.hand === 'LH') {
      lhEvents.push({ tick: startTick, order: 4, data: [0x91, pitch, vel] });
      lhEvents.push({ tick: endTick, order: 3, data: [0x81, pitch, 0x40] });
    } else {
      rhEvents.push({ tick: startTick, order: 4, data: [0x90, pitch, vel] });
      rhEvents.push({ tick: endTick, order: 3, data: [0x80, pitch, 0x40] });
    }
  }

  const chunks = [
    new Uint8Array([
      0x4d, 0x54, 0x68, 0x64,
      0x00, 0x00, 0x00, 0x06,
      0x00, 0x01,
      0x00, 0x03,
      (PPQ >>> 8) & 0xff,
      PPQ & 0xff,
    ]),
    buildTrackChunk(conductorEvents),
    buildTrackChunk(rhEvents),
    buildTrackChunk(lhEvents),
  ];

  const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * Parses a Standard MIDI File (.mid) ArrayBuffer into rawNotes + tempo + pedal events.
 */
export function parseMidiFile(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);

  if (bytes.length < 14 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'MThd') {
    throw new Error('Invalid MIDI file header');
  }

  const headerLen = view.getUint32(4);
  const numTracks = view.getUint16(10);
  const division = view.getUint16(12);
  const ppq = division & 0x8000 ? 480 : division;

  let pos = 8 + headerLen;
  const tempoChanges = [];
  const rawNoteEvents = [];
  const rawCc64 = [];

  for (let t = 0; t < numTracks && pos + 8 <= bytes.length; t++) {
    const chunkId = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
    const chunkLen = view.getUint32(pos + 4);
    pos += 8;
    const end = Math.min(bytes.length, pos + chunkLen);

    if (chunkId !== 'MTrk') {
      pos = end;
      continue;
    }

    let tick = 0;
    let runningStatus = 0;
    const activeNotes = new Map();

    while (pos < end) {
      let delta = 0;
      while (pos < end) {
        const b = bytes[pos++];
        delta = (delta << 7) | (b & 0x7f);
        if ((b & 0x80) === 0) break;
      }
      tick += delta;
      if (pos >= end) break;

      let status = bytes[pos];
      if (status < 0x80) {
        status = runningStatus;
      } else {
        pos++;
        if (status < 0xf0) runningStatus = status;
      }

      if (status === 0xff) {
        const metaType = bytes[pos++];
        let len = 0;
        while (pos < end) {
          const b = bytes[pos++];
          len = (len << 7) | (b & 0x7f);
          if ((b & 0x80) === 0) break;
        }
        if (metaType === 0x51 && len === 3 && pos + 3 <= end) {
          const mpqn = (bytes[pos] << 16) | (bytes[pos + 1] << 8) | bytes[pos + 2];
          tempoChanges.push({ tick, mpqn });
        }
        pos += len;
      } else if (status === 0xf0 || status === 0xf7) {
        let len = 0;
        while (pos < end) {
          const b = bytes[pos++];
          len = (len << 7) | (b & 0x7f);
          if ((b & 0x80) === 0) break;
        }
        pos += len;
      } else {
        const type = status & 0xf0;
        const ch = status & 0x0f;
        const d1 = bytes[pos++] ?? 0;
        const d2 = type === 0xc0 || type === 0xd0 ? 0 : (bytes[pos++] ?? 0);

        if (ch === 9) continue;

        const key = `${ch}:${d1}`;
        if (type === 0x90 && d2 > 0) {
          const prev = activeNotes.get(key);
          if (prev && tick > prev.startTick) {
            rawNoteEvents.push({ startTick: prev.startTick, endTick: tick, pitch: d1, velocity: prev.vel, track: t });
          }
          activeNotes.set(key, { startTick: tick, vel: d2 });
        } else if (type === 0x80 || (type === 0x90 && d2 === 0)) {
          const prev = activeNotes.get(key);
          if (prev) {
            rawNoteEvents.push({
              startTick: prev.startTick,
              endTick: Math.max(prev.startTick + 10, tick),
              pitch: d1,
              velocity: prev.vel,
              track: t,
            });
            activeNotes.delete(key);
          }
        } else if (type === 0xb0 && d1 === 64) {
          rawCc64.push({ tick, value: d2 });
        }
      }
    }
    pos = end;
  }

  if (tempoChanges.length === 0) {
    tempoChanges.push({ tick: 0, mpqn: 500_000 });
  }
  tempoChanges.sort((a, b) => a.tick - b.tick);

  const tempoMap = [];
  let accSec = 0;
  let lastTick = 0;
  let currMpqn = tempoChanges[0].tick === 0 ? tempoChanges[0].mpqn : 500_000;
  for (const tc of tempoChanges) {
    accSec += ((tc.tick - lastTick) / ppq) * (currMpqn / 1_000_000);
    lastTick = tc.tick;
    currMpqn = tc.mpqn;
    tempoMap.push({ tick: tc.tick, sec: accSec, mpqn: currMpqn });
  }

  const tickToSec = (tk) => {
    let seg = tempoMap[0];
    for (let i = 1; i < tempoMap.length; i++) {
      if (tempoMap[i].tick <= tk) seg = tempoMap[i];
      else break;
    }
    return seg.sec + ((tk - seg.tick) / ppq) * (seg.mpqn / 1_000_000);
  };

  const primaryBpm = Math.round(60_000_000 / tempoMap[0].mpqn);

  const rawNotes = rawNoteEvents.map((ev) => {
    const startTimeSeconds = tickToSec(ev.startTick);
    const endSec = tickToSec(ev.endTick);
    return {
      startTimeSeconds,
      durationSeconds: Math.max(0.05, endSec - startTimeSeconds),
      pitchMidi: ev.pitch,
      amplitude: Math.min(1, Math.max(0.1, (ev.velocity / 127) ** 1.15)),
    };
  });

  rawNotes.sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);
  const durationSec = rawNotes.length
    ? Math.max(...rawNotes.map((n) => n.startTimeSeconds + n.durationSeconds)) + 0.5
    : 4;

  const beatPeriod = 60 / primaryBpm;
  const beats = [];
  for (let t = 0; t <= durationSec; t += beatPeriod) beats.push(Number(t.toFixed(4)));

  const chordChanges = [];
  for (let t = 0; t <= durationSec; t += beatPeriod * 2) {
    chordChanges.push({ time: Number(t.toFixed(4)), strength: 0.5, chordLabel: '' });
  }

  return {
    rawNotes,
    analysis: {
      bpm: primaryBpm,
      beats,
      chordChanges,
      keySignature: { root: 0, mode: 'major', name: 'MIDI Import', scaleMask: null },
      durationSec,
    },
    importedCc64: rawCc64.map((c) => ({ time: tickToSec(c.tick), value: c.value })),
  };
}
