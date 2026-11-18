export type StreamStatus = 'idle' | 'ingesting' | 'stopped' | 'error';
export type LayoutMode = 'fullscreen' | 'stacked' | 'pip' | 'split';
export type LLMProvider = 'none' | 'openai' | 'anthropic' | 'ollama';

export interface RectNormalized {
  x: number; // 0..1
  y: number; // 0..1
  w: number; // 0..1
  h: number; // 0..1
}

export interface WordToken {
  word: string;
  start: number; // seconds relative to clip start
  end: number;
  confidence?: number;
}

export interface StreamRecord {
  id: string;
  url: string;
  title: string;
  channel: string;
  isLive: boolean;
  status: StreamStatus;
  bufferSeconds: number;
  clipsCount: number;
  createdAt: number;
  errorMessage?: string | null;
}

export interface SignalSample {
  timestamp: number; // stream relative seconds
  chatScore: number;
  audioScore: number;
  motionScore: number;
  llmScore: number;
  combinedScore: number;
  chatRate: number;
}

export interface ClipRecord {
  id: string;
  streamId: string;
  title: string;
  reason: string;
  viralityScore: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  sourcePath: string;
  thumbnailPath: string | null;
  renderedPath: string | null;
  layoutMode: LayoutMode;
  layoutTemplateId: string;
  captionTemplateId: string;
  fontFamily: string;
  profanityMask: boolean;
  titlePosition: 'top' | 'bottom' | 'hidden';
  facecamBox: RectNormalized | null;
  suggestedLayout: LayoutMode;
  words: WordToken[];
  createdAt: number;
}

export interface CaptionTemplate {
  id: string;
  name: string;
  description: string;
  fontFamily: string;
  fontSize: number;
  primaryColor: string;
  highlightColor: string;
  strokeColor: string;
  strokeWidth: number;
  shadowColor: string;
  shadowDepth: number;
  backgroundColor?: string;
  animation: 'pop' | 'karaoke' | 'clean' | 'glow' | 'bounce' | 'typewriter' | 'box' | 'gradient';
  uppercase: boolean;
  wordsPerLine: number;
}

export interface LayoutTemplate {
  id: string;
  name: string;
  mode: LayoutMode;
  topRatio?: number; // for stacked (e.g., 0.38 = 38% facecam)
  pipPosition?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  pipScale?: number; // 0.2..0.45
  pipRounded?: boolean;
  smartCrop?: boolean;
  blurBackground?: boolean;
}

export interface AppSettings {
  storagePath: string;
  bufferHours: number;
  segmentSeconds: number;
  whisperModel: string;
  llmProvider: LLMProvider;
  openaiApiKey: string;
  anthropicApiKey: string;
  ollamaUrl: string;
  ollamaModel: string;
  viralityThreshold: number;
  minClipSeconds: number;
  maxClipSeconds: number;
  outputFps: 30 | 60;
  outputCrf: number;
  theme: 'dark' | 'light';
}

export type ClipperEvent =
  | { type: 'stream:status'; streamId: string; status: StreamStatus; bufferSeconds: number; error?: string }
  | { type: 'monitor:signal'; streamId: string; sample: SignalSample }
  | { type: 'clip:detected'; streamId: string; clip: ClipRecord }
  | {
      type: 'render:progress';
      clipId: string;
      progress: number;
      status: 'rendering' | 'done' | 'error';
      outputPath?: string;
      error?: string;
    };
