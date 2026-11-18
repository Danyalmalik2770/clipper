import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSignalTimeline, selectViralWindows } from '../engines/detector';
import { scoreTranscriptFreeLocal } from '../engines/llm-scorer';
import { computeChatScores } from '../engines/signals';

test('free local transcript scorer rewards strong hooks and reactions', () => {
  const hype = scoreTranscriptFreeLocal('Wait watch this! No way bro that was insane and hilarious!');
  const flat = scoreTranscriptFreeLocal('Moving to the next menu option now.');
  assert.ok(hype.score > flat.score);
  assert.ok(hype.title.length > 0);
});

test('chat spike detector identifies hype bursts', () => {
  const msgs = [
    { timestampSec: 1, message: 'hi' },
    { timestampSec: 5, message: 'LOL KEKW 😂' },
    { timestampSec: 5.2, message: 'OMG NO WAY 😂' },
    { timestampSec: 5.4, message: 'LMAO POGGERS 🔥' },
    { timestampSec: 5.6, message: 'HAHAHAHA 💀' },
  ];
  const { scores, rates } = computeChatScores(msgs, 0, 10);
  assert.equal(rates[5], 4);
  assert.ok(scores[5] > scores[1]);
});

test('selectViralWindows enforces clip bounds and skips overlaps', () => {
  const timeline = buildSignalTimeline({
    startSec: 0,
    chatScores: new Array(40).fill(0).map((_, i) => (i === 15 ? 0.95 : 0.1)),
    chatRates: new Array(40).fill(0),
    audioScores: new Array(40).fill(0).map((_, i) => (i === 15 ? 0.9 : 0.2)),
    motionScores: new Array(40).fill(0.4),
    llmScore: 0.85,
  });
  const windows = selectViralWindows(timeline, [{ word: 'Wait', start: 7.2, end: 7.6 }], {
    threshold: 0.6,
    minLen: 15,
    maxLen: 60,
  });
  assert.equal(windows.length, 1);
  assert.ok(windows[0].endSec - windows[0].startSec >= 15);
});
