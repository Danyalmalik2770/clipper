import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getProxyEnv, type LocalBinaries } from '../binaries';
import type { LocalDatabase } from '../db';
import type { AppSettings, ClipperEvent, DownloadState, StreamRecord } from '../types';
import { LiveChatCollector } from './chat';
import { buildSignalTimeline, selectViralWindows } from './detector';
import { scoreTranscript } from './llm-scorer';
import { computeAudioEnergy, computeChatScores, computeVisualMotion } from './signals';
import { LocalTranscriber } from './transcriber';

const PLAYER_CLIENTS = ['web', 'visionos', 'ios', 'android'] as const;
const THROTTLE_FLOOR_KBPS = 25;

interface ActiveJob {
  record: StreamRecord;
  streamDir: string;
  ytProcess?: ChildProcess;
  ffProcess?: ChildProcess;
  chat: LiveChatCollector;
  watcher?: NodeJS.Timeout;
  speedTimer?: NodeJS.Timeout;
  countdownTimer?: NodeJS.Timeout;
  clientIndex: number;
  consecutiveFailures: number;
  lowSpeedStreak: number;
  pipelineStartMs: number;
  lastDataMs: number;
  windowBytes: number;
  lastFfTotalBytes: number;
  downloadState: DownloadState;
  retryInSec: number;
  downloadSpeedKbps: number;
  isScanning: boolean;
  retrying: boolean;
  stopped: boolean;
}

export class IngestManager {
  private jobs = new Map<string, ActiveJob>();
  private transcriber = new LocalTranscriber();

  constructor(
    private db: LocalDatabase,
    private binaries: LocalBinaries,
    private emit: (ev: ClipperEvent) => void
  ) {}

  private buildYtDlpArgs(settings: AppSettings, client: string): string[] {
    const args = [
      '--no-playlist',
      '--retries', '2',
      '--fragment-retries', '2',
      '--socket-timeout', '20',
      '--extractor-args', `youtube:player_client=${client}`,
    ];
    const proxy = getProxyEnv();
    if (proxy) args.push('--proxy', proxy);
    if (settings.forceIpv4) args.push('--force-ipv4');
    if (settings.cookiesPath && fs.existsSync(settings.cookiesPath)) {
      args.push('--cookies', settings.cookiesPath);
    }
    return args;
  }

  private emitJobStatus(job: ActiveJob, error?: string): void {
    const client = PLAYER_CLIENTS[job.clientIndex % PLAYER_CLIENTS.length];
    this.emit({
      type: 'stream:status',
      streamId: job.record.id,
      status: job.record.status,
      bufferSeconds: job.record.bufferSeconds,
      error: error ?? (job.record.errorMessage || undefined),
      downloadState: job.downloadState,
      retryInSec: job.retryInSec,
      activeClient: client,
      downloadSpeedKbps: job.downloadSpeedKbps,
    });
  }

