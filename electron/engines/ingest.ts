import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { LocalBinaries } from '../binaries';
import type { LocalDatabase } from '../db';
import type { ClipperEvent, StreamRecord } from '../types';
import { LiveChatCollector } from './chat';
import { buildSignalTimeline, selectViralWindows } from './detector';
import { scoreTranscript } from './llm-scorer';
import { computeAudioEnergy, computeChatScores, computeVisualMotion } from './signals';
import { LocalTranscriber } from './transcriber';

interface ActiveJob {
  ytProcess?: ChildProcess;
  ffProcess?: ChildProcess;
  chat: LiveChatCollector;
  watcher?: NodeJS.Timeout;
  stopped: boolean;
}

/**
 * Runs 100% locally on the user's PC:
 * 1) Fetches metadata & stream via local yt-dlp (free)
 * 2) Writes rolling MP4 segments via local ffmpeg with configurable buffer retention
 * 3) Transcribes & detects viral clips chunk-by-chunk
 */
export class IngestManager {
  private jobs = new Map<string, ActiveJob>();
  private transcriber = new LocalTranscriber();

  constructor(
    private db: LocalDatabase,
    private binaries: LocalBinaries,
    private emit: (ev: ClipperEvent) => void
  ) {}

  private fetchMetadata(url: string): Promise<{ title: string; channel: string; isLive: boolean; streamUrl: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.binaries.ytDlp, [
        '--no-playlist',
        '-f', 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best',
        '--print', '%(title)s\n%(uploader)s\n%(is_live)s',
        '-g',
        url,
      ]);

