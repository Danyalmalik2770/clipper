import type { CaptionTemplate, WordToken } from '../types';

const PROFANITY_LIST = ['fuck', 'shit', 'bitch', 'asshole', 'bastard', 'dick', 'cunt', 'damn'];

export function maskProfanity(word: string, enabled: boolean): string {
  if (!enabled) return word;
  const lower = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!PROFANITY_LIST.includes(lower)) return word;
  return word.replace(/[a-zA-Z]/g, (ch, idx) => (idx === 0 ? ch : '*'));
}

function toAssColor(hex: string, alpha = '00'): string {
  const clean = hex.replace('#', '').padStart(6, '0');
  const r = clean.slice(0, 2);
  const g = clean.slice(2, 4);
  const b = clean.slice(4, 6);
  return `&H${alpha}${b}${g}${r}`.toUpperCase();
}

function formatAssTime(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = (s % 60).toFixed(2).padStart(5, '0');
  return `${h}:${String(m).padStart(2, '0')}:${rem}`;
}

function escapeAssText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}

/**
 * Generates an ASS subtitle script with active word-by-word color highlighting,
 * optional title header overlay, profanity masking, and emoji/UTF-8 support.
 */
export function generateAssSubtitles(params: {
  words: WordToken[];
  template: CaptionTemplate;
  fontFamily: string;
  profanityMask: boolean;
  title: string;
  titlePosition: 'top' | 'bottom' | 'hidden';
  durationSec: number;
}): string {
  const tpl = params.template;
  const font = params.fontFamily || tpl.fontFamily;
  const primary = toAssColor(tpl.primaryColor);
  const highlight = toAssColor(tpl.highlightColor);
  const outline = toAssColor(tpl.strokeColor);
  const shadow = toAssColor(tpl.shadowColor, '66');
  const boxBg = tpl.backgroundColor ? toAssColor(tpl.backgroundColor, '33') : '&H80000000';
  const borderStyle = tpl.animation === 'box' ? 3 : 1;

  const lines: string[] = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Caption,${font},${tpl.fontSize},${primary},${highlight},${outline},${borderStyle === 3 ? boxBg : shadow},-1,0,0,0,100,100,0,0,${borderStyle},${tpl.strokeWidth},${tpl.shadowDepth},2,60,60,280,1`,
    `Style: Title,${font},62,&H00FFFFFF,&H00FFFFFF,&H00000000,&H99000000,-1,0,0,0,100,100,0,0,3,6,2,8,70,70,120,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  if (params.titlePosition !== 'hidden' && params.title.trim()) {
    const an = params.titlePosition === 'top' ? '\\an8\\pos(540,130)' : '\\an2\\pos(540,1760)';
    lines.push(
      `Dialogue: 2,0:00:00.00,${formatAssTime(params.durationSec)},Title,,0,0,0,,{${an}}${escapeAssText(params.title)}`
    );
  }

  const perLine = Math.max(1, tpl.wordsPerLine || 3);
  for (let i = 0; i < params.words.length; i += perLine) {
    const group = params.words.slice(i, i + perLine);
    for (let activeIdx = 0; activeIdx < group.length; activeIdx++) {
      const activeWord = group[activeIdx];
      const nextWord = group[activeIdx + 1];
      const evStart = activeWord.start;
      const evEnd = nextWord ? Math.max(evStart + 0.05, nextWord.start) : Math.max(evStart + 0.15, activeWord.end);

      const rendered = group
        .map((w, idx) => {
          let txt = maskProfanity(w.word, params.profanityMask);
          if (tpl.uppercase) txt = txt.toUpperCase();
          txt = escapeAssText(txt);
          if (idx === activeIdx) {
            const popTag = tpl.animation === 'pop' || tpl.animation === 'bounce' ? '\\fscx112\\fscy112' : '';
            return `{\\c${highlight}${popTag}}${txt}{\\c${primary}\\fscx100\\fscy100}`;
          }
          return txt;
        })
        .join(' ');

      lines.push(
        `Dialogue: 1,${formatAssTime(evStart)},${formatAssTime(evEnd)},Caption,,0,0,0,,${rendered}`
      );
    }
  }

  return lines.join('\n');
}
