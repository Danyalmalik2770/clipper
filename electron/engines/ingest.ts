import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getProxyEnv, type LocalBinaries } from '../binaries';
import type { LocalDatabase } from '../db';
import type { AppSettings, ClipperEvent, DownloadState, StreamRecord, WordToken } from '../types';
import { LiveChatCollector } from './chat';
import { buildSignalTimeline, selectViralWindows } from './detector';
import { pickViralMomentsFromTranscript, scoreTranscript, scoreTranscriptFreeLocal } from './llm-scorer';
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
  lastObservedBytes: number;
  rollingPeakAudio: number;
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

  private emitJobStatus(job: ActiveJob, notice?: string): void {
    const client = PLAYER_CLIENTS[job.clientIndex % PLAYER_CLIENTS.length];
    this.emit({
      type: 'stream:status',
      streamId: job.record.id,
      status: job.record.status,
      bufferSeconds: job.record.bufferSeconds,
      error: notice ?? (job.record.errorMessage || undefined),
      downloadState: job.downloadState,
      retryInSec: job.retryInSec,
      activeClient: client,
      downloadSpeedKbps: job.downloadSpeedKbps,
    });
  }

  private probeDuration(mediaPath: string): Promise<number> {
    return new Promise((resolve) => {
      const proc = spawn(this.binaries.ffprobe, [
        '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', mediaPath,
      ]);
      let out = '';
      proc.stdout.on('data', (d: Buffer) => { out += d.toString('utf-8'); });
      proc.on('close', () => resolve(Math.max(10, Number(out.trim()) || 60)));
    });
  }

  private fetchMetadata(url: string): Promise<{ title: string; channel: string; isLive: boolean; duration: number }> {
    const settings = this.db.getSettings();
    return new Promise((resolve, reject) => {
      const proc = spawn(
        this.binaries.ytDlp,
        [
          ...this.buildYtDlpArgs(settings, 'web'),
          '--skip-download',
          '--print', '%(title)s\n%(uploader)s\n%(is_live)s\n%(duration)s',
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
          title: lines[0] || 'YouTube Video',
          channel: lines[1] || 'Creator',
          isLive: lines[2] === 'True',
          duration: Number(lines[3]) || 0,
        });
      });
    });
  }

  private dirTotalBytes(dir: string): number {
    if (!fs.existsSync(dir)) return 0;
    let total = 0;
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith('full_vod')) {
        try { total += fs.statSync(path.join(dir, name)).size; } catch { /* ignore */ }
      }
    }
    return total;
  }

  async startLocalFile(filePath: string): Promise<StreamRecord> {
    if (!fs.existsSync(filePath)) throw new Error('Selected video file does not exist.');
    const id = crypto.randomUUID().slice(0, 8);
    const settings = this.db.getSettings();
    const streamDir = path.join(settings.storagePath, 'streams', id);
    fs.mkdirSync(streamDir, { recursive: true });

    const duration = await this.probeDuration(filePath);
    const record: StreamRecord = {
      id,
      url: filePath,
      title: path.parse(filePath).name,
      channel: 'Local Video',
      isLive: false,
      status: 'ingesting',
      bufferSeconds: Math.round(duration),
      clipsCount: 0,
      createdAt: Date.now(),
      errorMessage: null,
    };
    this.db.upsertStream(record);

    const job: ActiveJob = {
      record,
      streamDir,
      chat: new LiveChatCollector(this.db, id),
      clientIndex: 0,
      consecutiveFailures: 0,
      lowSpeedStreak: 0,
      pipelineStartMs: Date.now(),
      lastDataMs: Date.now(),
      windowBytes: 0,
      lastObservedBytes: 0,
      rollingPeakAudio: 0.1,
      downloadState: 'analyzing',
      retryInSec: 0,
      downloadSpeedKbps: 0,
      isScanning: false,
      retrying: false,
      stopped: false,
    };
    this.jobs.set(id, job);
    void this.analyzeFullVod(job, filePath);
    return record;
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
      bufferSeconds: Math.round(meta.duration || 0),
      clipsCount: 0,
      createdAt: Date.now(),
      errorMessage: null,
    };
    this.db.upsertStream(record);

    if (meta.isLive) this.beginLiveJob(record, streamDir);
    else this.beginVodJob(record, streamDir);
    return record;
  }

  resumeActiveStreams(): void {
    const active = this.db.listStreams().filter((s) => s.status === 'ingesting');
    const settings = this.db.getSettings();
    for (const record of active) {
      if (this.jobs.has(record.id)) continue;
      const streamDir = path.join(settings.storagePath, 'streams', record.id);
      fs.mkdirSync(streamDir, { recursive: true });
      if (!record.url.startsWith('http') && fs.existsSync(record.url)) {
        void this.startLocalFile(record.url);
      } else if (record.isLive) {
        this.beginLiveJob(record, streamDir);
      } else {
        this.beginVodJob(record, streamDir);
      }
    }
  }

  private beginVodJob(record: StreamRecord, streamDir: string): void {
    const job: ActiveJob = {
      record,
      streamDir,
      chat: new LiveChatCollector(this.db, record.id),
      clientIndex: 0,
      consecutiveFailures: 0,
      lowSpeedStreak: 0,
      pipelineStartMs: Date.now(),
      lastDataMs: Date.now(),
      windowBytes: 0,
      lastObservedBytes: this.dirTotalBytes(streamDir),
      rollingPeakAudio: 0.1,
      downloadState: 'downloading',
      retryInSec: 0,
      downloadSpeedKbps: 0,
      isScanning: false,
      retrying: false,
      stopped: false,
    };
    this.jobs.set(record.id, job);

    const vodPath = path.join(streamDir, 'full_vod.mp4');
    if (fs.existsSync(vodPath) && !fs.existsSync(`${vodPath}.part`)) {
      void this.analyzeFullVod(job, vodPath);
      return;
    }

    job.speedTimer = setInterval(() => {
      if (job.stopped || job.retrying || job.downloadState !== 'downloading') return;
      const nowBytes = this.dirTotalBytes(streamDir);
      const delta = Math.max(0, nowBytes - job.lastObservedBytes);
      job.lastObservedBytes = nowBytes;
      if (delta > 0) job.lastDataMs = Date.now();

      const kbps = Math.round(delta / 2 / 1024);
      job.downloadSpeedKbps = kbps;

      if (Date.now() - job.pipelineStartMs < 15_000) {
        this.emitJobStatus(job);
        return;
      }
      if (kbps >= 80 && Date.now() - job.lastDataMs < 5000) {
        job.consecutiveFailures = 0;
        job.lowSpeedStreak = 0;
      }
      if (kbps < THROTTLE_FLOOR_KBPS) job.lowSpeedStreak += 1;
      else job.lowSpeedStreak = 0;

      const stalled = Date.now() - job.lastDataMs > 18_000;
      if (stalled || job.lowSpeedStreak >= 3) {
        this.scheduleVodRetry(job, stalled ? 'Download stalled (0 B/s)' : `Throttled to ${kbps} KB/s`);
        return;
      }
      this.emitJobStatus(job);
    }, 2000);

    this.spawnVodDownload(job, vodPath);
  }

  private spawnVodDownload(job: ActiveJob, vodPath: string): void {
    if (job.stopped) return;
    const settings = this.db.getSettings();
    const client = PLAYER_CLIENTS[job.clientIndex % PLAYER_CLIENTS.length];
    job.retrying = false;
    job.lowSpeedStreak = 0;
    job.pipelineStartMs = Date.now();
    job.lastDataMs = Date.now();
    job.downloadState = 'downloading';
    job.retryInSec = 0;
    this.emitJobStatus(job, `Downloading full video (${client})...`);

    const proc = spawn(
      this.binaries.ytDlp,
      [
        ...this.buildYtDlpArgs(settings, client),
        '--continue',
        '--ffmpeg-location', path.dirname(this.binaries.ffmpeg),
        '-f', 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]/best',
        '--merge-output-format', 'mp4',
        '-o', vodPath,
        job.record.url,
      ],
      { env: { ...process.env } }
    );

    job.ytProcess = proc;
    let errTail = '';
    proc.stdout.on('data', () => { job.lastDataMs = Date.now(); });
    proc.stderr.on('data', (d: Buffer) => { errTail = d.toString('utf-8').slice(-240); });

    proc.on('close', (code) => {
      if (job.stopped || job.retrying) return;
      if (code === 0 && fs.existsSync(vodPath)) {
        if (job.speedTimer) { clearInterval(job.speedTimer); job.speedTimer = undefined; }
        void this.analyzeFullVod(job, vodPath);
      } else {
        this.scheduleVodRetry(job, `Download cut (${code}): ${errTail.split(/\r?\n/).pop() || 'connection error'}`);
      }
    });
    proc.on('error', (e) => this.scheduleVodRetry(job, e.message));
  }

  private scheduleVodRetry(job: ActiveJob, reason: string): void {
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
        this.spawnVodDownload(job, path.join(job.streamDir, 'full_vod.mp4'));
      }
    }, 1000);
  }

  private sliceAudioChunk(sourcePath: string, startSec: number, durSec: number, outWav: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.binaries.ffmpeg, [
        '-y', '-v', 'error', '-ss', String(startSec), '-t', String(durSec), '-i', sourcePath, '-vn', '-ac', '1', '-ar', '16000', outWav,
      ]);
      proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Slice failed ${code}`))));
    });
  }

  private async analyzeFullVod(job: ActiveJob, vodPath: string): Promise<void> {
    if (job.stopped) return;
    const settings = this.db.getSettings();
    job.downloadState = 'analyzing';
    job.downloadSpeedKbps = 0;
    job.record.errorMessage = 'Scanning audio, motion & Whisper speech across full video...';
    this.db.upsertStream(job.record);
    this.emitJobStatus(job);

    const duration = await this.probeDuration(vodPath);
    job.record.bufferSeconds = Math.round(duration);

    const [audioScores, motionScores] = await Promise.all([
      computeAudioEnergy(this.binaries.ffmpeg, vodPath, duration),
      computeVisualMotion(this.binaries.ffmpeg, vodPath, duration),
    ]);

    const chunkLen = 60;
    const totalChunks = Math.max(1, Math.ceil(duration / chunkLen));
    const allWords: WordToken[] = [];
    const transcriptChunks: Array<{ startSec: number; endSec: number; text: string }> = [];

    for (let i = 0; i < totalChunks; i++) {
      if (job.stopped) return;
      const start = i * chunkLen;
      const dur = Math.min(chunkLen, duration - start);
      if (dur < 2) break;

      job.record.errorMessage = `Transcribing full video (${i + 1}/${totalChunks})...`;
      this.emitJobStatus(job);

      const tmpWav = path.join(job.streamDir, `chunk_${i}.wav`);
      try {
        await this.sliceAudioChunk(vodPath, start, dur, tmpWav);
        const res = await this.transcriber.transcribeSegment(this.binaries.ffmpeg, tmpWav, settings.whisperModel, start);
        allWords.push(...res.words);
        transcriptChunks.push({ startSec: start, endSec: start + dur, text: res.text });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        job.record.errorMessage = msg;
        this.db.upsertStream(job.record);
        this.emitJobStatus(job, msg);
        try { fs.unlinkSync(tmpWav); } catch { /* ignore */ }
        break;
      }
      try { fs.unlinkSync(tmpWav); } catch { /* ignore */ }
    }

    if (job.stopped) return;

    job.record.errorMessage = 'AI selecting top viral moments across the entire video...';
    this.emitJobStatus(job);

    const llmPicks = await pickViralMomentsFromTranscript(transcriptChunks, settings);
    const chosen: Array<{ startSec: number; endSec: number; score: number; title: string; reason: string }> = [];

    if (llmPicks.length > 0) {
      chosen.push(...llmPicks.slice(0, 8));
    } else {
      const globalSamples = buildSignalTimeline({
        startSec: 0,
        chatScores: [],
        chatRates: [],
        audioScores,
        motionScores,
        llmScore: 0.65,
      });
      for (const s of globalSamples.filter((_, idx) => idx % Math.max(1, Math.floor(globalSamples.length / 60)) === 0)) {
        this.emit({ type: 'monitor:signal', streamId: job.record.id, sample: s });
      }
      const windows = selectViralWindows(globalSamples, allWords, {
        threshold: Math.max(0.45, settings.viralityThreshold * 0.85),
        minLen: settings.minClipSeconds,
        maxLen: settings.maxClipSeconds,
      }).slice(0, 6);

      for (const w of windows) {
        const snippet = allWords
          .filter((wd) => wd.start >= w.startSec && wd.end <= w.endSec)
          .map((wd) => wd.word)
          .join(' ');
        const local = scoreTranscriptFreeLocal(snippet);
        chosen.push({
          startSec: w.startSec,
          endSec: w.endSec,
          score: w.score,
          title: local.title,
          reason: local.reason,
        });
      }
    }

    for (const item of chosen) {
      await this.createDetectedClip(job.record.id, vodPath, item, allWords);
    }

    job.record.status = 'stopped';
    job.record.errorMessage = null;
    job.downloadState = 'stopped';
    this.db.upsertStream(job.record);
    this.emitJobStatus(job);
    this.jobs.delete(job.record.id);
  }

  private beginLiveJob(record: StreamRecord, streamDir: string): void {
    const chat = new LiveChatCollector(this.db, record.id);
    void chat.start(record.url);

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
      lastObservedBytes: 0,
      rollingPeakAudio: 0.08,
      downloadState: 'downloading',
      retryInSec: 0,
      downloadSpeedKbps: 0,
      isScanning: false,
      retrying: false,
      stopped: false,
    };
    this.jobs.set(record.id, job);
    this.emitJobStatus(job);

    const processedFiles = new Set<string>();
    const scanSegments = async () => {
      if (job.stopped || job.isScanning) return;
      job.isScanning = true;
      try {
        const settings = this.db.getSettings();
        const maxSegments = Math.max(4, Math.floor((settings.bufferHours * 3600) / settings.segmentSeconds));
        const files = fs.existsSync(streamDir)
          ? fs.readdirSync(streamDir).filter((f) => /^seg_\d+\.mp4$/.test(f)).sort()
          : [];
        const readyFiles = job.ffProcess && job.ffProcess.exitCode === null ? files.slice(0, -1) : files;

        for (const file of readyFiles) {
          if (job.stopped || processedFiles.has(file)) continue;
          const fullPath = path.join(streamDir, file);
          const segIdx = Number(file.match(/seg_(\d+)/)?.[1] ?? 0);
          const offsetSec = segIdx * settings.segmentSeconds;
          await this.analyzeLiveSegment(job, fullPath, offsetSec, settings.segmentSeconds);
          processedFiles.add(file);
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
    job.speedTimer = setInterval(() => {
      if (job.stopped || job.retrying || job.downloadState !== 'downloading') return;
      const kbps = Math.round(job.windowBytes / 2 / 1024);
      job.windowBytes = 0;
      job.downloadSpeedKbps = kbps;
      if (Date.now() - job.pipelineStartMs < 15_000) {
        this.emitJobStatus(job);
        return;
      }
      if (kbps >= 80 && Date.now() - job.lastDataMs < 5000) {
        job.consecutiveFailures = 0;
        job.lowSpeedStreak = 0;
      }
      if (kbps < THROTTLE_FLOOR_KBPS) job.lowSpeedStreak += 1;
      else job.lowSpeedStreak = 0;

      if (Date.now() - job.lastDataMs > 15_000 || job.lowSpeedStreak >= 2) {
        this.scheduleLiveRetry(job, 'Live stream stalled or throttled');
        return;
      }
      this.emitJobStatus(job);
    }, 2000);

    this.spawnLivePipeline(job);
  }

  private spawnLivePipeline(job: ActiveJob): void {
    if (job.stopped) return;
    const settings = this.db.getSettings();
    const client = PLAYER_CLIENTS[job.clientIndex % PLAYER_CLIENTS.length];
    const files = fs.existsSync(job.streamDir)
      ? fs.readdirSync(job.streamDir).filter((f) => /^seg_\d+\.mp4$/.test(f))
      : [];
    const startNum = files.length > 0 ? Math.max(...files.map((f) => Number(f.match(/seg_(\d+)/)?.[1] ?? 0))) + 1 : 0;

    job.retrying = false;
    job.pipelineStartMs = Date.now();
    job.lastDataMs = Date.now();
    job.downloadState = 'downloading';
    job.retryInSec = 0;
    this.emitJobStatus(job);

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
      '-y', '-i', 'pipe:0', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-c:a', 'aac',
      '-f', 'segment', '-segment_time', String(settings.segmentSeconds),
      '-segment_start_number', String(startNum), '-reset_timestamps', '1',
      path.join(job.streamDir, 'seg_%05d.mp4'),
    ]);

    job.ytProcess = ytProc;
    job.ffProcess = ffProc;
    ytProc.stdout.on('data', (chunk: Buffer) => {
      job.windowBytes += chunk.length;
      job.lastDataMs = Date.now();
    });
    ytProc.stdout.pipe(ffProc.stdin);
    ytProc.stdout.on('error', () => { /* ignore */ });
    ffProc.stdin.on('error', () => { /* ignore */ });

    const onEnd = () => {
      if (!job.stopped && !job.retrying) this.scheduleLiveRetry(job, 'Live stream connection cut');
    };
    ytProc.on('close', onEnd);
    ffProc.on('close', onEnd);
    ytProc.on('error', onEnd);
    ffProc.on('error', onEnd);
  }

  private scheduleLiveRetry(job: ActiveJob, reason: string): void {
    if (job.stopped || job.retrying) return;
    job.retrying = true;
    this.killProcesses(job);
    job.consecutiveFailures += 1;
    job.clientIndex = (job.clientIndex + 1) % PLAYER_CLIENTS.length;
    const nextClient = PLAYER_CLIENTS[job.clientIndex];
    const isBlocked = job.consecutiveFailures >= 3;
    const waitSec = isBlocked ? Math.min(180, 30 * (job.consecutiveFailures - 2)) : 5;

    job.downloadState = isBlocked ? 'blocked-waiting' : 'throttled-retrying';
    job.retryInSec = waitSec;
    job.record.errorMessage = `${reason}. Next client: ${nextClient}`;
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
        this.spawnLivePipeline(job);
      }
    }, 1000);
  }

  private async analyzeLiveSegment(job: ActiveJob, segPath: string, offsetSec: number, segDur: number): Promise<void> {
    const settings = this.db.getSettings();
    let text = '';
    let words: WordToken[] = [];
    try {
      const res = await this.transcriber.transcribeSegment(this.binaries.ffmpeg, segPath, settings.whisperModel, 0);
      text = res.text;
      words = res.words;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      job.record.errorMessage = msg;
      this.emitJobStatus(job, msg);
      return;
    }

    const [rawAudio, motionScores, llm] = await Promise.all([
      computeAudioEnergy(this.binaries.ffmpeg, segPath, segDur),
      computeVisualMotion(this.binaries.ffmpeg, segPath, segDur),
      scoreTranscript(text, settings),
    ]);

    const segMax = Math.max(0.01, ...rawAudio);
    job.rollingPeakAudio = Math.max(job.rollingPeakAudio * 0.92, segMax);
    const audioScores = rawAudio.map((v) => Math.min(1, v * (segMax / job.rollingPeakAudio)));

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
      await this.createDetectedClip(job.record.id, segPath, {
        startSec: w.startSec,
        endSec: w.endSec,
        score: w.score,
        title: llm.title,
        reason: llm.reason,
      }, words);
    }
  }

  private async createDetectedClip(
    streamId: string,
    sourcePath: string,
    item: { startSec: number; endSec: number; score: number; title: string; reason: string },
    allWords: WordToken[]
  ): Promise<void> {
    const clipId = crypto.randomUUID().slice(0, 8);
    const thumbPath = path.join(path.dirname(sourcePath), `${clipId}_thumb.jpg`);
    await this.extractThumbnail(sourcePath, item.startSec + 1.5, thumbPath);

    const clipWords = allWords
      .filter((wd) => wd.end >= item.startSec && wd.start <= item.endSec)
      .map((wd) => ({
        ...wd,
        start: Number(Math.max(0, wd.start - item.startSec).toFixed(3)),
        end: Number(Math.max(0.1, wd.end - item.startSec).toFixed(3)),
      }));

    const clip = {
      id: clipId,
      streamId,
      title: item.title,
      reason: item.reason,
      viralityScore: item.score,
      startSec: item.startSec,
      endSec: item.endSec,
      durationSec: Number((item.endSec - item.startSec).toFixed(2)),
      sourcePath,
      thumbnailPath: thumbPath,
      renderedPath: null,
      layoutMode: 'blur' as const,
      layoutTemplateId: 'fullscreen-smart',
      captionTemplateId: 'bold-pop',
      fontFamily: 'Montserrat',
      profanityMask: true,
      titlePosition: 'top' as const,
      facecamBox: null,
      suggestedLayout: 'blur' as const,
      words: clipWords,
      createdAt: Date.now(),
    };

    this.db.saveClip(clip);
    this.emit({ type: 'clip:detected', streamId, clip });
  }

  private extractThumbnail(videoPath: string, atSec: number, outPath: string): Promise<void> {
    return new Promise((resolve) => {
      const proc = spawn(this.binaries.ffmpeg, [
        '-y', '-ss', String(atSec), '-i', videoPath, '-frames:v', '1', '-q:v', '3', outPath,
      ]);
      proc.on('close', () => resolve());
    });
  }

  private killProcesses(job: ActiveJob): void {
    try { job.ytProcess?.kill(); } catch { /* ignore */ }
    try { job.ffProcess?.kill(); } catch { /* ignore */ }
    job.ytProcess = undefined;
    job.ffProcess = undefined;
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
