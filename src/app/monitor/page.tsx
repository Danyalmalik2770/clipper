"use client";
import React, { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { motion } from 'framer-motion';
import { Flame, Scissors } from 'lucide-react';
import type { ClipRecord, SignalSample } from '../../../electron/types';
import { Badge, Button, Card } from '@/components/ui';
import { formatSeconds, mediaUrl } from '@/lib/clipper-client';

function MonitorInner() {
  const params = useSearchParams();
  const streamId = params.get('id') ?? '';
  const [signals, setSignals] = useState<SignalSample[]>([]);
  const [clips, setClips] = useState<ClipRecord[]>([]);
  const [previewClip, setPreviewClip] = useState<ClipRecord | null>(null);

  useEffect(() => {
    if (!streamId || !window.clipper) return;
    window.clipper.clips.list(streamId).then((loaded) => {
      setClips(loaded);
      if (loaded.length > 0) setPreviewClip(loaded[0]);
    });

    return window.clipper.onEvent((ev) => {
      if (ev.type === 'monitor:signal' && ev.streamId === streamId) {
        setSignals((prev) => [...prev.slice(-89), ev.sample]);
      }
      if (ev.type === 'clip:detected' && ev.streamId === streamId) {
        setClips((prev) => [ev.clip, ...prev]);
        setPreviewClip(ev.clip);
      }
    });
  }, [streamId]);

  const points = signals
    .map((s, idx) => `${(idx / Math.max(1, signals.length - 1)) * 600},${140 - s.combinedScore * 125}`)
    .join(' ');

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Live Monitor</h1>
          <p className="text-xs text-foreground/60">Stream ID: {streamId || 'None'}</p>
        </div>
        <Link href="/clips">
          <Button variant="secondary" size="sm">View All Clips</Button>
        </Link>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="space-y-4 p-4 lg:col-span-2">
          <div className="aspect-video overflow-hidden rounded-lg border border-border bg-black">
            {previewClip ? (
              <video
                key={previewClip.id}
                src={mediaUrl(previewClip.sourcePath)}
                controls
                muted
                className="h-full w-full object-contain"
              />
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-white/50">
                Segment video preview appears once the first 30s chunk finalizes...
              </div>
            )}
          </div>

          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Real-Time Virality Score Graph</h2>
            <Badge tone="violet">Audio + Chat + Motion + Hook</Badge>
          </div>
          <svg viewBox="0 0 600 150" className="h-40 w-full rounded-lg bg-muted/40 p-2">
            <line x1="0" y1="60" x2="600" y2="60" stroke="#7c3aed" strokeDasharray="4 4" strokeOpacity="0.4" />
            {points && <polyline fill="none" stroke="#8b5cf6" strokeWidth="2.5" points={points} />}
          </svg>

          <div>
            <h3 className="mb-2 text-xs font-semibold text-foreground/70">Chat Activity Heatmap</h3>
            <div className="flex h-12 items-end gap-1 rounded-lg bg-muted/40 p-2">
              {signals.slice(-60).map((s, idx) => (
                <div
                  key={idx}
                  className="flex-1 rounded-sm bg-emerald-400 transition-all"
                  style={{ height: `${Math.max(10, Math.round(s.chatScore * 100))}%`, opacity: 0.35 + s.chatScore * 0.65 }}
                />
              ))}
            </div>
          </div>
        </Card>

        <Card className="space-y-3 p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Flame className="h-4 w-4 text-amber-400" /> Incoming Viral Clips
          </h2>
          <div className="max-h-[540px] space-y-2.5 overflow-y-auto pr-1">
            {clips.length === 0 ? (
              <p className="py-10 text-center text-xs text-foreground/50">
                Waiting for first 30s segment analysis...
              </p>
            ) : (
              clips.map((c) => (
                <motion.div
                  key={c.id}
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  onClick={() => setPreviewClip(c)}
                  className="flex cursor-pointer gap-3 rounded-lg border border-border bg-background/60 p-2.5 hover:border-violet-500/60"
                >
                  {c.thumbnailPath && (
                    <img src={mediaUrl(c.thumbnailPath)} alt={c.title} className="h-14 w-20 rounded object-cover" />
                  )}
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <Badge tone="amber">{Math.round(c.viralityScore * 100)}%</Badge>
                      <span className="text-[11px] text-foreground/50">{formatSeconds(c.durationSec)}</span>
                    </div>
                    <p className="truncate text-xs font-semibold">{c.title}</p>
                    <Link href={`/editor?id=${c.id}`} className="inline-flex items-center gap-1 text-[11px] text-violet-400 hover:underline">
                      <Scissors className="h-3 w-3" /> Edit Clip
                    </Link>
                  </div>
                </motion.div>
              ))
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

export default function MonitorPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm">Loading monitor...</div>}>
      <MonitorInner />
    </Suspense>
  );
}
