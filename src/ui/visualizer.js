/**
 * High-DPI Waterfall Piano Roll + Interactive 88-Key Grand Keyboard + Timeline Scrubber
 * Uses event-driven rendering when idle (0% idle CPU/GPU) and smooth 60fps rAF during playback or live key play.
 */

const BLACK_KEY_PC = new Set([1, 3, 6, 8, 10]);

function isBlackKey(midi) {
  return BLACK_KEY_PC.has(midi % 12);
}

export class PianoVisualizer {
  constructor({ rollCanvas, timelineCanvas, onSeek, onNoteDown, onNoteUp }) {
    this.rollCanvas = rollCanvas;
    this.timelineCanvas = timelineCanvas;
    this.onSeek = onSeek;
    this.onNoteDown = onNoteDown;
    this.onNoteUp = onNoteUp;

    this.notes = [];
    this.pedalIntervals = [];
    this.beats = [];
    this.chordChanges = [];
    this.duration = 0;
    this.getCurrentTime = () => 0;
    this.isAnimatingProvider = () => false;

    this.keyRects = new Map();
    this.keyboardHeight = 96;
    this.lookaheadSeconds = 4.2;

    this.manualPressed = new Set();
    this.pointerHeldMidi = null;
    this.isScrubbingTimeline = false;
    this._raf = null;

    this._bindEvents();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  setData({ notes, pedalIntervals, beats, chordChanges, duration }) {
    this.notes = notes || [];
    this.pedalIntervals = pedalIntervals || [];
    this.beats = beats || [];
    this.chordChanges = chordChanges || [];
    this.duration = duration || 0;
    this.requestRender();
  }

  setTimeProvider(timeFn, isPlayingFn = () => false) {
    this.getCurrentTime = timeFn;
    this.isAnimatingProvider = isPlayingFn;
  }

  syncAnimationState() {
    const needLoop =
      this.isAnimatingProvider() || this.manualPressed.size > 0 || this.isScrubbingTimeline;
    if (needLoop && !this._raf) {
      const tick = () => {
        this.drawFrame();
        if (
          this.isAnimatingProvider() ||
          this.manualPressed.size > 0 ||
          this.isScrubbingTimeline
        ) {
          this._raf = requestAnimationFrame(tick);
        } else {
          this._raf = null;
        }
      };
      this._raf = requestAnimationFrame(tick);
    } else if (!needLoop) {
      this.requestRender();
    }
  }

  requestRender() {
    if (this._raf) return;
    requestAnimationFrame(() => this.drawFrame());
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    for (const canvas of [this.rollCanvas, this.timelineCanvas]) {
      if (!canvas) continue;
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(300, Math.floor(rect.width));
      const h = Math.max(36, Math.floor(rect.height));
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas._logicalW = w;
      canvas._logicalH = h;
      canvas._dpr = dpr;
    }

    this._computeKeyboardGeometry();
    this.drawFrame();
  }

  _computeKeyboardGeometry() {
    const w = this.rollCanvas._logicalW || 800;
    const h = this.rollCanvas._logicalH || 420;
    this.keyboardHeight = Math.max(76, Math.min(104, Math.round(h * 0.23)));
    const kbY = h - this.keyboardHeight;

    const whiteW = w / 52;
    const blackW = whiteW * 0.62;
    const blackH = this.keyboardHeight * 0.63;

    this.keyRects.clear();
    let whiteIndex = 0;

    for (let midi = 21; midi <= 108; midi++) {
      if (!isBlackKey(midi)) {
        this.keyRects.set(midi, {
          x: whiteIndex * whiteW,
          y: kbY,
          w: whiteW,
          h: this.keyboardHeight,
          black: false,
          centerX: (whiteIndex + 0.5) * whiteW,
          laneW: whiteW * 0.84,
        });
        whiteIndex++;
      }
    }

    for (let midi = 21; midi <= 108; midi++) {
      if (isBlackKey(midi)) {
        const leftWhite = this.keyRects.get(midi - 1);
        const pc = midi % 12;
        let shift = 0;
        if (pc === 1 || pc === 6) shift = -whiteW * 0.05;
        if (pc === 3 || pc === 10) shift = whiteW * 0.05;
        const x = (leftWhite ? leftWhite.x + leftWhite.w : 0) - blackW * 0.5 + shift;
        this.keyRects.set(midi, {
          x,
          y: kbY,
          w: blackW,
          h: blackH,
          black: true,
          centerX: x + blackW * 0.5,
          laneW: blackW * 0.92,
        });
      }
    }
  }

  _hitTestKeyboard(clientX, clientY) {
    const rect = this.rollCanvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const kbTop = (this.rollCanvas._logicalH || rect.height) - this.keyboardHeight;
    if (y < kbTop) return null;

    for (let midi = 21; midi <= 108; midi++) {
      if (!isBlackKey(midi)) continue;
      const kr = this.keyRects.get(midi);
      if (kr && x >= kr.x && x <= kr.x + kr.w && y >= kr.y && y <= kr.y + kr.h) {
        return midi;
      }
    }
    for (let midi = 21; midi <= 108; midi++) {
      if (isBlackKey(midi)) continue;
      const kr = this.keyRects.get(midi);
      if (kr && x >= kr.x && x <= kr.x + kr.w && y >= kr.y && y <= kr.y + kr.h) {
        return midi;
      }
    }
    return null;
  }

  _bindEvents() {
    this.rollCanvas.addEventListener('pointerdown', (e) => {
      const midi = this._hitTestKeyboard(e.clientX, e.clientY);
      if (midi !== null) {
        this.rollCanvas.setPointerCapture(e.pointerId);
        this.pointerHeldMidi = midi;
        this.manualPressed.add(midi);
        this.onNoteDown?.(midi, 94);
        this.syncAnimationState();
        return;
      }

      if (this.duration > 0) {
        const rect = this.rollCanvas.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const fallH = (this.rollCanvas._logicalH || rect.height) - this.keyboardHeight;
        if (y >= 0 && y < fallH) {
          const fracFromBottom = 1 - y / fallH;
          const target = Math.max(
            0,
            Math.min(this.duration, this.getCurrentTime() + fracFromBottom * this.lookaheadSeconds)
          );
          this.onSeek?.(target);
          this.requestRender();
        }
      }
    });

    this.rollCanvas.addEventListener('pointermove', (e) => {
      if (this.pointerHeldMidi === null) return;
      const midi = this._hitTestKeyboard(e.clientX, e.clientY);
      if (midi !== null && midi !== this.pointerHeldMidi) {
        this.manualPressed.delete(this.pointerHeldMidi);
        this.onNoteUp?.(this.pointerHeldMidi);
        this.pointerHeldMidi = midi;
        this.manualPressed.add(midi);
        this.onNoteDown?.(midi, 88);
        this.requestRender();
      }
    });

    const releasePointer = () => {
      if (this.pointerHeldMidi !== null) {
        this.manualPressed.delete(this.pointerHeldMidi);
        this.onNoteUp?.(this.pointerHeldMidi);
        this.pointerHeldMidi = null;
        this.syncAnimationState();
        this.requestRender();
      }
    };
    this.rollCanvas.addEventListener('pointerup', releasePointer);
    this.rollCanvas.addEventListener('pointercancel', releasePointer);

    if (this.timelineCanvas) {
      const seekFromEvent = (e) => {
        if (this.duration <= 0) return;
        const rect = this.timelineCanvas.getBoundingClientRect();
        const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        this.onSeek?.(frac * this.duration);
        this.requestRender();
      };

      this.timelineCanvas.addEventListener('pointerdown', (e) => {
        this.isScrubbingTimeline = true;
        this.timelineCanvas.setPointerCapture(e.pointerId);
        seekFromEvent(e);
        this.syncAnimationState();
      });
      this.timelineCanvas.addEventListener('pointermove', (e) => {
        if (this.isScrubbingTimeline) seekFromEvent(e);
      });
      const stopScrub = () => {
        this.isScrubbingTimeline = false;
        this.syncAnimationState();
      };
      this.timelineCanvas.addEventListener('pointerup', stopScrub);
      this.timelineCanvas.addEventListener('pointercancel', stopScrub);
    }
  }

  drawFrame() {
    const now = this.getCurrentTime();
    this.drawWaterfallAndKeyboard(now);
    this.drawTimeline(now);
  }

  drawWaterfallAndKeyboard(now) {
    const canvas = this.rollCanvas;
    const ctx = canvas.getContext('2d');
    const dpr = canvas._dpr || 1;
    const w = canvas._logicalW || 800;
    const h = canvas._logicalH || 420;
    const fallH = h - this.keyboardHeight;

    ctx.save();
    ctx.scale(dpr, dpr);

    const bgGrad = ctx.createLinearGradient(0, 0, 0, fallH);
    bgGrad.addColorStop(0, '#0f0e0d');
    bgGrad.addColorStop(1, '#171513');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, fallH);

    ctx.strokeStyle = 'rgba(255, 244, 224, 0.05)';
    ctx.lineWidth = 1;
    for (let oct = 1; oct <= 8; oct++) {
      const cMidi = 12 * (oct + 1);
      const kr = this.keyRects.get(cMidi);
      if (kr) {
        ctx.beginPath();
        ctx.moveTo(kr.x, 0);
        ctx.lineTo(kr.x, fallH);
        ctx.stroke();

        ctx.fillStyle = 'rgba(255, 244, 224, 0.20)';
        ctx.font = '500 10px "JetBrains Mono", ui-monospace, monospace';
        ctx.fillText(`C${oct}`, kr.x + 3, 13);
      }
    }

    const winEnd = now + this.lookaheadSeconds;
    const timeToY = (t) => fallH * (1 - (t - now) / this.lookaheadSeconds);

    let pedalActiveNow = false;
    for (const ped of this.pedalIntervals) {
      if (ped.endTime < now && ped.startTime < now) continue;
      if (ped.startTime <= now && ped.endTime >= now) pedalActiveNow = true;
      if (ped.startTime > winEnd) break;

      const yBottom = Math.min(fallH, timeToY(Math.max(now, ped.startTime)));
      const yTop = Math.max(0, timeToY(Math.min(winEnd, ped.endTime)));
      if (yBottom > yTop) {
        ctx.fillStyle = 'rgba(218, 168, 92, 0.05)';
        ctx.fillRect(0, yTop, w, yBottom - yTop);
        ctx.fillStyle = 'rgba(218, 168, 92, 0.55)';
        ctx.fillRect(w - 5, yTop + 1, 3, Math.max(2, yBottom - yTop - 2));
      }
    }

    if (this.beats.length > 0) {
      for (let i = 0; i < this.beats.length; i++) {
        const bt = this.beats[i];
        if (bt < now) continue;
        if (bt > winEnd) break;
        const y = timeToY(bt);
        const isBar = i % 4 === 0;
        ctx.strokeStyle = isBar ? 'rgba(255, 240, 215, 0.13)' : 'rgba(255, 240, 215, 0.04)';
        ctx.lineWidth = isBar ? 1 : 0.75;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
    }

    for (const ch of this.chordChanges) {
      if (!ch.chordLabel || ch.time < now - 0.1) continue;
      if (ch.time > winEnd) break;
      const y = timeToY(ch.time);
      ctx.fillStyle = 'rgba(229, 184, 105, 0.62)';
      ctx.font = '600 10px "Inter", system-ui, sans-serif';
      ctx.fillText(ch.chordLabel, 8, Math.max(12, y - 4));
    }

    const activeKeys = new Map();
    for (const m of this.manualPressed) activeKeys.set(m, 'melody');

    for (const n of this.notes) {
      const nEnd = n.startTime + n.duration;
      if (nEnd < now) continue;
      if (n.startTime > winEnd) break;

      if (n.startTime <= now && nEnd >= now) {
        activeKeys.set(n.pitch, n.role === 'melody' ? 'melody' : n.hand);
      }

      const kr = this.keyRects.get(n.pitch);
      if (!kr) continue;

      const yBottom = Math.min(fallH, timeToY(Math.max(now, n.startTime)));
      const yTop = Math.max(0, timeToY(Math.min(winEnd, nEnd)));
      const barH = Math.max(4, yBottom - yTop);
      const barW = kr.laneW;
      const barX = kr.centerX - barW * 0.5;

      let fill = '#63a89e';
      let border = 'rgba(150, 224, 212, 0.55)';
      if (n.role === 'melody') {
        fill = '#e6aa48';
        border = '#ffd993';
      } else if (n.hand === 'RH') {
        fill = '#cbb48c';
        border = 'rgba(255, 243, 219, 0.55)';
      }

      ctx.fillStyle = fill;
      this._roundRect(ctx, barX, yTop, barW, barH, Math.min(4, barW * 0.35));
      ctx.fill();

      ctx.strokeStyle = border;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    if (this.notes.length === 0) {
      ctx.fillStyle = 'rgba(235, 225, 208, 0.32)';
      ctx.font = '500 13px "Inter", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(
        'Drop any audio file above — or click the 88-key Yamaha C5 Grand Piano below to play live',
        w * 0.5,
        fallH * 0.52
      );
      ctx.textAlign = 'left';
    }

    const railGrad = ctx.createLinearGradient(0, fallH - 4, 0, fallH + 2);
    railGrad.addColorStop(0, pedalActiveNow ? '#d99b38' : '#5e1d1d');
    railGrad.addColorStop(1, '#261111');
    ctx.fillStyle = railGrad;
    ctx.fillRect(0, fallH - 3, w, 4);

    for (let midi = 21; midi <= 108; midi++) {
      if (isBlackKey(midi)) continue;
      const kr = this.keyRects.get(midi);
      const activeRole = activeKeys.get(midi);

      if (activeRole) {
        ctx.fillStyle =
          activeRole === 'melody' ? '#f3bc62' : activeRole === 'RH' ? '#e7d4b1' : '#79beb3';
      } else {
        const kGrad = ctx.createLinearGradient(0, kr.y, 0, kr.y + kr.h);
        kGrad.addColorStop(0, '#ede7dc');
        kGrad.addColorStop(0.92, '#faf6ee');
        kGrad.addColorStop(1, '#cfc6b6');
        ctx.fillStyle = kGrad;
      }

      ctx.fillRect(kr.x + 0.5, kr.y, kr.w - 1, kr.h - 1);
      ctx.strokeStyle = '#1b1815';
      ctx.lineWidth = 1;
      ctx.strokeRect(kr.x + 0.5, kr.y, kr.w - 1, kr.h - 1);

      if (midi === 60) {
        ctx.fillStyle = activeRole ? '#1c1815' : 'rgba(60, 50, 40, 0.45)';
        ctx.font = '600 9px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText('C4', kr.centerX, kr.y + kr.h - 7);
        ctx.textAlign = 'left';
      }
    }

    for (let midi = 21; midi <= 108; midi++) {
      if (!isBlackKey(midi)) continue;
      const kr = this.keyRects.get(midi);
      const activeRole = activeKeys.get(midi);

      if (activeRole) {
        ctx.fillStyle =
          activeRole === 'melody' ? '#d8962e' : activeRole === 'RH' ? '#bfa375' : '#4a9085';
      } else {
        const bGrad = ctx.createLinearGradient(0, kr.y, 0, kr.y + kr.h);
        bGrad.addColorStop(0, '#2a2623');
        bGrad.addColorStop(0.85, '#151311');
        bGrad.addColorStop(1, '#38322d');
        ctx.fillStyle = bGrad;
      }

      this._roundRect(ctx, kr.x, kr.y, kr.w, kr.h, 2);
      ctx.fill();
      ctx.strokeStyle = '#090807';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    ctx.restore();
  }

  drawTimeline(now) {
    const canvas = this.timelineCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = canvas._dpr || 1;
    const w = canvas._logicalW || 800;
    const h = canvas._logicalH || 44;

    ctx.save();
    ctx.scale(dpr, dpr);

    ctx.fillStyle = '#141210';
    ctx.fillRect(0, 0, w, h);

    if (this.duration > 0 && this.notes.length > 0) {
      for (const ped of this.pedalIntervals) {
        const x0 = (ped.startTime / this.duration) * w;
        const x1 = (ped.endTime / this.duration) * w;
        ctx.fillStyle = 'rgba(218, 168, 92, 0.14)';
        ctx.fillRect(x0, h - 5, Math.max(1, x1 - x0), 3);
      }

      for (const n of this.notes) {
        const x = (n.startTime / this.duration) * w;
        const nw = Math.max(1.5, (n.duration / this.duration) * w);
        const y = h - 7 - ((n.pitch - 21) / 87) * (h - 12);
        ctx.fillStyle =
          n.role === 'melody'
            ? 'rgba(235, 174, 76, 0.9)'
            : n.hand === 'RH'
              ? 'rgba(205, 182, 142, 0.55)'
              : 'rgba(99, 168, 158, 0.65)';
        ctx.fillRect(x, y, nw, 2);
      }

      const px = Math.max(0, Math.min(w, (now / this.duration) * w));
      ctx.fillStyle = 'rgba(230, 170, 72, 0.08)';
      ctx.fillRect(0, 0, px, h);

      ctx.strokeStyle = '#f0b85b';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.stroke();
    } else {
      ctx.fillStyle = 'rgba(255, 244, 224, 0.22)';
      ctx.font = '500 11px "JetBrains Mono", monospace';
      ctx.fillText('TIMELINE OVERVIEW', 12, h * 0.5 + 4);
    }

    ctx.restore();
  }

  _roundRect(ctx, x, y, w, h, r) {
    const rad = Math.min(r, w * 0.5, h * 0.5);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.lineTo(x + w - rad, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
    ctx.lineTo(x + w, y + h - rad);
    ctx.quadraticCurveTo(x + w, y, x + w - rad, y + h);
    ctx.lineTo(x + rad, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
    ctx.lineTo(x, y + rad);
    ctx.quadraticCurveTo(x, y, x + rad, y);
    ctx.closePath();
  }
}
