import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { app } from 'electron';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

export interface LocalBinaries {
  ffmpeg: string;
  ffprobe: string;
  ytDlp: string;
}

function getYtDlpFilename(): string {
  if (process.platform === 'win32') return 'yt-dlp.exe';
  if (process.platform === 'darwin') return 'yt-dlp_macos';
  return 'yt-dlp';
}

function getYtDlpDownloadUrl(): string {
  return `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${getYtDlpFilename()}`;
}

async function downloadFile(url: string, dest: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  return new Promise((resolve, reject) => {
    const request = (currentUrl: string) => {
      https
        .get(currentUrl, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            request(res.headers.location);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`Failed to download binary (${res.statusCode}) from ${currentUrl}`));
            return;
          }
          const file = fs.createWriteStream(dest);
          res.pipe(file);
          file.on('finish', () => {
            file.close();
            resolve();
          });
          file.on('error', reject);
        })
        .on('error', reject);
    };
    request(url);
  });
}

/**
 * Resolves local binaries inside the user's PC (zero server dependencies).
 * Bundles ffmpeg/ffprobe via npm and auto-fetches yt-dlp into userData/bin on first launch.
 */
export async function ensureLocalBinaries(): Promise<LocalBinaries> {
  const binDir = path.join(app.getPath('userData'), 'bin');
  const ytDlpName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const ytDlpPath = path.join(binDir, ytDlpName);

  if (!fs.existsSync(ytDlpPath)) {
    await downloadFile(getYtDlpDownloadUrl(), ytDlpPath);
    if (process.platform !== 'win32') {
      await fs.promises.chmod(ytDlpPath, 0o755);
    }
  }

  const ffmpeg = (ffmpegStatic || 'ffmpeg').replace('app.asar', 'app.asar.unpacked');
  const ffprobe = (ffprobeStatic.path || 'ffprobe').replace('app.asar', 'app.asar.unpacked');

  return { ffmpeg, ffprobe, ytDlp: ytDlpPath };
}
