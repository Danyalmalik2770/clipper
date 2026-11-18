"use client";
import React, { useEffect, useState } from 'react';
import { Download, Plus, Upload } from 'lucide-react';
import type { CaptionTemplate, LayoutMode, LayoutTemplate } from '../../../electron/types';
import { Badge, Button, Card, Input, useToast } from '@/components/ui';
import { FONT_CATALOG, registerLocalFontFaces } from '@/lib/fonts';

export default function TemplatesPage() {
  const [captions, setCaptions] = useState<CaptionTemplate[]>([]);
  const [layouts, setLayouts] = useState<LayoutTemplate[]>([]);
  const [newName, setNewName] = useState('');
  const [newFont, setNewFont] = useState('Alexandria');
  const [newColor, setNewColor] = useState('#22D3EE');
  const [layoutName, setLayoutName] = useState('');
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('stacked');
  const [topRatio, setTopRatio] = useState(0.38);
  const toast = useToast();

  const load = async () => {
    if (!window.clipper) return;
    const [ct, lt, local] = await Promise.all([
      window.clipper.templates.listCaptions(),
      window.clipper.templates.listLayouts(),
      window.clipper.fonts.list(),
    ]);
    await registerLocalFontFaces(local);
    setCaptions(ct);
    setLayouts(lt);
  };

  useEffect(() => {
    void load();
  }, []);

  const createCaption = async () => {
    if (!newName.trim() || !window.clipper) return;
    const tpl: CaptionTemplate = {
      id: newName.toLowerCase().replace(/\s+/g, '-'),
      name: newName.trim(),
      description: 'Custom user template',
      fontFamily: newFont,
      fontSize: 76,
      primaryColor: '#FFFFFF',
      highlightColor: newColor,
      strokeColor: '#000000',
      strokeWidth: 6,
      shadowColor: '#000000',
      shadowDepth: 3,
      animation: 'pop',
      uppercase: true,
      wordsPerLine: 3,
    };
    await window.clipper.templates.saveCaption(tpl);
    setNewName('');
    toast('Saved custom caption template');
    void load();
  };

  const createLayout = async () => {
    if (!layoutName.trim() || !window.clipper) return;
    const tpl: LayoutTemplate = {
      id: layoutName.toLowerCase().replace(/\s+/g, '-'),
      name: layoutName.trim(),
      mode: layoutMode,
      topRatio: layoutMode === 'stacked' ? topRatio : undefined,
      pipPosition: layoutMode === 'pip' ? 'bottom-right' : undefined,
      pipScale: layoutMode === 'pip' ? 0.3 : undefined,
      smartCrop: layoutMode === 'fullscreen' ? true : undefined,
      blurBackground: layoutMode === 'split' ? true : undefined,
    };
    await window.clipper.templates.saveLayout(tpl);
    setLayoutName('');
    toast('Saved custom layout template');
    void load();
  };

  const exportJson = (data: unknown, filename: string) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Templates</h1>
          <p className="text-sm text-foreground/60">JSON-powered caption and layout presets ready for community PRs.</p>
        </div>
        <label className="cursor-pointer">
          <input
            type="file"
            accept=".json"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file || !window.clipper) return;
              const parsed = JSON.parse(await file.text());
              if ('wordsPerLine' in parsed) await window.clipper.templates.saveCaption(parsed);
              else await window.clipper.templates.saveLayout(parsed);
              toast('Imported JSON template!');
              void load();
            }}
          />
          <span className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-card px-4 text-sm font-medium hover:bg-muted">
            <Upload className="h-4 w-4" /> Import JSON
          </span>
        </label>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="flex flex-wrap items-center gap-2.5 p-4">
          <Input placeholder="Caption preset name..." value={newName} onChange={(e) => setNewName(e.target.value)} className="flex-1 min-w-[130px]" />
          <select
            value={newFont}
            onChange={(e) => setNewFont(e.target.value)}
            className="h-9 max-w-[160px] rounded-lg border border-border bg-background px-2 text-xs"
          >
            {FONT_CATALOG.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.fonts.map((f) => <option key={f} value={f}>{f}</option>)}
              </optgroup>
            ))}
          </select>
          <input type="color" value={newColor} onChange={(e) => setNewColor(e.target.value)} className="h-9 w-10 cursor-pointer rounded border border-border bg-transparent" />
          <Button onClick={createCaption}><Plus className="h-4 w-4" /> Caption</Button>
        </Card>

        <Card className="flex flex-wrap items-center gap-3 p-4">
          <Input placeholder="New layout preset name..." value={layoutName} onChange={(e) => setLayoutName(e.target.value)} className="flex-1 min-w-[140px]" />
          <select
            value={layoutMode}
            onChange={(e) => setLayoutMode(e.target.value as LayoutMode)}
            className="h-9 rounded-lg border border-border bg-background px-2.5 text-xs"
          >
            <option value="stacked">Stacked</option>
            <option value="pip">PIP</option>
            <option value="split">Split</option>
            <option value="fullscreen">Fullscreen</option>
          </select>
          {layoutMode === 'stacked' && (
            <Input
              type="number"
              step={0.02}
              min={0.25}
              max={0.55}
              value={topRatio}
              onChange={(e) => setTopRatio(Number(e.target.value))}
              className="w-20"
            />
          )}
          <Button onClick={createLayout}><Plus className="h-4 w-4" /> Layout</Button>
        </Card>
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-foreground/60">Caption Presets ({captions.length})</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {captions.map((c) => (
            <Card key={c.id} className="flex flex-col justify-between gap-3 p-4">
              <div
                className="flex h-20 items-center justify-center rounded-lg bg-zinc-950 text-lg font-extrabold"
                style={{ fontFamily: `"${c.fontFamily}", sans-serif` }}
              >
                <span style={{ color: c.primaryColor }}>THIS IS </span>
                <span className="ml-1.5" style={{ color: c.highlightColor }}>VIRAL</span>
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold">{c.name}</div>
                  <div className="text-[11px] text-foreground/50">{c.fontFamily} • {c.animation}</div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => exportJson(c, `${c.id}.json`)}>
                  <Download className="h-3.5 w-3.5" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-foreground/60">Layout Presets ({layouts.length})</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {layouts.map((l) => (
            <Card key={l.id} className="flex items-center justify-between p-4">
              <div>
                <div className="text-sm font-semibold">{l.name}</div>
                <Badge tone="violet">{l.mode}</Badge>
              </div>
              <Button size="sm" variant="ghost" onClick={() => exportJson(l, `${l.id}.json`)}>
                <Download className="h-3.5 w-3.5" />
              </Button>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
