import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CaptionTemplate, ClipRecord, LayoutTemplate } from '../types';
import { generateAssSubtitles } from './captions';
import { buildLayoutFilterGraph } from './layout';

function probeDimensions(ffprobePath: string, filePath: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const proc = spawn(ffprobePath, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'json',
      filePath,
    ]);
    const chunks: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.on('close', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
          streams?: Array<{ width?: number; height?: number }>;
        };
        const st = parsed.streams?.[0];
        resolve({ width: st?.width ?? 1920, height: st?.height ?? 1080 });
      } catch {
        resolve({ width: 1920, height: 1080 });
      }
    });
  });
}

function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

/**
 * Renders the final 1080x1920 vertical MP4 locally using user's bundled ffmpeg
 * with real-time progress reporting.
 */
export async function renderVerticalClip(params: {
  ffmpegPath: string;
  ffprobePath: string;
  clip: ClipRecord;
  captionTemplate: CaptionTemplate;
  layoutTemplate: LayoutTemplate;
  fontsDir: string;
  outputPath: string;
  fps: 30 | 60;
  crf: number;
  onProgress: (percent: number) => void;
}): Promise<void> {
  const { clip } = params;
  const dims = await probeDimensions(params.ffprobePath, clip.sourcePath);
  const duration = Math.max(1, clip.endSec - clip.startSec);

  const layout = buildLayoutFilterGraph({
    sourceWidth: dims.width,
    sourceHeight: dims.height,
    mode: clip.layoutMode,
    template: params.layoutTemplate,
    facecamBox: clip.facecamBox,
  });

  const assContent = generateAssSubtitles({
    words: clip.words,
    template: params.captionTemplate,
    fontFamily: clip.fontFamily,
    profanityMask: clip.profanityMask,
    title: clip.title,
    titlePosition: clip.titlePosition,
    durationSec: duration,
  });

  const assPath = path.join(os.tmpdir(), `clipper_${clip.id}.ass`);
  fs.writeFileSync(assPath, assContent, 'utf-8');

  const escAss = escapeFilterPath(assPath);
  const escFonts = escapeFilterPath(params.fontsDir);
  const fullFilter = `${layout.filterComplex};${layout.videoMap}ass='${escAss}':fontsdir='${escFonts}'[vfinal]`;

  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-ss', String(clip.startSec),
      '-t', String(duration),
      '-i', clip.sourcePath,
      '-filter_complex', fullFilter,
      '-map', '[vfinal]',
      '-map', '0:a?',
      '-r', String(params.fps),
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', String(params.crf),
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '160k',
      '-movflags', '+faststart',
      '-progress', 'pipe:1',
      params.outputPath,
    ];

    const proc = spawn(params.ffmpegPath, args);
    let errLog = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      const match = text.match(/out_time_us=(\d+)/);
      if (match) {
        const outSec = Number(match[1]) / 1_000_000;
        const pct = Math.min(99, Math.max(1, Math.round((outSec / duration) * 100)));
        params.onProgress(pct);
      }
    });

    proc.stderr.on('data', (d: Buffer) => {
      errLog += d.toString('utf-8').slice(-800);
    });

    proc.on('close', (code) => {
      try { fs.unlinkSync(assPath); } catch { /* ignore */ }
      if (code === 0) {
        params.onProgress(100);
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}: ${errLog}`));
      }
    });
  });
}
