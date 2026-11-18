import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { Readable } from 'node:stream';
import tls from 'node:tls';
import { app, net } from 'electron';
import { getProxyEnv } from '../binaries';
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

function nodeFetchWithCaAndProxy(
  input: string | URL | Request,
  init?: RequestInit,
  depth = 0
): Promise<Response> {
  if (depth > 6) return Promise.reject(new Error('Too many redirects'));
  const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const parsed = new URL(urlStr);
  const caPath = process.env.NODE_EXTRA_CA_CERTS;
  const ca = caPath && fs.existsSync(caPath) ? [...tls.rootCertificates, fs.readFileSync(caPath, 'utf-8')] : undefined;
  const proxyUrl = getProxyEnv();

  const headers: Record<string, string> = {};
  if (init?.headers) {
    new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
  }

  const runRequest = (createConnection?: () => tls.TLSSocket) =>
    new Promise<Response>((resolve, reject) => {
      const mod = parsed.protocol === 'https:' ? https : http;
      const req = mod.request(
        parsed,
        { method: init?.method || 'GET', headers, ca, createConnection } as https.RequestOptions,
        (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            const nextUrl = new URL(res.headers.location, parsed).toString();
            resolve(nodeFetchWithCaAndProxy(nextUrl, init, depth + 1));
            return;
          }
          const respHeaders = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) v.forEach((item) => respHeaders.append(k, item));
            else if (v !== undefined) respHeaders.set(k, v);
          }
          const body = Readable.toWeb(res) as ReadableStream;
          resolve(new Response(body, { status: res.statusCode || 200, headers: respHeaders }));
        }
      );
      req.on('error', reject);
      req.end();
    });

  if (proxyUrl && parsed.protocol === 'https:') {
    const proxy = new URL(proxyUrl);
    return new Promise((resolve, reject) => {
      const conn = http.request({
        host: proxy.hostname,
        port: Number(proxy.port) || 8080,
        method: 'CONNECT',
        path: `${parsed.hostname}:${parsed.port || 443}`,
      });
      conn.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          reject(new Error(`Proxy CONNECT error ${res.statusCode}`));
          return;
        }
        const tlsSock = tls.connect({ socket, servername: parsed.hostname, ca });
        resolve(runRequest(() => tlsSock));
      });
      conn.on('error', reject);
      conn.end();
    });
  }

  return runRequest();
}

/**
 * 100% Free, Offline Local Whisper Transcriber using @huggingface/transformers (ONNX).
 * Honours NODE_EXTRA_CA_CERTS, HTTPS_PROXY/HTTP_PROXY, and OS system certificates.
 */
export class LocalTranscriber {
  private pipePromise: Promise<PipelineFn> | null = null;
  private loadedModel = '';

  private installCertAndProxyFetch(): void {
    const hasCustomCa = Boolean(process.env.NODE_EXTRA_CA_CERTS && fs.existsSync(process.env.NODE_EXTRA_CA_CERTS));
    const hasProxy = Boolean(getProxyEnv());
    if (hasCustomCa || hasProxy) {
      globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
        nodeFetchWithCaAndProxy(input, init)) as typeof fetch;
    } else {
      globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
        net.fetch(input, init)) as typeof fetch;
    }
  }

  private async getPipeline(modelId: string): Promise<PipelineFn> {
    if (this.pipePromise && this.loadedModel === modelId) {
      return this.pipePromise;
    }

    this.loadedModel = modelId;
    this.installCertAndProxyFetch();

    this.pipePromise = (async () => {
      try {
        const { env, pipeline } = await import('@huggingface/transformers');
        const modelsDir = path.join(app.getPath('userData'), 'models');
        fs.mkdirSync(modelsDir, { recursive: true });
        env.cacheDir = modelsDir;
        env.allowLocalModels = true;

        const asr = await pipeline('automatic-speech-recognition', modelId, { dtype: 'q8' });
        return asr as unknown as PipelineFn;
      } catch (err) {
        this.pipePromise = null;
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Whisper model download/load failed (${modelId}): ${msg}`);
      }
    })();

    return this.pipePromise;
  }

  private extractPcm16k(ffmpegPath: string, mediaPath: string): Promise<Float32Array> {
    return new Promise((resolve, reject) => {
      const proc = spawn(ffmpegPath, [
        '-v', 'error', '-i', mediaPath, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1',
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
        resolve(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)));
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
    if (pcm.length < 1600) return { text: '', words: [] };

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
