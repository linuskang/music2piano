import { separateHarmonicAndAnalyze } from '../audio/dsp.js';

self.onmessage = (event) => {
  const { type, jobId, payload } = event.data;

  const postProgress = (progress, stage) => {
    self.postMessage({ type: 'progress', jobId, progress, stage });
  };

  try {
    if (type === 'analyze-dsp') {
      const { samples, sampleRate = 22050, drumRejection = 0.65 } = payload;

      const result = separateHarmonicAndAnalyze(
        samples,
        sampleRate,
        { drumRejection },
        (p, label) => postProgress(p, label)
      );

      const { harmonicSamples, bpm, beats, chordChanges, keySignature, durationSec } = result;
      self.postMessage(
        {
          type: 'dsp-result',
          jobId,
          harmonicSamples,
          analysis: { bpm, beats, chordChanges, keySignature, durationSec },
        },
        [harmonicSamples.buffer]
      );
    }
  } catch (err) {
    self.postMessage({
      type: 'error',
      jobId,
      message: err?.message || String(err),
    });
  }
};
