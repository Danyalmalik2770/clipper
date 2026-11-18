import assert from 'node:assert/strict';
import test from 'node:test';
import { generateAssSubtitles, maskProfanity } from '../engines/captions';
import { buildLayoutFilterGraph, suggestLayoutFromFacecam } from '../engines/layout';

test('auto-suggests stacked when facecam is detected, fullscreen otherwise', () => {
  assert.equal(suggestLayoutFromFacecam({ x: 0.05, y: 0.7, w: 0.2, h: 0.25 }), 'stacked');
  assert.equal(suggestLayoutFromFacecam(null), 'fullscreen');
});

test('builds valid filter graphs for all 4 vertical 1080x1920 layouts', () => {
  const box = { x: 0.02, y: 0.68, w: 0.25, h: 0.28 };
  for (const mode of ['fullscreen', 'stacked', 'pip', 'split'] as const) {
    const res = buildLayoutFilterGraph({
      sourceWidth: 1920,
      sourceHeight: 1080,
      mode,
      template: { id: mode, name: mode, mode, topRatio: 0.38, pipScale: 0.3, pipPosition: 'bottom-right' },
      facecamBox: box,
    });
    assert.ok(res.filterComplex.includes('1080'));
    assert.ok(res.filterComplex.includes('[vout]'));
  }
});

test('profanity mask and ASS generator produce highlighted word events', () => {
  assert.equal(maskProfanity('fuck', true), 'f***');
  assert.equal(maskProfanity('fuck', false), 'fuck');

  const ass = generateAssSubtitles({
    words: [
      { word: 'No', start: 0.1, end: 0.4 },
      { word: 'way!', start: 0.45, end: 0.9 },
    ],
    template: {
      id: 'bold-pop',
      name: 'Bold Pop',
      description: '',
      fontFamily: 'Montserrat',
      fontSize: 78,
      primaryColor: '#FFFFFF',
      highlightColor: '#FACC15',
      strokeColor: '#000000',
      strokeWidth: 6,
      shadowColor: '#000000',
      shadowDepth: 3,
      animation: 'pop',
      uppercase: true,
      wordsPerLine: 2,
    },
    fontFamily: 'Montserrat',
    profanityMask: true,
    title: 'Insane Moment',
    titlePosition: 'top',
    durationSec: 15,
  });
  assert.ok(ass.includes('Dialogue:'));
  assert.ok(ass.includes('Insane Moment'));
});
