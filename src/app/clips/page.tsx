"use client";
import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Download, Film, Scissors } from 'lucide-react';
import type { ClipRecord } from '../../../electron/types';
import { Badge, Button, Card, Input, Skeleton, useToast } from '@/components/ui';
import { formatSeconds, mediaUrl } from '@/lib/clipper-client';

export default function ClipsPage() {
  const [clips, setClips] = useState<ClipRecord[] | null>(null);
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<'score' | 'recent'>('score');
  const [exportingId, setExportingId] = useState<string | null>(null);
  const toast = useToast();

  const load = () => window.clipper?.clips.list().then(setClips);

  useEffect(() => {
    void load();
    return window.clipper?.onEvent((ev) => {
      if (ev.type === 'clip:detected') void load();
    });
  }, []);

  const filtered = useMemo(() => {
    if (!clips) return [];
    return clips
      .filter((c) => c.title.toLowerCase().includes(query.toLowerCase()))
      .sort((a, b) => (sortBy === 'score' ? b.viralityScore - a.viralityScore : b.createdAt - a.createdAt));
  }, [clips, query, sortBy]);

  const quickExport = async (clipId: string) => {
    if (!window.clipper) return;
    setExportingId(clipId);
    try {
      const outs = await window.clipper.clips.render(clipId, 'vertical');
      toast('Exported 9:16 face-tracked clip!');
      if (outs[0]) await window.clipper.clips.revealInFolder(outs[0]);
    } catch (err) {
      toast(`Export failed: ${err instanceof Error ? err.message : 'Error'}`);
    } finally {
      setExportingId(null);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-bold">Clip Library</h1>
          <p className="text-sm text-foreground/60">Full-bleed 9:16 face-tracked highlights ready to edit or export.</p>
        </div>
        <div className="flex gap-2">
          <Input placeholder="Search titles..." value={query} onChange={(e) => setQuery(e.target.value)} className="w-56" />
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as 'score' | 'recent')}
            className="h-9 rounded-lg border border-border bg-card px-3 text-sm"
          >
            <option value="score">Highest Score</option>
            <option value="recent">Newest First</option>
          </select>
        </div>
      </div>

      {clips === null ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
        </div>
      ) : filtered.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 p-12 text-center">
          <Film className="h-8 w-8 text-violet-400" />
          <h3 className="font-semibold">No clips found</h3>
          <p className="text-xs text-foreground/60">Paste a link or upload a video on the Dashboard to generate clips.</p>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {filtered.map((c) => {
            const cx = c.faceTrack?.[0]?.cx ?? (c.facecamBox ? c.facecamBox.x + c.facecamBox.w / 2 : 0.5);
            return (
              <Card key={c.id} className="flex flex-col overflow-hidden">
                <div className="relative aspect-[9/16] overflow-hidden bg-zinc-950">
                  {c.thumbnailPath && (
                    <img
                      src={mediaUrl(c.thumbnailPath)}
                      alt={c.title}
                      className="h-full w-full object-cover"
                      style={{ objectPosition: `${Math.round(cx * 100)}% 50%` }}
                    />
                  )}
                  <div className="absolute left-2.5 top-2.5 z-20">
                    <Badge tone="amber">{Math.round(c.viralityScore * 100)}</Badge>
                  </div>
                  <span className="absolute right-2.5 top-2.5 z-20 rounded bg-black/75 px-2 py-0.5 text-[11px] font-medium text-white">
                    {formatSeconds(c.durationSec)}
                  </span>
                  <div className="absolute inset-x-3 top-12 z-20 text-center">
                    <span className="inline-block rounded-md bg-white px-2.5 py-1 text-[11px] font-extrabold uppercase text-zinc-950 shadow">
                      {c.title}
                    </span>
                  </div>
                  {c.words.length > 0 && (
                    <div className="absolute inset-x-3 bottom-8 z-20 text-center text-xs font-extrabold uppercase text-yellow-300 drop-shadow">
                      {c.words.slice(0, 3).map((w) => w.word).join(' ')}
                    </div>
                  )}
                </div>

                <div className="flex flex-1 flex-col justify-between gap-3 p-3.5">
                  <div>
                    <h3 className="line-clamp-1 text-sm font-semibold">{c.title}</h3>
                    <p className="line-clamp-2 text-[11px] text-foreground/60">{c.reason}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Link href={`/editor?id=${c.id}`} className="flex-1">
                      <Button size="sm" variant="secondary" className="w-full">
                        <Scissors className="h-3.5 w-3.5" /> Edit
                      </Button>
                    </Link>
                    <Button
                      size="sm"
                      disabled={exportingId === c.id}
                      onClick={() => quickExport(c.id)}
                      title="Quick Export 9:16 MP4"
                    >
                      <Download className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
