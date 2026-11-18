"use client";
import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Film, Scissors } from 'lucide-react';
import type { ClipRecord } from '../../../electron/types';
import { Badge, Button, Card, Input, Skeleton } from '@/components/ui';
import { formatSeconds, mediaUrl } from '@/lib/clipper-client';

export default function ClipsPage() {
  const [clips, setClips] = useState<ClipRecord[] | null>(null);
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<'score' | 'recent'>('score');

  useEffect(() => {
    window.clipper?.clips.list().then(setClips);
  }, []);

  const filtered = useMemo(() => {
    if (!clips) return [];
    return clips
      .filter((c) => c.title.toLowerCase().includes(query.toLowerCase()))
      .sort((a, b) => (sortBy === 'score' ? b.viralityScore - a.viralityScore : b.createdAt - a.createdAt));
  }, [clips, query, sortBy]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-bold">Clip Library</h1>
          <p className="text-sm text-foreground/60">Review, filter, and open clips in the 9:16 Editor.</p>
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
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      ) : filtered.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 p-12 text-center">
          <Film className="h-8 w-8 text-violet-400" />
          <h3 className="font-semibold">No clips found</h3>
          <p className="text-xs text-foreground/60">Start a stream monitor on the Dashboard to auto-detect clips.</p>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((c) => (
            <Card key={c.id} className="overflow-hidden">
              <div className="relative aspect-video bg-muted">
                {c.thumbnailPath && (
                  <img src={mediaUrl(c.thumbnailPath)} alt={c.title} className="h-full w-full object-cover" />
                )}
                <div className="absolute left-2.5 top-2.5">
                  <Badge tone="amber">{Math.round(c.viralityScore * 100)} Viral</Badge>
                </div>
                <span className="absolute bottom-2 right-2 rounded bg-black/75 px-2 py-0.5 text-[11px] text-white">
                  {formatSeconds(c.durationSec)}
                </span>
              </div>
              <div className="space-y-3 p-4">
                <div>
                  <h3 className="line-clamp-1 font-semibold">{c.title}</h3>
                  <p className="line-clamp-1 text-xs text-foreground/60">{c.reason}</p>
                </div>
                <div className="flex items-center justify-between">
                  <Badge tone="violet">{c.layoutMode}</Badge>
                  <Link href={`/editor?id=${c.id}`}>
                    <Button size="sm">
                      <Scissors className="h-3.5 w-3.5" /> Open Editor
                    </Button>
                  </Link>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
