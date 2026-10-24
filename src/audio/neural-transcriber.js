/**
 * GPU-Accelerated Polyphonic Pitch Transcriber (@spotify/basic-pitch + TensorFlow.js WebGL2)
 *
 * Runs CQT + Conv2D neural inference on the main thread's hardware WebGL2 context
 * (avoiding Chromium OffscreenCanvas Worker readback hangs), yielding between 15ms 2-second
 * audio windows so the UI stays 60fps responsive, and explicitly disposing GPU tensors to prevent VRAM leaks.
 */

let tfModule = null;
let bpModule = null;
let basicPitchInstance = null;

const SAMPLE_RATE = 22050;
const FFT_HOP = 256;
const ANNOTATIONS_FPS = Math.floor(SAMPLE_RATE / FFT_HOP); // 86

export class NeuralTranscriber {
  constructor() {
    this.cachedFrames = null;
    this.cachedOnsets = null;
  }

  async ensureLoaded(onProgress = () => {}) {
    if (basicPitchInstance && bpModule && tfModule) return;

    onProgress(0.02, 'Loading polyphonic neural pitch model…');

    const [tf, bp] = await Promise.all([
      import('https://esm.sh/@tensorflow/tfjs@^3.2.0?target=es2022'),
      import('https://esm.sh/@spotify/basic-pitch@1.0.1'),
    ]);

    tfModule = tf;
    bpModule = bp;

    // Ensure synchronous WebGL2 readPixels so background tabs never stall on rAF fences
    tfModule.env().set('WEBGL_FENCE_API_ENABLED', false);
    tfModule.env().set('WEBGL_DOWNLOAD_FLOAT_ENABLED', false);

    try {
      await tfModule.setBackend('webgl');
      await tfModule.ready();
    } catch {
      await tfModule.setBackend('cpu');
      await tfModule.ready();
    }

    const modelUrl = new URL('../../assets/model/model.json', import.meta.url).href;
    basicPitchInstance = new bpModule.BasicPitch(modelUrl);
    await basicPitchInstance.model;
  }

  /**
   * Evaluates BasicPitch on clean 22,050 Hz harmonic mono audio with per-chunk UI yields & VRAM cleanup.
   */
  async transcribeHarmonicAudio(harmonicSamples, sensitivity = 0.55, onProgress = () => {}) {
    await this.ensureLoaded(onProgress);

    const [audioWindowsTensor, audioLen] = await basicPitchInstance.prepareData(harmonicSamples);
    const totalFramesTarget = Math.floor(audioLen * (ANNOTATIONS_FPS / SAMPLE_RATE));
    const numWindows = audioWindowsTensor.shape[0];

    const frames = [];
    const onsets = [];
    let collectedFrames = 0;

    try {
      for (let w = 0; w < numWindows; w++) {
        onProgress(w / numWindows, `Transcribing polyphonic harmony (${Math.round((w / numWindows) * 100)}%)…`);
        // Yield a macrotask so progress bar & 60fps canvas repaint smoothly
        await new Promise((r) => setTimeout(r, 0));

        const [rawFrames, rawOnsets, rawContours] = await basicPitchInstance.evaluateSingleFrame(
          audioWindowsTensor,
          w
        );

        let uFrames = basicPitchInstance.unwrapOutput(rawFrames);
        let uOnsets = basicPitchInstance.unwrapOutput(rawOnsets);
        rawFrames.dispose();
        rawOnsets.dispose();
        rawContours.dispose();

        const chunkLen = uFrames.shape[0];
        if (collectedFrames < totalFramesTarget) {
          if (collectedFrames + chunkLen >= totalFramesTarget) {
            const keep = totalFramesTarget - collectedFrames;
            const slicedF = uFrames.slice([0, 0], [keep, -1]);
            const slicedO = uOnsets.slice([0, 0], [keep, -1]);
            uFrames.dispose();
            uOnsets.dispose();
            uFrames = slicedF;
            uOnsets = slicedO;
          }
          collectedFrames += chunkLen;
          const [fArr, oArr] = await Promise.all([uFrames.array(), uOnsets.array()]);
          frames.push(...fArr);
          onsets.push(...oArr);
        }

        uFrames.dispose();
        uOnsets.dispose();
      }
    } finally {
      audioWindowsTensor.dispose();
    }

    this.cachedFrames = frames;
    this.cachedOnsets = onsets;

    onProgress(1.0, 'Extracting expressive note dynamics…');
    return this.extractNotesFromCached(sensitivity);
  }

  extractNotesFromCached(sensitivity = 0.55) {
    if (!this.cachedFrames || !this.cachedOnsets || !bpModule) return [];

    const onsetThresh = Number((0.64 - sensitivity * 0.32).toFixed(3)); // 0.64 .. 0.32
    const frameThresh = Number((0.40 - sensitivity * 0.20).toFixed(3)); // 0.40 .. 0.20
    const minNoteLen = 5;

    const polyNotes = bpModule.outputToNotesPoly(
      this.cachedFrames,
      this.cachedOnsets,
      onsetThresh,
      frameThresh,
      minNoteLen,
      true,  // inferOnsets
      3950,  // maxFreq Hz (~B7)
      30,    // minFreq Hz (~B0)
      true,  // melodiaTrick
      11     // energyTol
    );

    return bpModule.noteFramesToTime(polyNotes);
  }
}
