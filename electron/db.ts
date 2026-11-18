import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { app } from 'electron';
import type {
  AppSettings,
  CaptionTemplate,
  ClipRecord,
  LayoutTemplate,
  StreamRecord,
} from './types';

export class LocalDatabase {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const defaultDir = path.join(app.getPath('home'), 'ClipperData');
    fs.mkdirSync(defaultDir, { recursive: true });
    const finalPath = dbPath ?? path.join(defaultDir, 'clipper.db');
    this.db = new Database(finalPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS streams (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        title TEXT NOT NULL,
        channel TEXT NOT NULL,
        is_live INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'idle',
        buffer_seconds REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        error_message TEXT
      );

      CREATE TABLE IF NOT EXISTS segments (
        id TEXT PRIMARY KEY,
        stream_id TEXT NOT NULL,
        index_num INTEGER NOT NULL,
        file_path TEXT NOT NULL,
        start_sec REAL NOT NULL,
        duration_sec REAL NOT NULL,
        transcript_json TEXT,
        processed INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(stream_id) REFERENCES streams(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_id TEXT NOT NULL,
        timestamp_sec REAL NOT NULL,
        author TEXT NOT NULL,
        message TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS clips (
        id TEXT PRIMARY KEY,
        stream_id TEXT NOT NULL,
        title TEXT NOT NULL,
        reason TEXT NOT NULL,
        virality_score REAL NOT NULL,
        start_sec REAL NOT NULL,
        end_sec REAL NOT NULL,
        duration_sec REAL NOT NULL,
        source_path TEXT NOT NULL,
        thumbnail_path TEXT,
        rendered_path TEXT,
        layout_mode TEXT NOT NULL,
        layout_template_id TEXT NOT NULL,
        caption_template_id TEXT NOT NULL,
        font_family TEXT NOT NULL,
        profanity_mask INTEGER NOT NULL DEFAULT 1,
        title_position TEXT NOT NULL DEFAULT 'top',
        facecam_box_json TEXT,
        suggested_layout TEXT NOT NULL,
        words_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(stream_id) REFERENCES streams(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS custom_templates (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
    `);
  }

  getDefaultSettings(): AppSettings {
    const baseData = path.join(app.getPath('home'), 'ClipperData');
    return {
      storagePath: baseData,
      bufferHours: 2,
      segmentSeconds: 30,
      whisperModel: 'onnx-community/whisper-base_timestamped',
      llmProvider: 'none',
      openaiApiKey: '',
      anthropicApiKey: '',
      ollamaUrl: 'http://127.0.0.1:11434',
      ollamaModel: 'llama3.2',
      viralityThreshold: 0.58,
      minClipSeconds: 15,
      maxClipSeconds: 60,
      outputFps: 30,
      outputCrf: 20,
      theme: 'dark',
    };
  }

  getSettings(): AppSettings {
    const row = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get('app') as
      | { value_json: string }
      | undefined;
    if (!row) {
      const defaults = this.getDefaultSettings();
      this.saveSettings(defaults);
      return defaults;
    }
    return { ...this.getDefaultSettings(), ...JSON.parse(row.value_json) };
  }

  saveSettings(settings: AppSettings): AppSettings {
    fs.mkdirSync(settings.storagePath, { recursive: true });
    this.db
      .prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)')
      .run('app', JSON.stringify(settings));
    return settings;
  }

  upsertStream(stream: StreamRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO streams (id, url, title, channel, is_live, status, buffer_seconds, created_at, error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        stream.id,
        stream.url,
        stream.title,
        stream.channel,
        stream.isLive ? 1 : 0,
        stream.status,
        stream.bufferSeconds,
        stream.createdAt,
        stream.errorMessage ?? null
      );
  }

  listStreams(): StreamRecord[] {
    const rows = this.db
      .prepare(
        `SELECT s.*, COUNT(c.id) AS clips_count
         FROM streams s
         LEFT JOIN clips c ON c.stream_id = s.id
         GROUP BY s.id
         ORDER BY s.created_at DESC`
      )
      .all() as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: String(r.id),
      url: String(r.url),
      title: String(r.title),
      channel: String(r.channel),
      isLive: Boolean(r.is_live),
      status: r.status as StreamRecord['status'],
      bufferSeconds: Number(r.buffer_seconds),
      clipsCount: Number(r.clips_count ?? 0),
      createdAt: Number(r.created_at),
      errorMessage: r.error_message ? String(r.error_message) : null,
    }));
  }

  deleteStream(id: string): void {
    this.db.prepare('DELETE FROM streams WHERE id = ?').run(id);
  }

  insertChatMessage(streamId: string, timestampSec: number, author: string, message: string): void {
    this.db
      .prepare('INSERT INTO chat_messages (stream_id, timestamp_sec, author, message) VALUES (?, ?, ?, ?)')
      .run(streamId, timestampSec, author, message);
  }

  getChatInWindow(streamId: string, startSec: number, endSec: number): Array<{ timestampSec: number; message: string }> {
    return this.db
      .prepare(
        'SELECT timestamp_sec AS timestampSec, message FROM chat_messages WHERE stream_id = ? AND timestamp_sec BETWEEN ? AND ?'
      )
      .all(streamId, startSec, endSec) as Array<{ timestampSec: number; message: string }>;
  }

  private mapClipRow(r: Record<string, unknown>): ClipRecord {
    return {
      id: String(r.id),
      streamId: String(r.stream_id),
      title: String(r.title),
      reason: String(r.reason),
      viralityScore: Number(r.virality_score),
      startSec: Number(r.start_sec),
      endSec: Number(r.end_sec),
      durationSec: Number(r.duration_sec),
      sourcePath: String(r.source_path),
      thumbnailPath: r.thumbnail_path ? String(r.thumbnail_path) : null,
      renderedPath: r.rendered_path ? String(r.rendered_path) : null,
      layoutMode: r.layout_mode as ClipRecord['layoutMode'],
      layoutTemplateId: String(r.layout_template_id),
      captionTemplateId: String(r.caption_template_id),
      fontFamily: String(r.font_family),
      profanityMask: Boolean(r.profanity_mask),
      titlePosition: r.title_position as ClipRecord['titlePosition'],
      facecamBox: r.facecam_box_json ? JSON.parse(String(r.facecam_box_json)) : null,
      suggestedLayout: r.suggested_layout as ClipRecord['suggestedLayout'],
      words: JSON.parse(String(r.words_json)),
      createdAt: Number(r.created_at),
    };
  }

  saveClip(clip: ClipRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO clips (
          id, stream_id, title, reason, virality_score, start_sec, end_sec, duration_sec,
          source_path, thumbnail_path, rendered_path, layout_mode, layout_template_id,
          caption_template_id, font_family, profanity_mask, title_position,
          facecam_box_json, suggested_layout, words_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        clip.id,
        clip.streamId,
        clip.title,
        clip.reason,
        clip.viralityScore,
        clip.startSec,
        clip.endSec,
        clip.durationSec,
        clip.sourcePath,
        clip.thumbnailPath,
        clip.renderedPath,
        clip.layoutMode,
        clip.layoutTemplateId,
        clip.captionTemplateId,
        clip.fontFamily,
        clip.profanityMask ? 1 : 0,
        clip.titlePosition,
        clip.facecamBox ? JSON.stringify(clip.facecamBox) : null,
        clip.suggestedLayout,
        JSON.stringify(clip.words),
        clip.createdAt
      );
  }

  listClips(streamId?: string): ClipRecord[] {
    const rows = (
      streamId
        ? this.db.prepare('SELECT * FROM clips WHERE stream_id = ? ORDER BY virality_score DESC').all(streamId)
        : this.db.prepare('SELECT * FROM clips ORDER BY created_at DESC').all()
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapClipRow(r));
  }

  getClip(id: string): ClipRecord | null {
    const row = this.db.prepare('SELECT * FROM clips WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.mapClipRow(row) : null;
  }

  saveCustomTemplate(kind: 'caption' | 'layout', tpl: CaptionTemplate | LayoutTemplate): void {
    this.db
      .prepare('INSERT OR REPLACE INTO custom_templates (id, kind, payload_json) VALUES (?, ?, ?)')
      .run(tpl.id, kind, JSON.stringify(tpl));
  }

  listCustomTemplates(kind: 'caption' | 'layout'): Array<CaptionTemplate | LayoutTemplate> {
    const rows = this.db
      .prepare('SELECT payload_json FROM custom_templates WHERE kind = ?')
      .all(kind) as Array<{ payload_json: string }>;
    return rows.map((r) => JSON.parse(r.payload_json));
  }
}
