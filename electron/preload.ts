import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppSettings,
  CaptionTemplate,
  ClipRecord,
  ClipperEvent,
  LayoutTemplate,
  StreamRecord,
} from './types';

const api = {
  streams: {
    list: (): Promise<StreamRecord[]> => ipcRenderer.invoke('streams:list'),
    start: (url: string): Promise<StreamRecord> => ipcRenderer.invoke('streams:start', url),
    stop: (id: string): Promise<void> => ipcRenderer.invoke('streams:stop', id),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('streams:remove', id),
  },
  clips: {
    list: (streamId?: string): Promise<ClipRecord[]> => ipcRenderer.invoke('clips:list', streamId),
    get: (id: string): Promise<ClipRecord | null> => ipcRenderer.invoke('clips:get', id),
    update: (clip: ClipRecord): Promise<ClipRecord> => ipcRenderer.invoke('clips:update', clip),
    render: (clipId: string): Promise<string> => ipcRenderer.invoke('clips:render', clipId),
    revealInFolder: (filePath: string): Promise<void> => ipcRenderer.invoke('shell:reveal', filePath),
  },
  templates: {
    listCaptions: (): Promise<CaptionTemplate[]> => ipcRenderer.invoke('templates:captions'),
    listLayouts: (): Promise<LayoutTemplate[]> => ipcRenderer.invoke('templates:layouts'),
    saveCaption: (tpl: CaptionTemplate): Promise<void> => ipcRenderer.invoke('templates:save-caption', tpl),
    saveLayout: (tpl: LayoutTemplate): Promise<void> => ipcRenderer.invoke('templates:save-layout', tpl),
  },
  fonts: {
    list: (): Promise<Array<{ name: string; path: string; custom: boolean }>> => ipcRenderer.invoke('fonts:list'),
    upload: (): Promise<{ name: string; path: string } | null> => ipcRenderer.invoke('fonts:upload'),
  },
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
    save: (settings: AppSettings): Promise<AppSettings> => ipcRenderer.invoke('settings:save', settings),
    pickFolder: (): Promise<string | null> => ipcRenderer.invoke('settings:pick-folder'),
  },
  onEvent: (cb: (event: ClipperEvent) => void): (() => void) => {
    const listener = (_: unknown, payload: ClipperEvent) => cb(payload);
    ipcRenderer.on('clipper:event', listener);
    return () => ipcRenderer.removeListener('clipper:event', listener);
  },
};

contextBridge.exposeInMainWorld('clipper', api);
