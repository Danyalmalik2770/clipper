"use client";
import React, { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Download, FolderOpen, Pause, Play, ScanFace, Sparkles, Upload } from 'lucide-react';
import type { CaptionTemplate, ClipRecord, LayoutMode, LayoutTemplate, RectNormalized } from '../../../electron/types';
import { Badge, Button, Card, Input, useToast } from '@/components/ui';
import { formatSeconds, mediaUrl } from '@/lib/clipper-client';
import { detectFacecamInVideo } from '@/lib/facecam';
import { BUNDLED_GOOGLE_FONTS } from '@/lib/fonts';

function EditorInner() {
  const params = useSearchParams();
  const clipId = params.get('id') ?? '';
  const toast = useToast();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [clip, setClip] = useState<ClipRecord | null>(null);
  const [captionTpls, setCaptionTpls] = useState<CaptionTemplate[]>([]);
  const [layoutTpls, setLayoutTpls] = useState<LayoutTemplate[]>([]);
  const [customFonts, setCustomFonts] = useState<string[]>([]);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [renderPct, setRenderPct] = useState<number | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!clipId || !window.clipper) return;
    Promise.all([
      window.clipper.clips.get(clipId),
      window.clipper.templates.listCaptions(),
      window.clipper.templates.listLayouts(),
      window.clipper.fonts.list(),
    ]).then(([c, ct, lt, cf]) => {
      setClip(c);
      setCaptionTpls(ct);
      setLayoutTpls(lt);
      setCustomFonts(cf.map((f) => f.name));
    });

    return window.clipper.onEvent((ev) => {
      if (ev.type === 'render:progress' && ev.clipId === clipId) {
        if (ev.status === 'rendering') setRenderPct(ev.progress);
        if (ev.status === 'done') {
          setRenderPct(null);
          toast('Export complete! Saved locally.');
          window.clipper?.clips.get(clipId).then((updated) => updated && setClip(updated));
        }
        if (ev.status === 'error') {
          setRenderPct(null);
          toast(`Export failed: ${ev.error}`);
        }
      }
    });
  }, [clipId, toast]);

  // Live 9:16 canvas compositor synced to the source <video>
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const v = videoRef.current;
      const c = canvasRef.current;
      if (v && c && clip && v.readyState >= 2) {
        const ctx = c.getContext('2d');
        if (ctx) {
          const W = c.width;
          const H = c.height;
          const sw = v.videoWidth || 1920;
          const sh = v.videoHeight || 1080;
          const box = clip.facecamBox ?? { x: 0.02, y: 0.68, w: 0.26, h: 0.28 };
          const fx = box.x * sw;
          const fy = box.y * sh;
          const fw = box.w * sw;
          const fh = box.h * sh;

          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, W, H);

          if (clip.layoutMode === 'stacked') {
            const topH = Math.round(H * 0.38);
            ctx.drawImage(v, fx, fy, fw, fh, 0, 0, W, topH);
            const cropW = Math.min(sw, sh * (W / (H - topH)));
            ctx.drawImage(v, (sw - cropW) / 2, 0, cropW, sh, 0, topH, W, H - topH);
          } else if (clip.layoutMode === 'pip') {
            const cropW = Math.min(sw, sh * (9 / 16));
            ctx.drawImage(v, (sw - cropW) / 2, 0, cropW, sh, 0, 0, W, H);
            const pw = Math.round(W * 0.3);
            const ph = Math.round(pw * (fh / fw));
            ctx.drawImage(v, fx, fy, fw, fh, W - pw - 12, H - ph - 90, pw, ph);
          } else if (clip.layoutMode === 'split') {
            ctx.save();
            ctx.filter = 'blur(12px)';
            ctx.drawImage(v, 0, 0, sw, sh, 0, 0, W, H);
            ctx.restore();
            const midH = Math.round(H * 0.5);
            const midY = Math.round((H - midH) / 2);
            ctx.drawImage(v, fx, fy, fw, fh, 0, midY, W / 2, midH);
            ctx.drawImage(v, sw * 0.25, 0, sw * 0.5, sh, W / 2, midY, W / 2, midH);
          } else {
            const cropW = Math.min(sw, sh * (9 / 16));
            const cx = clip.facecamBox ? Math.min(sw - cropW, Math.max(0, (box.x + box.w / 2) * sw - cropW / 2)) : (sw - cropW) / 2;
            ctx.drawImage(v, cx, 0, cropW, sh, 0, 0, W, H);
          }
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [clip]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (videoRef.current?.paused) void videoRef.current.play();
        else videoRef.current?.pause();
      } else if (e.key.toLowerCase() === 'j' && videoRef.current) {
        videoRef.current.currentTime = Math.max(0, videoRef.current.currentTime - 2);
      } else if (e.key.toLowerCase() === 'l' && videoRef.current) {
        videoRef.current.currentTime += 2;
      } else if (e.key.toLowerCase() === 'e' && clip) {
        void window.clipper?.clips.render(clip.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clip]);

  if (!clip) return <div className="p-8 text-sm text-foreground/60">Loading clip in Editor...</div>;

  const activeCaptionTpl = captionTpls.find((t) => t.id === clip.captionTemplateId) ?? captionTpls[0];
  const relTime = Math.max(0, currentTime - clip.startSec);
  const activeWordIdx = clip.words.findIndex((w) => relTime >= w.start && relTime <= w.end);
  const phraseStart = activeWordIdx >= 0 ? Math.floor(activeWordIdx / 3) * 3 : 0;
  const visibleWords = clip.words.slice(phraseStart, phraseStart + 3);

  const persist = async (patch: Partial<ClipRecord>) => {
    const next = { ...clip, ...patch };
    setClip(next);
    await window.clipper?.clips.update(next);
  };

  const runFacecamDetect = async () => {
    if (!videoRef.current) return;
    toast('Scanning frames with local MediaPipe...');
    const box = await detectFacecamInVideo(videoRef.current);
    if (box) {
      await persist({ facecamBox: box, suggestedLayout: 'stacked', layoutMode: 'stacked' });
      toast('Facecam detected! Suggested Stacked layout.');
    } else {
      await persist({ facecamBox: null, suggestedLayout: 'fullscreen', layoutMode: 'fullscreen' });
      toast('No facecam found - using Fullscreen layout.');
    }
  };

  const handleManualBox = (e: React.MouseEvent<HTMLDivElement>, phase: 'down' | 'up') => {
    const rect = e.currentTarget.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;
    if (phase === 'down') {
      setDragStart({ x: nx, y: ny });
    } else if (dragStart) {
      const box: RectNormalized = {
        x: Math.max(0, Math.min(dragStart.x, nx)),
        y: Math.max(0, Math.min(dragStart.y, ny)),
        w: Math.max(0.1, Math.abs(nx - dragStart.x)),
        h: Math.max(0.1, Math.abs(ny - dragStart.y)),
      };
      setDragStart(null);
      void persist({ facecamBox: box, suggestedLayout: 'stacked' });
      toast('Manual facecam region updated');
    }
  };

  return (
    <div className="mx-auto grid max-w-7xl gap-6 lg:grid-cols-12">
      <div className="space-y-4 lg:col-span-4">
        <Card className="space-y-3 p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Layout &amp; Facecam</h2>
            <Button size="sm" variant="secondary" onClick={runFacecamDetect}>
              <ScanFace className="h-3.5 w-3.5" /> Auto-Detect
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {(['fullscreen', 'stacked', 'pip', 'split'] as LayoutMode[]).map((mode) => (
              <button
                key={mode}
                onClick={() =>
                  persist({
                    layoutMode: mode,
                    layoutTemplateId: layoutTpls.find((l) => l.mode === mode)?.id ?? clip.layoutTemplateId,
                  })
                }
                className={`rounded-lg border px-3 py-2 text-xs font-medium capitalize transition ${
                  clip.layoutMode === mode ? 'border-violet-500 bg-violet-500/15 text-violet-300' : 'border-border hover:bg-muted'
                }`}
              >
                {mode} {clip.suggestedLayout === mode && '*'}
              </button>
            ))}
          </div>

          <p className="text-[11px] text-foreground/50">Drag on the source frame to manually select facecam:</p>
          <div
            className="relative aspect-video cursor-crosshair overflow-hidden rounded-lg border border-border bg-black"
            onMouseDown={(e) => handleManualBox(e, 'down')}
            onMouseUp={(e) => handleManualBox(e, 'up')}
          >
            <video
              ref={videoRef}
              src={mediaUrl(clip.sourcePath)}
              className="h-full w-full object-contain"
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
            />
            {clip.facecamBox && (
              <div
                className="pointer-events-none absolute border-2 border-emerald-400 bg-emerald-400/15"
                style={{
                  left: `${clip.facecamBox.x * 100}%`,
                  top: `${clip.facecamBox.y * 100}%`,
                  width: `${clip.facecamBox.w * 100}%`,
                  height: `${clip.facecamBox.h * 100}%`,
                }}
              />
            )}
          </div>
        </Card>

        <Card className="space-y-3 p-4">
          <h2 className="text-sm font-semibold">Caption Template &amp; Font</h2>
          <div className="grid grid-cols-2 gap-2">
            {captionTpls.map((t) => (
              <button
                key={t.id}
                onClick={() => persist({ captionTemplateId: t.id, fontFamily: t.fontFamily })}
                className={`rounded-lg border px-2.5 py-2 text-left text-xs ${
                  clip.captionTemplateId === t.id ? 'border-violet-500 bg-violet-500/15' : 'border-border hover:bg-muted'
                }`}
              >
                <div className="font-semibold">{t.name}</div>
                <div className="text-[10px] text-foreground/50">{t.animation}</div>
              </button>
            ))}
          </div>

          <div className="flex gap-2">
            <select
              value={clip.fontFamily}
              onChange={(e) => persist({ fontFamily: e.target.value })}
              className="h-9 flex-1 rounded-lg border border-border bg-background px-2 text-xs"
            >
              {[...BUNDLED_GOOGLE_FONTS, ...customFonts].map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
            <Button
              size="sm"
              variant="secondary"
              onClick={async () => {
                const uploaded = await window.clipper?.fonts.upload();
                if (uploaded) {
                  setCustomFonts((prev) => [...prev, uploaded.name]);
                  void persist({ fontFamily: uploaded.name });
                  toast(`Font "${uploaded.name}" added`);
                }
              }}
            >
              <Upload className="h-3.5 w-3.5" /> .TTF
            </Button>
          </div>
        </Card>
      </div>

      <div className="flex flex-col items-center gap-4 lg:col-span-4">
        <div className="relative aspect-[9/16] w-full max-w-[330px] overflow-hidden rounded-2xl border border-border bg-black shadow-2xl">
          <canvas ref={canvasRef} width={360} height={640} className="h-full w-full object-cover" />

          {clip.titlePosition !== 'hidden' && (
            <div
              className={`absolute inset-x-4 text-center text-sm font-extrabold text-white drop-shadow ${
                clip.titlePosition === 'top' ? 'top-5' : 'bottom-6'
              }`}
              style={{ fontFamily: clip.fontFamily }}
            >
              <span className="rounded-md bg-black/70 px-3 py-1">{clip.title}</span>
            </div>
          )}

          <div
            className="absolute inset-x-4 bottom-20 text-center text-xl font-extrabold leading-tight drop-shadow"
            style={{ fontFamily: clip.fontFamily }}
          >
            {visibleWords.map((w, idx) => {
              const isActive = phraseStart + idx === activeWordIdx;
              return (
                <span
                  key={idx}
                  className="mx-1 inline-block transition-transform"
                  style={{
                    color: isActive ? activeCaptionTpl?.highlightColor ?? '#FACC15' : activeCaptionTpl?.primaryColor ?? '#FFF',
                    transform: isActive ? 'scale(1.12)' : 'scale(1)',
                  }}
                >
                  {activeCaptionTpl?.uppercase ? w.word.toUpperCase() : w.word}
                </span>
              );
            })}
          </div>
        </div>

        <div className="flex w-full max-w-[330px] items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => (videoRef.current?.paused ? void videoRef.current.play() : videoRef.current?.pause())}
          >
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </Button>
          <Button
            className="flex-1"
            disabled={renderPct !== null}
            onClick={() => window.clipper?.clips.render(clip.id)}
          >
            <Download className="h-4 w-4" />
            {renderPct !== null ? `Rendering ${renderPct}%` : 'Export 1080x1920'}
          </Button>
          {clip.renderedPath && (
            <Button
              variant="secondary"
              onClick={() => window.clipper?.clips.revealInFolder(clip.renderedPath!)}
              title="Open exported MP4 folder"
            >
              <FolderOpen className="h-4 w-4" />
            </Button>
          )}
        </div>
        <p className="text-[11px] text-foreground/50">Shortcuts: Space (Play) | J/L (-/+2s) | E (Export)</p>
      </div>

      <div className="space-y-4 lg:col-span-4">
        <Card className="space-y-3 p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Sparkles className="h-4 w-4 text-violet-400" /> Title &amp; Trim
          </h2>
          <Input value={clip.title} onChange={(e) => persist({ title: e.target.value })} />
          <div className="flex items-center justify-between gap-2 text-xs">
            <select
              value={clip.titlePosition}
              onChange={(e) => persist({ titlePosition: e.target.value as ClipRecord['titlePosition'] })}
              className="h-8 rounded border border-border bg-background px-2"
            >
              <option value="top">Title: Top</option>
              <option value="bottom">Title: Bottom</option>
              <option value="hidden">Title: Hidden</option>
            </select>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={clip.profanityMask}
                onChange={(e) => persist({ profanityMask: e.target.checked })}
              />
              Profanity Mask
            </label>
          </div>

          <div className="space-y-1.5 pt-2 text-xs">
            <div className="flex justify-between">
              <span>Start: {formatSeconds(clip.startSec)}</span>
              <span>End: {formatSeconds(clip.endSec)} ({Math.round(clip.endSec - clip.startSec)}s)</span>
            </div>
            <input
              type="range"
              min={0}
              max={Math.max(clip.endSec - 5, 1)}
              step={0.5}
              value={clip.startSec}
              onChange={(e) => persist({ startSec: Number(e.target.value), durationSec: clip.endSec - Number(e.target.value) })}
              className="w-full accent-violet-500"
            />
            <input
              type="range"
              min={clip.startSec + 5}
              max={clip.startSec + 60}
              step={0.5}
              value={clip.endSec}
              onChange={(e) => persist({ endSec: Number(e.target.value), durationSec: Number(e.target.value) - clip.startSec })}
              className="w-full accent-violet-500"
            />
          </div>
        </Card>

        <Card className="space-y-3 p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Word-Level Captions</h2>
            <Badge>{clip.words.length} words</Badge>
          </div>
          <div className="flex max-h-80 flex-wrap gap-1.5 overflow-y-auto">
            {clip.words.map((w, idx) => (
              <input
                key={idx}
                value={w.word}
                onChange={(e) => {
                  const nextWords = [...clip.words];
                  nextWords[idx] = { ...w, word: e.target.value };
                  void persist({ words: nextWords });
                }}
                onClick={() => {
                  if (videoRef.current) videoRef.current.currentTime = clip.startSec + w.start;
                }}
                className="w-20 rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:border-violet-500"
              />
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

export default function EditorPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm">Loading Editor...</div>}>
      <EditorInner />
    </Suspense>
  );
}