  private fetchMetadata(url: string): Promise<{ title: string; channel: string; isLive: boolean }> {
    const settings = this.db.getSettings();
    return new Promise((resolve, reject) => {
      const proc = spawn(
        this.binaries.ytDlp,
        [
          ...this.buildYtDlpArgs(settings, 'web'),
          '-f', 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best',
          '--print', '%(title)s\n%(uploader)s\n%(is_live)s',
          '-g',
          url,
        ],
        { env: { ...process.env } }
      );
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
        });
      });
    });
  }

  private extractFreshUrls(url: string, client: string, settings: AppSettings): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const proc = spawn(
        this.binaries.ytDlp,
        [
          ...this.buildYtDlpArgs(settings, client),
          '-f', 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best',
          '-g',
          url,
        ],
        { env: { ...process.env } }
      );
      let out = '';
      let err = '';
      proc.stdout.on('data', (d: Buffer) => { out += d.toString('utf-8'); });
      proc.stderr.on('data', (d: Buffer) => { err += d.toString('utf-8'); });
      proc.on('close', (code) => {
        const urls = out.trim().split(/\r?\n/).filter((u) => u.startsWith('http'));
        if (code === 0 && urls.length > 0) resolve(urls);
        else reject(new Error(err.trim().split(/\r?\n/).slice(-2).join(' ') || `Extraction failed (${code})`));
      });
    });
  }

  private loadProcessedSet(streamDir: string): Set<string> {
    const metaFile = path.join(streamDir, '.processed.json');
    if (!fs.existsSync(metaFile)) return new Set();
    try {
      return new Set(JSON.parse(fs.readFileSync(metaFile, 'utf-8')) as string[]);
    } catch {
      return new Set();
    }
  }

  private saveProcessedSet(streamDir: string, set: Set<string>): void {
    fs.writeFileSync(path.join(streamDir, '.processed.json'), JSON.stringify([...set]), 'utf-8');
  }

  private listSegments(streamDir: string): string[] {
    if (!fs.existsSync(streamDir)) return [];
    return fs.readdirSync(streamDir).filter((f) => /^seg_\d+\.mp4$/.test(f)).sort();
  }

  private nextSegmentNumber(streamDir: string): number {
    const nums = this.listSegments(streamDir).map((f) => Number(f.match(/seg_(\d+)/)?.[1] ?? 0));
    return nums.length > 0 ? Math.max(...nums) + 1 : 0;
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
      errorMessage: null,
    };
    this.db.upsertStream(record);
    this.beginJob(record, streamDir);
    return record;
  }

  resumeActiveStreams(): void {
    const active = this.db.listStreams().filter((s) => s.status === 'ingesting');
    const settings = this.db.getSettings();
    for (const record of active) {
      if (this.jobs.has(record.id)) continue;
      const streamDir = path.join(settings.storagePath, 'streams', record.id);
      fs.mkdirSync(streamDir, { recursive: true });
      this.beginJob(record, streamDir);
    }
  }

  private beginJob(record: StreamRecord, streamDir: string): void {
    const chat = new LiveChatCollector(this.db, record.id);
    if (record.isLive) void chat.start(record.url);

    const job: ActiveJob = {
      record,
      streamDir,
      chat,
      clientIndex: 0,
      consecutiveFailures: 0,
      lowSpeedStreak: 0,
      pipelineStartMs: Date.now(),
      lastDataMs: Date.now(),
      windowBytes: 0,
      lastFfTotalBytes: 0,
      downloadState: 'downloading',
      retryInSec: 0,
      downloadSpeedKbps: 0,
      isScanning: false,
      retrying: false,
      stopped: false,
    };
    this.jobs.set(record.id, job);
    this.emitJobStatus(job);

    const processedFiles = this.loadProcessedSet(streamDir);

    const scanSegments = async () => {
      if (job.stopped || job.isScanning) return;
      job.isScanning = true;
      try {
        const settings = this.db.getSettings();
        const maxSegments = Math.max(4, Math.floor((settings.bufferHours * 3600) / settings.segmentSeconds));
        const files = this.listSegments(streamDir);
        const activeWriting = job.ffProcess && job.ffProcess.exitCode === null;
        const readyFiles = activeWriting ? files.slice(0, -1) : files;

        for (const file of readyFiles) {
          if (job.stopped || processedFiles.has(file)) continue;
          const fullPath = path.join(streamDir, file);
          const segIdx = Number(file.match(/seg_(\d+)/)?.[1] ?? 0);
          const offsetSec = segIdx * settings.segmentSeconds;

          const ok = await this.analyzeSegment(job, fullPath, offsetSec, settings.segmentSeconds);
          if (ok) {
            processedFiles.add(file);
            this.saveProcessedSet(streamDir, processedFiles);
          }
        }

        if (files.length > maxSegments) {
          for (const old of files.slice(0, files.length - maxSegments)) {
            try { fs.unlinkSync(path.join(streamDir, old)); } catch { /* ignore */ }
          }
        }

        record.bufferSeconds = files.length * settings.segmentSeconds;
        this.db.upsertStream(record);
        this.emitJobStatus(job);
      } finally {
        job.isScanning = false;
      }
    };

    job.watcher = setInterval(() => void scanSegments(), 5000);

    // Measure live throughput every 2s to catch YouTube throttling / 0-byte blocks early
    job.speedTimer = setInterval(() => {
      if (job.stopped || job.retrying || job.downloadState !== 'downloading') return;
      const elapsedSinceStart = Date.now() - job.pipelineStartMs;
      const kbps = Math.round(job.windowBytes / 2 / 1024);
      job.windowBytes = 0;
      job.downloadSpeedKbps = kbps;

      if (elapsedSinceStart < 15_000) {
        this.emitJobStatus(job);
        return;
      }

      if (kbps >= 80 && Date.now() - job.lastDataMs < 5000) {
        job.consecutiveFailures = 0;
        job.lowSpeedStreak = 0;
      }

      if (kbps < THROTTLE_FLOOR_KBPS) job.lowSpeedStreak += 1;
      else job.lowSpeedStreak = 0;

      const stalled = Date.now() - job.lastDataMs > 15_000;
      if (stalled || job.lowSpeedStreak >= 2) {
        const reason = stalled
          ? 'Media connection stalled (0 bytes received)'
          : `YouTube throttled speed to ${kbps} KB/s`;
        this.scheduleRetry(job, reason);
        return;
      }
      this.emitJobStatus(job);
    }, 2000);

    void scanSegments();
    void this.spawnPipeline(job);
  }

  private killProcesses(job: ActiveJob): void {
    try { job.ytProcess?.kill(); } catch { /* ignore */ }
    try { job.ffProcess?.kill(); } catch { /* ignore */ }
    job.ytProcess = undefined;
    job.ffProcess = undefined;
  }

  private scheduleRetry(job: ActiveJob, reason: string): void {
    if (job.stopped || job.retrying) return;
    job.retrying = true;
    this.killProcesses(job);

    job.consecutiveFailures += 1;
    job.clientIndex = (job.clientIndex + 1) % PLAYER_CLIENTS.length;
    const nextClient = PLAYER_CLIENTS[job.clientIndex];

    const isBlocked = job.consecutiveFailures >= 3;
    const waitSec = isBlocked ? Math.min(180, 30 * (job.consecutiveFailures - 2)) : job.consecutiveFailures === 1 ? 5 : 12;

    job.downloadState = isBlocked ? 'blocked-waiting' : 'throttled-retrying';
    job.retryInSec = waitSec;
    job.downloadSpeedKbps = 0;
    job.record.errorMessage = `${reason}. Next client: ${nextClient}`;
    this.db.upsertStream(job.record);
    this.emitJobStatus(job, job.record.errorMessage);

    if (job.countdownTimer) clearInterval(job.countdownTimer);
    job.countdownTimer = setInterval(() => {
      if (job.stopped) {
        if (job.countdownTimer) clearInterval(job.countdownTimer);
        return;
      }
      job.retryInSec = Math.max(0, job.retryInSec - 1);
      this.emitJobStatus(job);
      if (job.retryInSec === 0) {
        if (job.countdownTimer) clearInterval(job.countdownTimer);
        job.countdownTimer = undefined;
        job.retrying = false;
        void this.spawnPipeline(job);
      }
    }, 1000);
  }

  private async spawnPipeline(job: ActiveJob): Promise<void> {
    if (job.stopped) return;
    const settings = this.db.getSettings();
    const client = PLAYER_CLIENTS[job.clientIndex % PLAYER_CLIENTS.length];
    const startNum = this.nextSegmentNumber(job.streamDir);
    const segPattern = path.join(job.streamDir, 'seg_%05d.mp4');

    job.retrying = false;
    job.lowSpeedStreak = 0;
    job.windowBytes = 0;
    job.lastFfTotalBytes = 0;
    job.pipelineStartMs = Date.now();
    job.lastDataMs = Date.now();
    job.downloadState = 'downloading';
    job.retryInSec = 0;
    this.emitJobStatus(job);

    let freshUrls: string[] = [];
    try {
      freshUrls = await this.extractFreshUrls(job.record.url, client, settings);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.scheduleRetry(job, `URL extraction failed (${client}): ${msg}`);
      return;
    }

    if (job.stopped) return;
    const canDirectFf = !job.record.isLive && freshUrls.length > 0 && !freshUrls.some((u) => u.includes('.m3u8'));

    if (canDirectFf) {
      const resumeSec = this.listSegments(job.streamDir).length * settings.segmentSeconds;
      const inputArgs: string[] = [];
      for (const u of freshUrls) {
        inputArgs.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
        if (resumeSec > 0) inputArgs.push('-ss', String(resumeSec));
        inputArgs.push('-i', u);
      }
      const mapArgs = freshUrls.length > 1 ? ['-map', '0:v:0', '-map', '1:a:0?'] : [];

      const ffProc = spawn(this.binaries.ffmpeg, [
        '-y',
        ...inputArgs,
        ...mapArgs,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '22',
        '-c:a', 'aac',
        '-f', 'segment',
        '-segment_time', String(settings.segmentSeconds),
        '-segment_start_number', String(startNum),
        '-reset_timestamps', '1',
        '-progress', 'pipe:1',
        segPattern,
      ]);

      job.ffProcess = ffProc;
      let errTail = '';
      ffProc.stdout.on('data', (chunk: Buffer) => {
        const m = chunk.toString('utf-8').match(/total_size=(\d+)/);
        if (m) {
          const total = Number(m[1]);
          if (total > job.lastFfTotalBytes) {
            job.windowBytes += total - job.lastFfTotalBytes;
            job.lastFfTotalBytes = total;
            job.lastDataMs = Date.now();
          }
        }
      });
      ffProc.stderr.on('data', (d: Buffer) => { errTail = d.toString('utf-8').slice(-240); });
      ffProc.on('close', (code) => {
        if (!job.stopped && !job.retrying) {
          this.scheduleRetry(job, `Media stream cut (${code}): ${errTail.split(/\r?\n/).pop() || 'I/O error'}`);
        }
      });
      ffProc.on('error', (e) => this.scheduleRetry(job, e.message));
      return;
    }

    const ytProc = spawn(
      this.binaries.ytDlp,
      [
        ...this.buildYtDlpArgs(settings, client),
        '-f', 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best',
        '-o', '-',
        job.record.url,
      ],
      { env: { ...process.env } }
    );

    const ffProc = spawn(this.binaries.ffmpeg, [
      '-y',
      '-i', 'pipe:0',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '22',
      '-c:a', 'aac',
      '-f', 'segment',
      '-segment_time', String(settings.segmentSeconds),
      '-segment_start_number', String(startNum),
      '-reset_timestamps', '1',
      segPattern,
    ]);

    job.ytProcess = ytProc;
    job.ffProcess = ffProc;

    let ytErr = '';
    ytProc.stdout.on('data', (chunk: Buffer) => {
      job.windowBytes += chunk.length;
      job.lastDataMs = Date.now();
    });
    ytProc.stderr.on('data', (d: Buffer) => { ytErr = d.toString('utf-8').slice(-240); });
    ytProc.stdout.pipe(ffProc.stdin);
    ytProc.stdout.on('error', () => { /* ignore */ });
    ffProc.stdin.on('error', () => { /* ignore */ });

    const onEnd = (code: number | null) => {
      if (!job.stopped && !job.retrying) {
        this.scheduleRetry(job, `Stream ended/cut (${code}): ${ytErr.split(/\r?\n/).pop() || 'connection lost'}`);
      }
    };
    ytProc.on('close', onEnd);
    ffProc.on('close', onEnd);
    ytProc.on('error', (e) => onEnd(null));
    ffProc.on('error', (e) => onEnd(null));
  }

  private async analyzeSegment(job: ActiveJob, segPath: string, offsetSec: number, segDur: number): Promise<boolean> {
    const settings = this.db.getSettings();
    let text = '';
    let words = [] as Awaited<ReturnType<LocalTranscriber['transcribeSegment']>>['words'];

    try {
      const res = await this.transcriber.transcribeSegment(this.binaries.ffmpeg, segPath, settings.whisperModel, 0);
      text = res.text;
      words = res.words;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      job.record.errorMessage = msg;
      this.db.upsertStream(job.record);
      this.emitJobStatus(job, msg);
      return false;
    }

    const [audioScores, motionScores, llm] = await Promise.all([
      computeAudioEnergy(this.binaries.ffmpeg, segPath, segDur),
      computeVisualMotion(this.binaries.ffmpeg, segPath, segDur),
      scoreTranscript(text, settings),
    ]);

    const chatMsgs = this.db.getChatInWindow(job.record.id, offsetSec, offsetSec + segDur);
    const { scores: chatScores, rates: chatRates } = computeChatScores(chatMsgs, offsetSec, segDur);

    const samples = buildSignalTimeline({
      startSec: offsetSec,
      chatScores,
      chatRates,
      audioScores,
      motionScores,
      llmScore: llm.score,
    });
    for (const s of samples) this.emit({ type: 'monitor:signal', streamId: job.record.id, sample: s });

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
        streamId: job.record.id,
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
      this.emit({ type: 'clip:detected', streamId: job.record.id, clip });
    }
    return true;
  }

  private extractThumbnail(videoPath: string, atSec: number, outPath: string): Promise<void> {
    return new Promise((resolve) => {
      const proc = spawn(this.binaries.ffmpeg, [
        '-y', '-ss', String(atSec), '-i', videoPath, '-frames:v', '1', '-q:v', '3', outPath,
      ]);
      proc.on('close', () => resolve());
    });
  }

  stopStream(id: string, markStopped = true): void {
    const job = this.jobs.get(id);
    if (job) {
      job.stopped = true;
      job.downloadState = 'stopped';
      job.retryInSec = 0;
      if (job.watcher) clearInterval(job.watcher);
      if (job.speedTimer) clearInterval(job.speedTimer);
      if (job.countdownTimer) clearInterval(job.countdownTimer);
      job.chat.stop();
      this.killProcesses(job);
      this.jobs.delete(id);
    }

    if (markStopped) {
      const existing = this.db.listStreams().find((s) => s.id === id);
      if (existing) {
        existing.status = 'stopped';
        this.db.upsertStream(existing);
        this.emit({
          type: 'stream:status',
          streamId: id,
          status: 'stopped',
          bufferSeconds: existing.bufferSeconds,
          downloadState: 'stopped',
          retryInSec: 0,
        });
      }
    }
  }

  stopAll(): void {
    for (const id of [...this.jobs.keys()]) {
      this.stopStream(id, false);
    }
  }
}
