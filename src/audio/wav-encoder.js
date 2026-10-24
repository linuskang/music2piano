/**
 * Studio 24-Bit Stereo PCM WAV Encoder
 * Exports AudioBuffer to crisp 24-bit uncompressed .wav with automatic headroom protection.
 */

export function encodeAudioBufferToWav24(audioBuffer, normalizeTargetDb = -1.0) {
  const numChannels = Math.min(2, audioBuffer.numberOfChannels);
  const sampleRate = audioBuffer.sampleRate;
  const numFrames = audioBuffer.length;

  const ch0 = audioBuffer.getChannelData(0);
  const ch1 = numChannels > 1 ? audioBuffer.getChannelData(1) : ch0;

  // Measure peak for clean ceiling normalization (-1.0 dBFS)
  let peak = 0;
  for (let i = 0; i < numFrames; i++) {
    const a0 = Math.abs(ch0[i]);
    const a1 = Math.abs(ch1[i]);
    if (a0 > peak) peak = a0;
    if (a1 > peak) peak = a1;
  }

  const targetLinear = Math.pow(10, normalizeTargetDb / 20); // ~0.89125
  const gain = peak > 1e-5 ? Math.min(2.2, targetLinear / peak) : 1.0;

  const bytesPerSample = 3; // 24-bit PCM
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numFrames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);            // PCM chunk size
  view.setUint16(20, 1, true);             // AudioFormat = 1 (PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 24, true);            // 24 bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let ptr = 44;
  const maxInt24 = 8388607;

  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const raw = (c === 0 ? ch0[i] : ch1[i]) * gain;
      const clamped = Math.max(-1, Math.min(1, raw));
      const intVal = Math.round(clamped * maxInt24);
      bytes[ptr++] = intVal & 0xff;
      bytes[ptr++] = (intVal >> 8) & 0xff;
      bytes[ptr++] = (intVal >> 16) & 0xff;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}
