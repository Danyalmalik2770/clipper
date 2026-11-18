export type StreamStatus = 'idle' | 'ingesting' | 'stopped' | 'error';
export type DownloadState =
  | 'idle'
  | 'downloading'
  | 'throttled-retrying'
  | 'blocked-waiting'
  | 'stopped'
  | 'error';
export type LayoutMode = 'fullscreen' | 'stacked' | 'pip' | 'split';
export type LLMProvider = 'none' | 'openai' | 'anthropic' | 'ollama';

export interface RectNormalized {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WordToken {
  word: string;
  start: number;
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
  downloadState?: DownloadState;
  retryInSec?: number;
  activeClient?: string;
  downloadSpeedKbps?: number;
}

export interface SignalSample {
  timestamp: number;
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
  topRatio?: number;
  pipPosition?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  pipScale?: number;
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
  forceIpv4?: boolean;
  cookiesPath?: string;
}

export type ClipperEvent =
  | {
      type: 'stream:status';
      streamId: string;
      status: StreamStatus;
      bufferSeconds: number;
      error?: string;
      downloadState?: DownloadState;
      retryInSec?: number;
      activeClient?: string;
      downloadSpeedKbps?: number;
    }
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
