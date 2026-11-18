import type { AppSettings } from '../types';

export interface TranscriptAnalysis {
  score: number; // 0..1
  title: string;
  reason: string;
}

const HOOK_PATTERNS = [
  /\b(wait|watch this|look at|no way|what the|are you kidding|bro|listen|hear me out|spoiler|secret|mistake|never)\b/i,
  /[?!]{1,}/,
];

const REACTION_WORDS = new Set([
  'insane', 'crazy', 'unbelievable', 'impossible', 'clutch', 'destroyed',
  'laughing', 'hilarious', 'dead', 'oh', 'god', 'holy', 'wtf', 'genius',
  'scared', 'panic', 'win', 'lost', 'fail', 'broken', 'secret', 'viral',
]);

/**
 * 100% Free built-in heuristic scorer (zero API keys required).
 */
export function scoreTranscriptFreeLocal(text: string): TranscriptAnalysis {
  const clean = text.trim();
  if (!clean) {
    return { score: 0.15, title: 'Highlight Moment', reason: 'High audio/visual intensity' };
  }

  const words = clean.toLowerCase().split(/\s+/);
  let hookScore = 0;
  for (const rx of HOOK_PATTERNS) {
    if (rx.test(clean)) hookScore += 0.18;
  }

  let reactionHits = 0;
  for (const w of words) {
    if (REACTION_WORDS.has(w.replace(/[^a-z0-9]/g, ''))) reactionHits++;
  }

  const densityScore = Math.min(0.25, words.length / 180);
  const reactionScore = Math.min(0.4, reactionHits * 0.12);
  const total = Math.min(1, 0.22 + hookScore + reactionScore + densityScore);

  const sentences = clean.split(/(?<=[.!?])\s+/).filter((s) => s.length > 8);
  const shortTitle = (sentences[0] ?? clean).split(/\s+/).slice(0, 7).join(' ').replace(/["'`]/g, '');

  const reasons: string[] = [];
  if (hookScore > 0.15) reasons.push('strong opening hook');
  if (reactionHits > 0) reasons.push('high emotional/humor energy');
  if (words.length > 45) reasons.push('fast-paced commentary');

  return {
    score: Number(total.toFixed(3)),
    title: shortTitle.length > 4 ? shortTitle : 'Must-Watch Stream Moment',
    reason: reasons.length > 0 ? `Detected ${reasons.join(' + ')}` : 'Engaging speech & pace',
  };
}

/**
 * Defaults to free local scoring; optionally uses user's Ollama (free) or OpenAI/Anthropic.
 */
export async function scoreTranscript(text: string, settings: AppSettings): Promise<TranscriptAnalysis> {
  const fallback = scoreTranscriptFreeLocal(text);
  if (!text.trim() || settings.llmProvider === 'none') return fallback;

  const prompt = `Analyze this livestream transcript for YouTube Shorts virality (hook, humor, drama, surprise).
Reply ONLY JSON: {"score": 0.0-1.0, "title": "<=7 words", "reason": "1 sentence"}.
Transcript: """${text.slice(0, 1200)}"""`;

  try {
    if (settings.llmProvider === 'ollama') {
      const res = await fetch(`${settings.ollamaUrl.replace(/\/$/, '')}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: settings.ollamaModel, prompt, stream: false, format: 'json' }),
      });
      if (!res.ok) return fallback;
      const data = (await res.json()) as { response?: string };
      const parsed = JSON.parse(data.response ?? '{}') as Partial<TranscriptAnalysis>;
      return {
        score: Math.min(1, Math.max(0, Number(parsed.score ?? fallback.score))),
        title: parsed.title || fallback.title,
        reason: parsed.reason || fallback.reason,
      };
    }

    if (settings.llmProvider === 'openai' && settings.openaiApiKey) {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.openaiApiKey}` },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) return fallback;
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? '{}') as Partial<TranscriptAnalysis>;
      return {
        score: Math.min(1, Math.max(0, Number(parsed.score ?? fallback.score))),
        title: parsed.title || fallback.title,
        reason: parsed.reason || fallback.reason,
      };
    }

    if (settings.llmProvider === 'anthropic' && settings.anthropicApiKey) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': settings.anthropicApiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-3-5-haiku-latest',
          max_tokens: 200,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) return fallback;
      const data = (await res.json()) as { content?: Array<{ text?: string }> };
      const match = (data.content?.[0]?.text ?? '{}').match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(match ? match[0] : '{}') as Partial<TranscriptAnalysis>;
      return {
        score: Math.min(1, Math.max(0, Number(parsed.score ?? fallback.score))),
        title: parsed.title || fallback.title,
        reason: parsed.reason || fallback.reason,
      };
    }
  } catch {
    return fallback;
  }
  return fallback;
}

