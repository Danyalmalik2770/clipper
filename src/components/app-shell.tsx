"use client";
import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Film, LayoutTemplate, Moon, Radio, Settings, Sun } from 'lucide-react';
import { clsx } from 'clsx';
import type { ClipRecord } from '../../electron/types';
import { ClipperLogo } from '@/components/brand/clipper-logo';
import { mediaUrl } from '@/lib/clipper-client';
import { trackFacesInClip } from '@/lib/facecam';

const NAV = [
  { href: '/', label: 'Dashboard', icon: Radio },
  { href: '/clips', label: 'Clip Library', icon: Film },
  { href: '/templates', label: 'Templates', icon: LayoutTemplate },
  { href: '/settings', label: 'Settings', icon: Settings },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [dark, setDark] = useState(true);
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);

  useEffect(() => {
    if (!window.clipper) return;
    return window.clipper.onEvent((ev) => {
      if (ev.type === 'clip:detected') {
        const clip: ClipRecord = ev.clip;
        queueRef.current = queueRef.current.then(async () => {
          const { primaryBox, faceTrack } = await trackFacesInClip(
            mediaUrl(clip.sourcePath),
            clip.startSec,
            clip.endSec
          );
          if (faceTrack.length > 0 || primaryBox) {
            await window.clipper?.clips.update({
              ...clip,
              facecamBox: primaryBox ?? clip.facecamBox,
              faceTrack,
              layoutMode: 'fullscreen',
            });
          }
        });
      }
    });
  }, []);

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-card/50 p-4">
        <div className="mb-5 pt-4 [-webkit-app-region:drag]">
          <Link href="/" className="inline-flex flex-col gap-1 px-1 [-webkit-app-region:no-drag]">
            <ClipperLogo size="md" />
            <span className="pl-[42px] text-[10px] font-medium tracking-wide text-foreground/45">
              100% LOCAL STUDIO
            </span>
          </Link>
        </div>

        <nav className="flex flex-1 flex-col gap-1">
          {NAV.map((item) => {
            const Icon = item.icon;
            const active = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
            return (
              <Link
                key={item.href}
                href={item.href}
                className={clsx(
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition',
                  active ? 'bg-violet-600/15 text-violet-400' : 'text-foreground/70 hover:bg-muted hover:text-foreground'
                )}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <button
          onClick={() => setDark((d) => !d)}
          className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-xs text-foreground/70 hover:bg-muted"
        >
          <span>{dark ? 'Dark Theme' : 'Light Theme'}</span>
          {dark ? <Moon className="h-3.5 w-3.5" /> : <Sun className="h-3.5 w-3.5" />}
        </button>
      </aside>

      <main className="flex-1 overflow-y-auto p-6">{children}</main>
    </div>
  );
}
