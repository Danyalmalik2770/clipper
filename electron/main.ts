import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron';
import { ensureLocalBinaries, getProxyEnv, type LocalBinaries } from './binaries';
import { LocalDatabase } from './db';
import { IngestManager } from './engines/ingest';
import { renderVerticalClip } from './engines/renderer';
import type { AppSettings, CaptionTemplate, ClipRecord, ClipperEvent, LayoutTemplate } from './types';

let mainWindow: BrowserWindow | null = null;
let db: LocalDatabase;
let binaries: LocalBinaries;
let ingestManager: IngestManager;

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

  ipcMain.handle('clips:render', async (_, clipId: string) => {
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
    const outPath = path.join(outDir, `${clip.id}_vertical.mp4`);

    emitEvent({ type: 'render:progress', clipId, progress: 0, status: 'rendering' });

    try {
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
        onProgress: (progress) =>
          emitEvent({ type: 'render:progress', clipId, progress, status: 'rendering' }),
      });

      clip.renderedPath = outPath;
      db.saveClip(clip);
      emitEvent({ type: 'render:progress', clipId, progress: 100, status: 'done', outputPath: outPath });
      return outPath;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emitEvent({ type: 'render:progress', clipId, progress: 0, status: 'error', error: msg });
      throw err;
    }
  });

  ipcMain.handle('shell:reveal', (_, filePath: string) => {
    shell.showItemInFolder(filePath);
  });

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
      properties: ['openFile'],
      filters: [{ name: 'Fonts', extensions: ['ttf', 'otf'] }],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    const src = res.filePaths[0];
    const fontsDir = path.join(db.getSettings().storagePath, 'fonts');
    fs.mkdirSync(fontsDir, { recursive: true });
    const dest = path.join(fontsDir, path.basename(src));
    fs.copyFileSync(src, dest);
    return { name: path.parse(dest).name, path: dest };
  });

  ipcMain.handle('settings:get', () => db.getSettings());
  ipcMain.handle('settings:save', (_, settings: AppSettings) => db.saveSettings(settings));
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