export interface TranscriptChunk {
  startSec: number;
  endSec: number;
  text: string;
}

export interface ViralMomentPick {
  startSec: number;
  endSec: number;
  score: number;
  title: string;
  reason: string;
}

/**
 * Picks the top viral moments across a full transcript (used by the
 * full-VOD pipeline). Scores every chunk with scoreTranscript (LLM when
 * configured, built-in heuristics otherwise), expands the best chunks to
 * the configured clip length and de-duplicates overlapping windows.
 * Never throws: a failed chunk falls back to the free local scorer.
 */
export async function pickViralMomentsFromTranscript(
  chunks: TranscriptChunk[],
  settings: AppSettings,
): Promise<ViralMomentPick[]> {
  if (!chunks || chunks.length === 0) return [];
  const scored: Array<{ chunk: TranscriptChunk; a: TranscriptAnalysis }> = [];
  for (const chunk of chunks) {
    const text = (chunk.text || '').trim();
    if (!text) continue;
    let a: TranscriptAnalysis;
    try {
      a = await scoreTranscript(text, settings);
    } catch {
      a = scoreTranscriptFreeLocal(text);
    }
    scored.push({ chunk, a });
  }
  scored.sort((x, y) => y.a.score - x.a.score);
  const picks: ViralMomentPick[] = [];
  for (const s of scored) {
    if (picks.length >= 8) break;
    let start = s.chunk.startSec;
    let end = s.chunk.endSec;
    const len = end - start;
    if (len < settings.minClipSeconds) {
      const pad = (settings.minClipSeconds - len) / 2;
      start = Math.max(0, start - pad);
      end += pad;
    }
    if (end - start > settings.maxClipSeconds) end = start + settings.maxClipSeconds;
    if (picks.some((p) => Math.abs(p.startSec - start) < settings.minClipSeconds)) continue;
    picks.push({
      startSec: Number(start.toFixed(2)),
      endSec: Number(end.toFixed(2)),
      score: s.a.score,
      title: s.a.title,
      reason: s.a.reason,
    });
  }
  return picks.sort((a, b) => a.startSec - b.startSec);
}

/**
 * Tests the configured LLM provider connection for the Settings page.
 * Returns { ok, message } and never throws.
 */
export async function testLlmConnection(
  settings: AppSettings,
): Promise<{ ok: boolean; message: string }> {
  const provider = settings.llmProvider;
  if (provider === 'none') {
    return { ok: true, message: 'Built-in free local scorer is active — no API key needed.' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    if (provider === 'openai') {
      if (!settings.openaiApiKey) return { ok: false, message: 'OpenAI API key is empty.' };
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${settings.openaiApiKey}` },
        signal: ctrl.signal,
      });
      return res.ok
        ? { ok: true, message: 'OpenAI connection OK.' }
        : { ok: false, message: `OpenAI replied ${res.status} — check the API key.` };
    }
    if (provider === 'anthropic') {
      if (!settings.anthropicApiKey) return { ok: false, message: 'Anthropic API key is empty.' };
      const res = await fetch('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': settings.anthropicApiKey, 'anthropic-version': '2023-06-01' },
        signal: ctrl.signal,
      });
      return res.ok
        ? { ok: true, message: 'Anthropic connection OK.' }
        : { ok: false, message: `Anthropic replied ${res.status} — check the API key.` };
    }
    if (provider === 'gemini') {
      if (!settings.geminiApiKey) return { ok: false, message: 'Gemini API key is empty.' };
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(settings.geminiApiKey)}`,
        { signal: ctrl.signal },
      );
      return res.ok
        ? { ok: true, message: `Gemini connection OK (model: ${settings.geminiModel || 'gemini-2.5-flash'}).` }
        : { ok: false, message: `Gemini replied ${res.status} — check the API key.` };
    }
    // ollama
    const base = (settings.ollamaUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
    const res = await fetch(`${base}/api/tags`, { signal: ctrl.signal });
    return res.ok
      ? { ok: true, message: `Ollama reachable at ${base}.` }
      : { ok: false, message: `Ollama replied ${res.status} at ${base}.` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Connection failed: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}
