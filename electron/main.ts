import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron';
import { ensureLocalBinaries, getProxyEnv, type LocalBinaries } from './binaries';
import { LocalDatabase } from './db';
import { IngestManager } from './engines/ingest';
import { testLlmConnection } from './engines/llm-scorer';
import { renderVerticalClip } from './engines/renderer';
import type { AppSettings, CaptionTemplate, ClipRecord, ClipperEvent, ExportOrientation, LayoutTemplate } from './types';

let mainWindow: BrowserWindow | null = null;
let db: LocalDatabase;
let binaries: LocalBinaries;
let ingestManager: IngestManager;

const FREE_GOOGLE_TTF_FAMILIES = [
  'Alexandria', 'Montserrat', 'Poppins', 'Inter', 'Oswald', 'Quicksand',
  'Inconsolata', 'Goudy Bookletter 1911', 'Bebas Neue', 'Anton', 'Bangers',
  'Rubik', 'Space Grotesk', 'Syne', 'JetBrains Mono', 'Fredoka',
  'DM Sans', 'Plus Jakarta Sans', 'Orbitron',
];

const proxyEnv = getProxyEnv();
if (proxyEnv) {
  app.commandLine.appendSwitch('proxy-server', proxyEnv);
}

function getTemplatesRoot(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'templates');
  return path.join(process.cwd(), 'templates');
}

function loadJsonTemplates<T>(subdir: string): T[] {
  const dir = path.join(getTemplatesRoot(), subdir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as T);
}

function emitEvent(event: ClipperEvent) {
  mainWindow?.webContents.send('clipper:event', event);
}

async function downloadGoogleTtf(family: string, fontsDir: string): Promise<boolean> {
  const dest = path.join(fontsDir, `${family}.ttf`);
  if (fs.existsSync(dest)) return false;
  for (const query of [`${family.replace(/\s+/g, '+')}:wght@700`, family.replace(/\s+/g, '+')]) {
    try {
      const cssResp = await net.fetch(`https://fonts.googleapis.com/css2?family=${query}`, {
        headers: { 'User-Agent': 'curl/8.0' },
      });
      if (!cssResp.ok) continue;
      const css = await cssResp.text();
      const match = css.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.ttf)\)/);
      if (!match) continue;
      const ttfResp = await net.fetch(match[1]);
      if (!ttfResp.ok) continue;
      await fs.promises.writeFile(dest, Buffer.from(await ttfResp.arrayBuffer()));
      return true;
    } catch {
      // try next weight query
    }
  }
  return false;
}

function createWindow() {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'build', 'icon.png')
    : path.join(process.cwd(), 'build', 'icon.png');

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    backgroundColor: '#09090b',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.CLIPPER_DEV === '1') {
    mainWindow.loadURL('http://localhost:3000');
  } else {
    mainWindow.loadFile(path.join(process.cwd(), 'out', 'index.html'));
  }
}

app.whenReady().then(async () => {
  protocol.registerFileProtocol('clipper-media', (request, callback) => {
    const filePath = decodeURIComponent(request.url.replace('clipper-media://', ''));
    callback({ path: filePath });
  });

  db = new LocalDatabase();
  binaries = await ensureLocalBinaries();
  ingestManager = new IngestManager(db, binaries, emitEvent);

  const fontsDir = path.join(db.getSettings().storagePath, 'fonts');
  fs.mkdirSync(fontsDir, { recursive: true });
  void downloadGoogleTtf('Montserrat', fontsDir);

  registerIpcHandlers();
  createWindow();
  ingestManager.resumeActiveStreams();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  ingestManager?.stopAll();
  if (process.platform !== 'darwin') app.quit();
});

