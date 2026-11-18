import type { SignalSample, WordToken } from '../types';

export interface DetectedWindow {
  startSec: number;
  endSec: number;
  score: number;
}

/**
 * Fuses chat, audio, visual motion, and transcript/LLM scores into per-second SignalSamples.
 */
export function buildSignalTimeline(params: {
  startSec: number;
  chatScores: number[];
  chatRates: number[];
  audioScores: number[];
  motionScores: number[];
  llmScore: number;
}): SignalSample[] {
  const len = Math.max(params.audioScores.length, params.motionScores.length, params.chatScores.length);
  const hasChat = params.chatScores.some((s) => s > 0);
  const samples: SignalSample[] = [];

  for (let i = 0; i < len; i++) {
    const chat = params.chatScores[i] ?? 0;
    const audio = params.audioScores[i] ?? 0;
    const motion = params.motionScores[i] ?? 0;
    const llm = params.llmScore;

    const combined = hasChat
      ? 0.30 * chat + 0.25 * audio + 0.15 * motion + 0.30 * llm
      : 0.38 * audio + 0.22 * motion + 0.40 * llm;

    samples.push({
      timestamp: params.startSec + i,
      chatScore: Number(chat.toFixed(3)),
      audioScore: Number(audio.toFixed(3)),
      motionScore: Number(motion.toFixed(3)),
      llmScore: Number(llm.toFixed(3)),
      combinedScore: Number(Math.min(1, combined).toFixed(3)),
      chatRate: params.chatRates[i] ?? 0,
    });
  }
  return samples;
}

/**
 * Finds non-overlapping viral peaks and auto-trims them to [minLen, maxLen] seconds,
 * snapping the clip start to a clean sentence/hook word boundary when available.
 */
export function selectViralWindows(
  samples: SignalSample[],
  words: WordToken[],
  options: { threshold: number; minLen: number; maxLen: number }
): DetectedWindow[] {
  if (samples.length === 0) return [];
  const totalStart = samples[0].timestamp;
  const totalEnd = samples[samples.length - 1].timestamp + 1;

  const peaks = samples
    .map((s, idx) => ({ idx, score: s.combinedScore }))
    .filter((p) => p.score >= options.threshold)
    .sort((a, b) => b.score - a.score);

  const accepted: DetectedWindow[] = [];

  for (const peak of peaks) {
    const peakTime = samples[peak.idx].timestamp;
    if (accepted.some((w) => peakTime >= w.startSec - 4 && peakTime <= w.endSec + 4)) {
      continue;
    }

    let rawStart = Math.max(totalStart, peakTime - 8);
    let rawEnd = Math.min(totalEnd, rawStart + Math.min(options.maxLen, Math.max(options.minLen, 28)));

    const hookCandidate = words.find(
      (w) => w.start >= rawStart - 3.5 && w.start <= rawStart + 2.5 && /^[A-Z0-9"']/.test(w.word)
    );
    if (hookCandidate) {
      rawStart = Math.max(totalStart, hookCandidate.start - 0.15);
    }

    if (rawEnd - rawStart < options.minLen) {
      rawEnd = Math.min(totalEnd, rawStart + options.minLen);
      rawStart = Math.max(totalStart, rawEnd - options.minLen);
    }
    if (rawEnd - rawStart > options.maxLen) {
      rawEnd = rawStart + options.maxLen;
    }

    if (rawEnd - rawStart >= Math.min(options.minLen, totalEnd - totalStart)) {
      accepted.push({
        startSec: Number(rawStart.toFixed(2)),
        endSec: Number(rawEnd.toFixed(2)),
        score: Number(peak.score.toFixed(3)),
      });
    }
  }

  return accepted;
}
