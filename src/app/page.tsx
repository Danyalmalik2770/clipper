"use client";
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { Activity, AlertTriangle, Plus, Radio, Square, Trash2 } from 'lucide-react';
import type { DownloadState, StreamRecord } from '../../electron/types';
import { Badge, Button, Card, Input, Skeleton, useToast } from '@/components/ui';
import { formatSeconds } from '@/lib/clipper-client';

interface LiveTelemetry {
  downloadState?: DownloadState;
  retryInSec?: number;
  activeClient?: string;
  downloadSpeedKbps?: number;
  error?: string;
}

function renderStatusBadge(status: StreamRecord['status'], live?: LiveTelemetry) {
  if (status !== 'ingesting') {
    return <Badge tone={status === 'error' ? 'rose' : 'default'}>{status}</Badge>;
  }
  const ds = live?.downloadState ?? 'downloading';
  if (ds === 'blocked-waiting') {
    return (
      <Badge tone="rose">
        blocked-waiting ({live?.retryInSec ?? 0}s • {live?.activeClient ?? 'web'})
      </Badge>
    );
  }
  if (ds === 'throttled-retrying') {
    return (
      <Badge tone="amber">
        throttled-retrying ({live?.retryInSec ?? 0}s • {live?.activeClient ?? 'web'})
      </Badge>
    );
  }
  return (
    <Badge tone="green">
      downloading {live?.downloadSpeedKbps ? `${live.downloadSpeedKbps} KB/s` : ''} ({live?.activeClient ?? 'web'})
    </Badge>
  );
}

export default function DashboardPage() {
  const [url, setUrl] = useState('');
  const [streams, setStreams] = useState<StreamRecord[] | null>(null);
  const [telemetry, setTelemetry] = useState<Record<string, LiveTelemetry>>({});
  const [starting, setStarting] = useState(false);
  const toast = useToast();

  const load = async () => {
    if (!window.clipper) return;
    setStreams(await window.clipper.streams.list());
  };

  useEffect(() => {
    void load();
    const off = window.clipper?.onEvent((ev) => {
      if (ev.type === 'stream:status') {
        setTelemetry((prev) => ({
          ...prev,
          [ev.streamId]: {
            downloadState: ev.downloadState,
            retryInSec: ev.retryInSec,
            activeClient: ev.activeClient,
            downloadSpeedKbps: ev.downloadSpeedKbps,
            error: ev.error,
          },
        }));
        if (ev.downloadState === 'downloading' || ev.status === 'stopped') {
          void load();
        }
      } else if (ev.type === 'clip:detected') {
        void load();
      }
    });
    return () => off?.();
  }, []);

  const handleStart = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() || !window.clipper) return;
    setStarting(true);
    try {
      await window.clipper.streams.start(url.trim());
      setUrl('');
      toast('Stream monitor started locally!');
      await load();
    } catch (err) {
      toast(`Error: ${err instanceof Error ? err.message : 'Failed to start stream'}`);
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-sm text-foreground/60">
          Monitor any YouTube Live stream or VOD - 100% locally on your PC.
        </p>
      </div>

      <Card className="p-4">
        <form onSubmit={handleStart} className="flex flex-col gap-3 sm:flex-row">
          <Input
            placeholder="Paste YouTube Live, Channel, or VOD URL..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <Button type="submit" disabled={starting || !url.trim()} className="shrink-0">
            <Plus className="h-4 w-4" />
            {starting ? 'Connecting...' : 'Start Monitor'}
          </Button>
        </form>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {streams === null ? (
          <>
            <Skeleton className="h-36" />
            <Skeleton className="h-36" />
          </>
        ) : streams.length === 0 ? (
          <Card className="col-span-full flex flex-col items-center justify-center gap-2 p-12 text-center">
            <Radio className="h-8 w-8 text-violet-400" />
            <h3 className="font-semibold">No streams monitored yet</h3>
            <p className="max-w-md text-xs text-foreground/60">
              Paste a YouTube stream or VOD URL above to begin local recording, Whisper transcription, and viral clip detection.
            </p>
          </Card>
        ) : (
          streams.map((s) => {
            const live = telemetry[s.id];
            const errText = live?.error ?? s.errorMessage;
            return (
              <motion.div key={s.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
                <Card className="flex flex-col justify-between gap-4 p-4">
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      {renderStatusBadge(s.status, live)}
                      <span className="text-xs text-foreground/50">{s.clipsCount} clips</span>
                    </div>
                    <h3 className="line-clamp-1 font-semibold">{s.title}</h3>
                    <p className="text-xs text-foreground/60">
                      {s.channel} • Buffer: {formatSeconds(s.bufferSeconds)}
                    </p>
                    {errText && s.status === 'ingesting' && (
                      <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-300">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span className="line-clamp-2">{errText}</span>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <Link href={`/monitor?id=${s.id}`}>
                      <Button variant="secondary" size="sm">
                        <Activity className="h-3.5 w-3.5" /> Live Monitor
                      </Button>
                    </Link>
                    <div className="flex gap-1.5">
                      {s.status === 'ingesting' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => window.clipper?.streams.stop(s.id)}
                          title="Stop monitor"
                        >
                          <Square className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={async () => {
                          await window.clipper?.streams.remove(s.id);
                          void load();
                        }}
                        title="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5 text-rose-400" />
                      </Button>
                    </div>
                  </div>
                </Card>
              </motion.div>
            );
          })
        )}
      </div>
    </div>
  );
}
