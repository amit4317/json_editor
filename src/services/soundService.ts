/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

class SoundService {
  private audioCtx: AudioContext | null = null;

  private init() {
    if (!this.audioCtx) {
      this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
  }

  private playTone(freq: number, type: OscillatorType, duration: number, volume: number = 0.1) {
    this.init();
    if (!this.audioCtx) return;

    const osc = this.audioCtx.createOscillator();
    const gain = this.audioCtx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, this.audioCtx.currentTime);

    gain.gain.setValueAtTime(volume, this.audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, this.audioCtx.currentTime + duration);

    osc.connect(gain);
    gain.connect(this.audioCtx.destination);

    osc.start();
    osc.stop(this.audioCtx.currentTime + duration);
  }

  playSuccess() {
    this.playTone(880, 'sine', 0.2, 0.05); // A5
  }

  playDelete() {
    this.playTone(220, 'sine', 0.3, 0.08); // A3
  }

  playConnect() {
    this.playTone(440, 'sine', 0.1, 0.05); // A4
  }

  playToggle() {
    this.playTone(660, 'sine', 0.15, 0.05); // E5
  }

  playExport() {
    this.init();
    if (!this.audioCtx) return;
    const now = this.audioCtx.currentTime;
    [440, 554, 659].forEach((f, i) => {
      setTimeout(() => this.playTone(f, 'sine', 0.2, 0.05), i * 100);
    });
  }
}

export const soundService = new SoundService();
