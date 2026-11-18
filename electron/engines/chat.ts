import { Innertube } from 'youtubei.js';
import type { LocalDatabase } from '../db';

export function extractYouTubeVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1) || null;
    if (u.searchParams.has('v')) return u.searchParams.get('v');
    const liveMatch = u.pathname.match(/\/live\/([^/]+)/);
    return liveMatch ? liveMatch[1] : null;
  } catch {
    return null;
  }
}

/**
 * Connects to YouTube live chat using youtubei.js (100% free, zero API keys).
 * Falls back cleanly on VODs or streams with disabled chat.
 */
export class LiveChatCollector {
  private active = false;
  private startWallMs = Date.now();
  private liveChat: { stop: () => void } | null = null;

  constructor(private db: LocalDatabase, private streamId: string) {}

  async start(url: string): Promise<void> {
    const videoId = extractYouTubeVideoId(url);
    if (!videoId) return;

    this.active = true;
    this.startWallMs = Date.now();

    try {
      const yt = await Innertube.create();
      const info = await yt.getInfo(videoId);
      const chat = info.getLiveChat();
      this.liveChat = chat;

      chat.on('chat-update', (action: unknown) => {
        if (!this.active) return;
        const item = (action as { item?: Record<string, unknown> })?.item;
        if (!item) return;

        const authorObj = item.author as { name?: string } | undefined;
        const msgObj = item.message as { text?: string; runs?: Array<{ text?: string }> } | undefined;
        const text =
          msgObj?.text ??
          msgObj?.runs?.map((r) => r.text ?? '').join('') ??
          '';

        if (!text.trim()) return;
        const elapsedSec = (Date.now() - this.startWallMs) / 1000;
        this.db.insertChatMessage(this.streamId, elapsedSec, authorObj?.name ?? 'viewer', text);
      });

      chat.on('error', () => {
        // Non-fatal: continue video/audio pipeline even if chat disconnects
      });

      chat.start();
    } catch {
      // VOD or chat disabled - silently skip without breaking stream ingest
    }
  }

  stop(): void {
    this.active = false;
    try {
      this.liveChat?.stop();
    } catch {
      // ignore
    }
    this.liveChat = null;
  }
}