function registerIpcHandlers() {
  ipcMain.handle('streams:list', () => db.listStreams());
  ipcMain.handle('streams:start', (_, url: string) => ingestManager.startStream(url));
  ipcMain.handle('streams:start-local', (_, filePath: string) => ingestManager.startLocalFile(filePath));
  ipcMain.handle('streams:pick-video', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Videos', extensions: ['mp4', 'mov', 'mkv', 'webm'] }],
    });
    return res.canceled ? null : res.filePaths[0];
  });
  ipcMain.handle('streams:stop', (_, id: string) => ingestManager.stopStream(id, true));
  ipcMain.handle('streams:remove', (_, id: string) => {
    ingestManager.stopStream(id, false);
    db.deleteStream(id);
  });

  ipcMain.handle('clips:list', (_, streamId?: string) => db.listClips(streamId));
  ipcMain.handle('clips:get', (_, id: string) => db.getClip(id));
  ipcMain.handle('clips:update', (_, clip: ClipRecord) => {
    db.saveClip(clip);
    return clip;
  });

  ipcMain.handle('clips:render', async (_, clipId: string, orientation: ExportOrientation = 'vertical') => {
    const clip = db.getClip(clipId);
    if (!clip) throw new Error(`Clip ${clipId} not found`);
    const settings = db.getSettings();
    const captionTpls = [
      ...loadJsonTemplates<CaptionTemplate>('captions'),
      ...(db.listCustomTemplates('caption') as CaptionTemplate[]),
    ];
    const layoutTpls = [
      ...loadJsonTemplates<LayoutTemplate>('layouts'),
      ...(db.listCustomTemplates('layout') as LayoutTemplate[]),
    ];

    const captionTpl = captionTpls.find((t) => t.id === clip.captionTemplateId) ?? captionTpls[0];
    const layoutTpl = layoutTpls.find((t) => t.id === clip.layoutTemplateId) ?? layoutTpls[0];
    const outDir = path.join(settings.storagePath, 'exports');
    fs.mkdirSync(outDir, { recursive: true });

    const targets: Array<'vertical' | 'horizontal'> =
      orientation === 'both' ? ['vertical', 'horizontal'] : [orientation];
    const outputs: string[] = [];

    emitEvent({ type: 'render:progress', clipId, progress: 0, status: 'rendering' });

    try {
      for (let i = 0; i < targets.length; i++) {
        const mode = targets[i];
        const outPath = path.join(outDir, `${clip.id}_${mode}.mp4`);
        await renderVerticalClip({
          ffmpegPath: binaries.ffmpeg,
          ffprobePath: binaries.ffprobe,
          clip,
          captionTemplate: captionTpl,
          layoutTemplate: layoutTpl,
          fontsDir: path.join(settings.storagePath, 'fonts'),
          outputPath: outPath,
          fps: settings.outputFps,
          crf: settings.outputCrf,
          orientation: mode,
          onProgress: (p) => {
            const totalPct = Math.round(((i * 100 + p) / targets.length));
            emitEvent({ type: 'render:progress', clipId, progress: totalPct, status: 'rendering' });
          },
        });
        outputs.push(outPath);
      }

      clip.renderedPath = outputs[0];
      db.saveClip(clip);
      emitEvent({ type: 'render:progress', clipId, progress: 100, status: 'done', outputPath: outputs[0] });
      return outputs;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emitEvent({ type: 'render:progress', clipId, progress: 0, status: 'error', error: msg });
      throw err;
    }
  });

  ipcMain.handle('shell:reveal', (_, filePath: string) => shell.showItemInFolder(filePath));

  ipcMain.handle('templates:captions', () => [
    ...loadJsonTemplates<CaptionTemplate>('captions'),
    ...(db.listCustomTemplates('caption') as CaptionTemplate[]),
  ]);
  ipcMain.handle('templates:layouts', () => [
    ...loadJsonTemplates<LayoutTemplate>('layouts'),
    ...(db.listCustomTemplates('layout') as LayoutTemplate[]),
  ]);
  ipcMain.handle('templates:save-caption', (_, tpl: CaptionTemplate) => db.saveCustomTemplate('caption', tpl));
  ipcMain.handle('templates:save-layout', (_, tpl: LayoutTemplate) => db.saveCustomTemplate('layout', tpl));

  ipcMain.handle('fonts:list', () => {
    const fontsDir = path.join(db.getSettings().storagePath, 'fonts');
    fs.mkdirSync(fontsDir, { recursive: true });
    return fs
      .readdirSync(fontsDir)
      .filter((f) => /\.(ttf|otf)$/i.test(f))
      .map((f) => ({ name: path.parse(f).name, path: path.join(fontsDir, f), custom: true }));
  });

  ipcMain.handle('fonts:upload', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Fonts', extensions: ['ttf', 'otf'] }],
    });
    if (res.canceled || res.filePaths.length === 0) return [];
    const fontsDir = path.join(db.getSettings().storagePath, 'fonts');
    fs.mkdirSync(fontsDir, { recursive: true });
    return res.filePaths.map((src) => {
      const dest = path.join(fontsDir, path.basename(src));
      fs.copyFileSync(src, dest);
      return { name: path.parse(dest).name, path: dest };
    });
  });

  ipcMain.handle('fonts:download-pack', async () => {
    const fontsDir = path.join(db.getSettings().storagePath, 'fonts');
    fs.mkdirSync(fontsDir, { recursive: true });
    let downloaded = 0;
    for (const family of FREE_GOOGLE_TTF_FAMILIES) {
      if (await downloadGoogleTtf(family, fontsDir)) downloaded += 1;
    }
    return { downloaded, total: FREE_GOOGLE_TTF_FAMILIES.length };
  });

  ipcMain.handle('fonts:open-folder', () => {
    const fontsDir = path.join(db.getSettings().storagePath, 'fonts');
    fs.mkdirSync(fontsDir, { recursive: true });
    void shell.openPath(fontsDir);
  });

  ipcMain.handle('settings:get', () => db.getSettings());
  ipcMain.handle('settings:save', (_, settings: AppSettings) => db.saveSettings(settings));
  ipcMain.handle('settings:test-llm', (_, settings: AppSettings) => testLlmConnection(settings));
  ipcMain.handle('settings:pick-folder', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return res.canceled ? null : res.filePaths[0];
  });
  ipcMain.handle('settings:pick-cookies', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Cookies Text', extensions: ['txt'] }],
    });
    return res.canceled ? null : res.filePaths[0];
  });
}
