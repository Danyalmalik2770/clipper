import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { WordToken } from '../types';

interface AsrChunk {
  text: string;
  timestamp: [number, number | null];
}

interface AsrResult {
  text: string;
  chunks?: AsrChunk[];
}

type PipelineFn = (
  audio: Float32Array,
  options: Record<string, unknown>
) => Promise<AsrResult>;

/**
 * 100% Free, Offline Local Whisper Transcriber using @huggingface/transformers (ONNX).
 * Downloads the selected model once into the user's local PC folder.
 */
export class LocalTranscriber {
  private pipePromise: Promise<PipelineFn> | null = null;
  private loadedModel = '';

  private async getPipeline(modelId: string): Promise<PipelineFn> {
    if (this.pipePromise && this.loadedModel === modelId) {
      return this.pipePromise;
    }

    this.loadedModel = modelId;
    this.pipePromise = (async () => {
      const { env, pipeline } = await import('@huggingface/transformers');
      const modelsDir = path.join(app.getPath('userData'), 'models');
      fs.mkdirSync(modelsDir, { recursive: true });
      env.cacheDir = modelsDir;
      env.allowLocalModels = true;

      const asr = await pipeline('automatic-speech-recognition', modelId, {
        dtype: 'q8',
      });
      return asr as unknown as PipelineFn;
    })();

    return this.pipePromise;
  }

  private extractPcm16k(ffmpegPath: string, mediaPath: string): Promise<Float32Array> {
    return new Promise((resolve, reject) => {
      const proc = spawn(ffmpegPath, [
        '-v', 'error',
        '-i', mediaPath,
        '-vn',
        '-ac', '1',
        '-ar', '16000',
        '-f', 'f32le',
        'pipe:1',
      ]);

      const chunks: Buffer[] = [];
      proc.stdout.on('data', (d: Buffer) => chunks.push(d));
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`ffmpeg PCM extraction failed with code ${code}`));
          return;
        }
        const buf = Buffer.concat(chunks);
        const samples = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
        resolve(samples);
      });
    });
  }

  async transcribeSegment(
    ffmpegPath: string,
    segmentPath: string,
    modelId: string,
    offsetSec = 0
  ): Promise<{ text: string; words: WordToken[] }> {
    const pcm = await this.extractPcm16k(ffmpegPath, segmentPath);
    if (pcm.length < 1600) {
      return { text: '', words: [] };
    }

    const asr = await this.getPipeline(modelId);
    const result = await asr(pcm, {
      return_timestamps: 'word',
      chunk_length_s: 30,
      stride_length_s: 5,
    });

    const words: WordToken[] = (result.chunks ?? [])
      .filter((c) => c.text.trim().length > 0 && Array.isArray(c.timestamp))
      .map((c) => {
        const start = (c.timestamp[0] ?? 0) + offsetSec;
        const end = (c.timestamp[1] ?? (c.timestamp[0] ?? 0) + 0.25) + offsetSec;
        return {
          word: c.text.trim(),
          start: Number(start.toFixed(3)),
          end: Number(Math.max(start + 0.08, end).toFixed(3)),
        };
      });

    return { text: result.text.trim(), words };
  }
}
