import { spawn } from 'node:child_process';

const HYPE_TOKENS = new Set([
  'lol', 'lmao', 'lmfao', 'rofl', 'kekw', 'omegalul', 'pog', 'poggers',
  'w', 'clip', 'insane', 'crazy', 'no', 'way', 'what', 'omg', 'wtf', 'bro',
  'haha', 'hahaha', '💀', '😂', '🤣', '🔥', '😱', '🤯', '👏',
]);

/**
 * Computes per-second normalized audio loudness & peak deltas (0..1) via local ffmpeg.
 */
export function computeAudioEnergy(
  ffmpegPath: string,
  mediaPath: string,
  durationSec: number
): Promise<number[]> {
  return new Promise((resolve) => {
    const sampleRate = 4000;
    const proc = spawn(ffmpegPath, [
      '-v', 'error',
      '-i', mediaPath,
      '-vn',
      '-ac', '1',
      '-ar', String(sampleRate),
      '-f', 'f32le',
      'pipe:1',
    ]);

    const chunks: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.on('close', () => {
      const buf = Buffer.concat(chunks);
      const samples = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
      const numSecs = Math.max(1, Math.ceil(durationSec));
      const rmsPerSec: number[] = [];

      for (let s = 0; s < numSecs; s++) {
        const start = s * sampleRate;
        const end = Math.min(samples.length, (s + 1) * sampleRate);
        if (end <= start) {
          rmsPerSec.push(0);
          continue;
        }
        let sumSq = 0;
        for (let i = start; i < end; i++) {
          sumSq += samples[i] * samples[i];
        }
        rmsPerSec.push(Math.sqrt(sumSq / (end - start)));
      }

      const maxRms = Math.max(0.001, ...rmsPerSec);
      const meanRms = rmsPerSec.reduce((a, b) => a + b, 0) / rmsPerSec.length;

      const scores = rmsPerSec.map((rms) => {
        const level = rms / maxRms;
        const spike = Math.max(0, (rms - meanRms) / (maxRms + 1e-6));
        return Math.min(1, 0.55 * level + 0.45 * spike);
      });
      resolve(scores);
    });
    proc.on('error', () => resolve(new Array(Math.max(1, Math.ceil(durationSec))).fill(0)));
  });
}

/**
 * Computes per-second visual motion / scene-change spikes (0..1) using raw 64x36 gray frames from ffmpeg.
 */
export function computeVisualMotion(
  ffmpegPath: string,
  mediaPath: string,
  durationSec: number
): Promise<number[]> {
  return new Promise((resolve) => {
    const w = 64;
    const h = 36;
    const fps = 2;
    const frameSize = w * h;

    const proc = spawn(ffmpegPath, [
      '-v', 'error',
      '-i', mediaPath,
      '-vf', `fps=${fps},scale=${w}:${h},format=gray`,
      '-f', 'rawvideo',
      'pipe:1',
    ]);

    const chunks: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.on('close', () => {
      const buf = Buffer.concat(chunks);
      const numFrames = Math.floor(buf.length / frameSize);
      const numSecs = Math.max(1, Math.ceil(durationSec));
      const perSecDiff = new Array<number>(numSecs).fill(0);
      const perSecCount = new Array<number>(numSecs).fill(0);

      for (let f = 1; f < numFrames; f++) {
        const prevOff = (f - 1) * frameSize;
        const currOff = f * frameSize;
        let mad = 0;
        for (let p = 0; p < frameSize; p++) {
          mad += Math.abs(buf[currOff + p] - buf[prevOff + p]);
        }
        const normDiff = mad / (frameSize * 255);
        const secIdx = Math.min(numSecs - 1, Math.floor(f / fps));
        perSecDiff[secIdx] += normDiff;
        perSecCount[secIdx] += 1;
      }

      const raw = perSecDiff.map((sum, i) => (perSecCount[i] > 0 ? sum / perSecCount[i] : 0));
      const maxDiff = Math.max(0.05, ...raw);
      resolve(raw.map((v) => Math.min(1, v / maxDiff)));
    });
    proc.on('error', () => resolve(new Array(Math.max(1, Math.ceil(durationSec))).fill(0)));
  });
}

/**
 * Computes per-second live chat spike & hype-emote density score (0..1).
 */
export function computeChatScores(
  messages: Array<{ timestampSec: number; message: string }>,
  startSec: number,
  durationSec: number
): { scores: number[]; rates: number[] } {
  const numSecs = Math.max(1, Math.ceil(durationSec));
  const counts = new Array<number>(numSecs).fill(0);
  const hypeHits = new Array<number>(numSecs).fill(0);

  for (const m of messages) {
    const idx = Math.floor(m.timestampSec - startSec);
    if (idx < 0 || idx >= numSecs) continue;
    counts[idx] += 1;
    const tokens = m.message.toLowerCase().split(/\s+/);
    if (tokens.some((t) => HYPE_TOKENS.has(t) || /(ha){2,}|lol|😂|💀|🔥/.test(t))) {
      hypeHits[idx] += 1;
    }
  }

  const mean = counts.reduce((a, b) => a + b, 0) / numSecs;
  const variance = counts.reduce((a, c) => a + (c - mean) ** 2, 0) / numSecs;
  const std = Math.sqrt(variance) || 1;

  const scores = counts.map((c, i) => {
    if (c === 0) return 0;
    const z = Math.max(0, (c - mean) / std);
    const rateNorm = Math.min(1, z / 3.0);
    const hypeRatio = hypeHits[i] / c;
    return Math.min(1, 0.65 * rateNorm + 0.35 * hypeRatio);
  });

  return { scores, rates: counts };
}
