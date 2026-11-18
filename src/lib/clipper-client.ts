import type {
  AppSettings,
  CaptionTemplate,
  ClipRecord,
  ClipperEvent,
  ExportOrientation,
  LayoutTemplate,
  StreamRecord,
} from '../../electron/types';

declare global {
  interface Window {
    clipper?: {
      streams: {
        list: () => Promise<StreamRecord[]>;
        start: (url: string) => Promise<StreamRecord>;
        startLocalFile: (filePath: string) => Promise<StreamRecord>;
        pickVideoFile: () => Promise<string | null>;
        stop: (id: string) => Promise<void>;
        remove: (id: string) => Promise<void>;
      };
      clips: {
        list: (streamId?: string) => Promise<ClipRecord[]>;
        get: (id: string) => Promise<ClipRecord | null>;
        update: (clip: ClipRecord) => Promise<ClipRecord>;
        render: (clipId: string, orientation?: ExportOrientation) => Promise<string[]>;
        revealInFolder: (filePath: string) => Promise<void>;
      };
      templates: {
        listCaptions: () => Promise<CaptionTemplate[]>;
        listLayouts: () => Promise<LayoutTemplate[]>;
        saveCaption: (tpl: CaptionTemplate) => Promise<void>;
        saveLayout: (tpl: LayoutTemplate) => Promise<void>;
      };
      fonts: {
        list: () => Promise<Array<{ name: string; path: string; custom: boolean }>>;
        upload: () => Promise<Array<{ name: string; path: string }>>;
        downloadFreePack: () => Promise<{ downloaded: number; total: number }>;
        openFolder: () => Promise<void>;
      };
      settings: {
        get: () => Promise<AppSettings>;
        save: (settings: AppSettings) => Promise<AppSettings>;
        testLlm: (settings: AppSettings) => Promise<{ ok: boolean; message: string }>;
        pickFolder: () => Promise<string | null>;
        pickCookies: () => Promise<string | null>;
      };
      onEvent: (cb: (event: ClipperEvent) => void) => () => void;
    };
  }
}

export function mediaUrl(localPath: string | null | undefined): string {
  if (!localPath) return '';
  return `clipper-media://${encodeURIComponent(localPath)}`;
}

export function formatSeconds(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
