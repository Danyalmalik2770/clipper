import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import tls from 'node:tls';
import { app, net } from 'electron';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

export interface LocalBinaries {
  ffmpeg: string;
  ffprobe: string;
  ytDlp: string;
}

export function getProxyEnv(): string | undefined {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    undefined
  );
}

function getExtraCa(): string[] | undefined {
  const caFile = process.env.NODE_EXTRA_CA_CERTS;
  if (!caFile || !fs.existsSync(caFile)) return undefined;
  return [...tls.rootCertificates, fs.readFileSync(caFile, 'utf-8')];
}

function getYtDlpFilename(): string {
  if (process.platform === 'win32') return 'yt-dlp.exe';
  if (process.platform === 'darwin') return 'yt-dlp_macos';
  return 'yt-dlp';
}

export function findYtDlpOnPath(): string | null {
  const names = process.platform === 'win32' ? ['yt-dlp.exe', 'yt-dlp.cmd', 'yt-dlp.bat'] : ['yt-dlp'];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

async function downloadViaProxyOrNode(url: string, dest: string, depth = 0): Promise<void> {
  if (depth > 5) throw new Error('Too many redirects downloading yt-dlp');
  const target = new URL(url);
  const proxyUrl = getProxyEnv();
  const ca = getExtraCa();

  if (proxyUrl && target.protocol === 'https:') {
    const proxy = new URL(proxyUrl);
    return new Promise((resolve, reject) => {
      const connectReq = http.request({
        host: proxy.hostname,
        port: Number(proxy.port) || 8080,
        method: 'CONNECT',
        path: `${target.hostname}:${target.port || 443}`,
      });
      connectReq.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          reject(new Error(`Proxy CONNECT failed (${res.statusCode})`));
          return;
        }
        const tlsSocket = tls.connect({ socket, servername: target.hostname, ca });
        const req = https.get(
          url,
          { createConnection: () => tlsSocket, headers: { 'User-Agent': 'Clipper-App' } },
          (resp) => {
            if (resp.statusCode && resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
              resp.resume();
              resolve(downloadViaProxyOrNode(resp.headers.location, dest, depth + 1));
              return;
            }
            if (resp.statusCode !== 200) {
              reject(new Error(`HTTP ${resp.statusCode} downloading ${url}`));
              return;
            }
            const out = fs.createWriteStream(dest);
            resp.pipe(out);
            out.on('finish', () => { out.close(); resolve(); });
            out.on('error', reject);
          }
        );
        req.on('error', reject);
      });
      connectReq.on('error', reject);
      connectReq.end();
    });
  }

  // Electron net.fetch honours OS system certificates and Chromium proxy settings automatically
  if (!ca) {
    const resp = await net.fetch(url, { redirect: 'follow' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} downloading ${url}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    await fs.promises.writeFile(dest, buf);
    return;
  }

  return new Promise((resolve, reject) => {
    const req = https.get(url, { ca, headers: { 'User-Agent': 'Clipper-App' } }, (resp) => {
      if (resp.statusCode && resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
        resp.resume();
        resolve(downloadViaProxyOrNode(resp.headers.location, dest, depth + 1));
        return;
      }
      if (resp.statusCode !== 200) {
        reject(new Error(`HTTP ${resp.statusCode} downloading ${url}`));
        return;
      }
      const out = fs.createWriteStream(dest);
      resp.pipe(out);
      out.on('finish', () => { out.close(); resolve(); });
      out.on('error', reject);
    });
    req.on('error', reject);
  });
}

/**
 * Resolves local binaries inside the user's PC.
 * Downloads yt-dlp with proxy/CA support and falls back to system PATH on failure.
 */
export async function ensureLocalBinaries(): Promise<LocalBinaries> {
  const binDir = path.join(app.getPath('userData'), 'bin');
  const ytDlpName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  let ytDlpPath = path.join(binDir, ytDlpName);

  if (!fs.existsSync(ytDlpPath)) {
    const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${getYtDlpFilename()}`;
    await fs.promises.mkdir(binDir, { recursive: true });
    try {
      await downloadViaProxyOrNode(url, ytDlpPath);
      if (process.platform !== 'win32') await fs.promises.chmod(ytDlpPath, 0o755);
    } catch (err) {
      try { if (fs.existsSync(ytDlpPath)) fs.unlinkSync(ytDlpPath); } catch { /* ignore */ }
      const fromPath = findYtDlpOnPath();
      if (fromPath) {
        ytDlpPath = fromPath;
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to download yt-dlp (${msg}) and no yt-dlp was found on PATH.`);
      }
    }
  }

  const ffmpeg = (ffmpegStatic || 'ffmpeg').replace('app.asar', 'app.asar.unpacked');
  const ffprobe = (ffprobeStatic.path || 'ffprobe').replace('app.asar', 'app.asar.unpacked');

  return { ffmpeg, ffprobe, ytDlp: ytDlpPath };
}