      let out = '';
      let err = '';
      proc.stdout.on('data', (d: Buffer) => { out += d.toString('utf-8'); });
      proc.stderr.on('data', (d: Buffer) => { err += d.toString('utf-8'); });
      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(err || `yt-dlp metadata failed (${code})`));
          return;
        }
        const lines = out.trim().split(/\r?\n/);
        resolve({
          title: lines[0] || 'YouTube Stream',
          channel: lines[1] || 'Creator',
          isLive: lines[2] === 'True',
          streamUrl: lines[3] || url,
        });
      });
    });
  }

  async startStream(url: string): Promise<StreamRecord> {
    const id = crypto.randomUUID().slice(0, 8);
    const settings = this.db.getSettings();
    const streamDir = path.join(settings.storagePath, 'streams', id);
    fs.mkdirSync(streamDir, { recursive: true });

    const meta = await this.fetchMetadata(url);
    const record: StreamRecord = {
      id,
      url,
      title: meta.title,
      channel: meta.channel,
      isLive: meta.isLive,
      status: 'ingesting',
      bufferSeconds: 0,
      clipsCount: 0,
      createdAt: Date.now(),
    };
    this.db.upsertStream(record);
    this.emit({ type: 'stream:status', streamId: id, status: 'ingesting', bufferSeconds: 0 });

    const chat = new LiveChatCollector(this.db, id);
    if (meta.isLive) void chat.start(url);

    const ytProc = spawn(this.binaries.ytDlp, [
      '--no-playlist',
      '-f', 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best',
      '-o', '-',
      url,
    ]);

    const segPattern = path.join(streamDir, 'seg_%05d.mp4');
    const ffProc = spawn(this.binaries.ffmpeg, [
      '-y',
      '-i', 'pipe:0',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '22',
      '-c:a', 'aac',
      '-f', 'segment',
      '-segment_time', String(settings.segmentSeconds),
      '-reset_timestamps', '1',
      segPattern,
    ]);

    ytProc.stdout.pipe(ffProc.stdin);

    const job: ActiveJob = { ytProcess: ytProc, ffProcess: ffProc, chat, stopped: false };
    this.jobs.set(id, job);

    const processedFiles = new Set<string>();
    const maxSegments = Math.max(4, Math.floor((settings.bufferHours * 3600) / settings.segmentSeconds));

    const scanSegments = async () => {
      if (job.stopped) return;
      const files = fs
        .readdirSync(streamDir)
        .filter((f) => f.endsWith('.mp4'))
        .sort();

      const readyFiles = ffProc.exitCode === null ? files.slice(0, -1) : files;

      for (const file of readyFiles) {
        if (processedFiles.has(file)) continue;
        processedFiles.add(file);
        const fullPath = path.join(streamDir, file);
        const segIdx = Number(file.match(/seg_(\d+)/)?.[1] ?? 0);
        const offsetSec = segIdx * settings.segmentSeconds;

        await this.analyzeSegment(id, fullPath, offsetSec, settings.segmentSeconds);
      }

      if (files.length > maxSegments) {
        for (const old of files.slice(0, files.length - maxSegments)) {
          try { fs.unlinkSync(path.join(streamDir, old)); } catch { /* ignore */ }
        }
      }

      record.bufferSeconds = files.length * settings.segmentSeconds;
      this.db.upsertStream(record);
      this.emit({ type: 'stream:status', streamId: id, status: record.status, bufferSeconds: record.bufferSeconds });
    };

    job.watcher = setInterval(() => void scanSegments(), 5000);

    ffProc.on('close', async () => {
      await scanSegments();
      if (!job.stopped) {
        record.status = 'stopped';
        this.db.upsertStream(record);
        this.emit({ type: 'stream:status', streamId: id, status: 'stopped', bufferSeconds: record.bufferSeconds });
      }
      this.stopStream(id);
    });

    return record;
  }

  private async analyzeSegment(streamId: string, segPath: string, offsetSec: number, segDur: number): Promise<void> {
    const settings = this.db.getSettings();
    const { text, words } = await this.transcriber.transcribeSegment(
      this.binaries.ffmpeg,
      segPath,
      settings.whisperModel,
      0
    );

    const [audioScores, motionScores, llm] = await Promise.all([
      computeAudioEnergy(this.binaries.ffmpeg, segPath, segDur),
      computeVisualMotion(this.binaries.ffmpeg, segPath, segDur),
      scoreTranscript(text, settings),
    ]);

    const chatMsgs = this.db.getChatInWindow(streamId, offsetSec, offsetSec + segDur);
    const { scores: chatScores, rates: chatRates } = computeChatScores(chatMsgs, offsetSec, segDur);

    const samples = buildSignalTimeline({
      startSec: offsetSec,
      chatScores,
      chatRates,
      audioScores,
      motionScores,
      llmScore: llm.score,
    });

    for (const s of samples) {
      this.emit({ type: 'monitor:signal', streamId, sample: s });
    }

    const localSamples = samples.map((s) => ({ ...s, timestamp: s.timestamp - offsetSec }));
    const windows = selectViralWindows(localSamples, words, {
      threshold: settings.viralityThreshold,
      minLen: Math.min(settings.minClipSeconds, segDur),
      maxLen: settings.maxClipSeconds,
    });

    for (const w of windows) {
      const clipId = crypto.randomUUID().slice(0, 8);
      const thumbPath = path.join(path.dirname(segPath), `${clipId}_thumb.jpg`);
      await this.extractThumbnail(segPath, w.startSec + 1, thumbPath);

      const clipWords = words
        .filter((wd) => wd.end >= w.startSec && wd.start <= w.endSec)
        .map((wd) => ({
          ...wd,
          start: Number(Math.max(0, wd.start - w.startSec).toFixed(3)),
          end: Number(Math.max(0.1, wd.end - w.startSec).toFixed(3)),
        }));

      const clip = {
        id: clipId,
        streamId,
        title: llm.title,
        reason: llm.reason,
        viralityScore: w.score,
        startSec: w.startSec,
        endSec: w.endSec,
        durationSec: Number((w.endSec - w.startSec).toFixed(2)),
        sourcePath: segPath,
        thumbnailPath: thumbPath,
        renderedPath: null,
        layoutMode: 'fullscreen' as const,
        layoutTemplateId: 'fullscreen-smart',
        captionTemplateId: 'bold-pop',
        fontFamily: 'Montserrat',
        profanityMask: true,
        titlePosition: 'top' as const,
        facecamBox: null,
        suggestedLayout: 'fullscreen' as const,
        words: clipWords,
        createdAt: Date.now(),
      };

      this.db.saveClip(clip);
      this.emit({ type: 'clip:detected', streamId, clip });
    }
  }

  private extractThumbnail(videoPath: string, atSec: number, outPath: string): Promise<void> {
    return new Promise((resolve) => {
      const proc = spawn(this.binaries.ffmpeg, [
        '-y', '-ss', String(atSec), '-i', videoPath, '-frames:v', '1', '-q:v', '3', outPath,
      ]);
      proc.on('close', () => resolve());
    });
  }

  stopStream(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.stopped = true;
    if (job.watcher) clearInterval(job.watcher);
    job.chat.stop();
    try { job.ytProcess?.kill(); } catch { /* ignore */ }
    try { job.ffProcess?.kill(); } catch { /* ignore */ }
    this.jobs.delete(id);
  }

  stopAll(): void {
    for (const id of this.jobs.keys()) this.stopStream(id);
  }
}
