"use client";
import React, { useEffect, useState } from 'react';
import { CheckCircle2, Cookie, FolderOpen, Save, Sparkles, X } from 'lucide-react';
import type { AppSettings, LLMProvider } from '../../../electron/types';
import { Badge, Button, Card, Input, useToast } from '@/components/ui';

export default function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const toast = useToast();

  useEffect(() => {
    window.clipper?.settings.get().then(setSettings);
  }, []);

  if (!settings) return <div className="p-6 text-sm">Loading local settings...</div>;

  const save = async () => {
    await window.clipper?.settings.save(settings);
    toast('Settings saved locally to clipper.db');
  };

  const saveAndTest = async () => {
    setTesting(true);
    try {
      await window.clipper?.settings.save(settings);
      const res = await window.clipper?.settings.testLlm(settings);
      if (res) {
        setTestResult(res);
        toast(res.message);
      }
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Settings</h1>
          <p className="text-sm text-foreground/60">Free local defaults + optional Free Gemini API key on your PC.</p>
        </div>
        <Button onClick={save}><Save className="h-4 w-4" /> Save Changes</Button>
      </div>

      <Card className="space-y-4 p-5">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Sparkles className="h-4 w-4 text-violet-400" /> AI Viral Moment Picker
          </h2>
          {testResult && <Badge tone={testResult.ok ? 'green' : 'rose'}>{testResult.ok ? 'Ready' : 'Failed'}</Badge>}
        </div>
        <p className="text-xs text-foreground/60">
          Get a free Gemini key at <code className="text-violet-400">aistudio.google.com/apikey</code>. Without a key, clips are picked by loudness, motion &amp; local hooks.
        </p>
        <select
          value={settings.llmProvider}
          onChange={(e) => setSettings({ ...settings, llmProvider: e.target.value as LLMProvider })}
          className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm"
        >
          <option value="none">Built-in Local Heuristic (100% Free, Zero Key)</option>
          <option value="gemini">Google Gemini (Free API Key Tier)</option>
          <option value="ollama">Local Ollama (100% Free)</option>
          <option value="openai">OpenAI (Optional API Key)</option>
          <option value="anthropic">Anthropic (Optional API Key)</option>
        </select>

        {settings.llmProvider === 'gemini' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              type="password"
              placeholder="Paste Gemini API Key..."
              value={settings.geminiApiKey ?? ''}
              onChange={(e) => setSettings({ ...settings, geminiApiKey: e.target.value })}
            />
            <Input
              placeholder="Model (e.g. gemini-2.5-flash)"
              value={settings.geminiModel ?? 'gemini-2.5-flash'}
              onChange={(e) => setSettings({ ...settings, geminiModel: e.target.value })}
            />
          </div>
        )}
        {settings.llmProvider === 'ollama' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Input placeholder="Ollama URL" value={settings.ollamaUrl} onChange={(e) => setSettings({ ...settings, ollamaUrl: e.target.value })} />
            <Input placeholder="Ollama Model (e.g. llama3.2)" value={settings.ollamaModel} onChange={(e) => setSettings({ ...settings, ollamaModel: e.target.value })} />
          </div>
        )}
        {settings.llmProvider === 'openai' && (
          <Input type="password" placeholder="OpenAI API Key" value={settings.openaiApiKey} onChange={(e) => setSettings({ ...settings, openaiApiKey: e.target.value })} />
        )}
        {settings.llmProvider === 'anthropic' && (
          <Input type="password" placeholder="Anthropic API Key" value={settings.anthropicApiKey} onChange={(e) => setSettings({ ...settings, anthropicApiKey: e.target.value })} />
        )}

        <div className="flex items-center gap-3">
          <Button variant="secondary" disabled={testing} onClick={saveAndTest}>
            <CheckCircle2 className="h-4 w-4" /> {testing ? 'Testing...' : 'Save & Test AI'}
          </Button>
          {testResult && <span className="text-xs text-foreground/70">{testResult.message}</span>}
        </div>
      </Card>

      <Card className="space-y-4 p-5">
        <h2 className="text-sm font-semibold">Local Storage &amp; Whisper</h2>
        <div className="flex gap-2">
          <Input value={settings.storagePath} onChange={(e) => setSettings({ ...settings, storagePath: e.target.value })} />
          <Button
            variant="secondary"
            onClick={async () => {
              const dir = await window.clipper?.settings.pickFolder();
              if (dir) setSettings({ ...settings, storagePath: dir });
            }}
          >
            <FolderOpen className="h-4 w-4" /> Browse
          </Button>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs text-foreground/60">Rolling Buffer (Hours)</label>
            <Input type="number" step={0.5} value={settings.bufferHours} onChange={(e) => setSettings({ ...settings, bufferHours: Number(e.target.value) })} />
          </div>
          <div>
            <label className="mb-1 block text-xs text-foreground/60">Offline Whisper Model</label>
            <select
              value={settings.whisperModel}
              onChange={(e) => setSettings({ ...settings, whisperModel: e.target.value })}
              className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm"
            >
              <option value="onnx-community/whisper-tiny_timestamped">Tiny (Fastest, Free)</option>
              <option value="onnx-community/whisper-base_timestamped">Base (Balanced, Free)</option>
              <option value="onnx-community/whisper-small_timestamped">Small (Highest Accuracy, Free)</option>
            </select>
          </div>
        </div>
      </Card>

      <Card className="space-y-4 p-5">
        <h2 className="text-sm font-semibold">YouTube Download Resilience &amp; Anti-Throttle</h2>
        <label className="flex items-center gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={Boolean(settings.forceIpv4)}
            onChange={(e) => setSettings({ ...settings, forceIpv4: e.target.checked })}
          />
          <span>Force IPv4 for downloads (<code className="text-xs text-violet-400">--force-ipv4</code>)</span>
        </label>
        <div className="space-y-1.5">
          <label className="block text-xs text-foreground/60">Optional YouTube cookies.txt</label>
          <div className="flex gap-2">
            <Input
              placeholder="No cookies.txt selected"
              value={settings.cookiesPath ?? ''}
              onChange={(e) => setSettings({ ...settings, cookiesPath: e.target.value })}
            />
            <Button
              variant="secondary"
              onClick={async () => {
                const file = await window.clipper?.settings.pickCookies();
                if (file) setSettings({ ...settings, cookiesPath: file });
              }}
            >
              <Cookie className="h-4 w-4" /> Browse
            </Button>
            {settings.cookiesPath && (
              <Button variant="ghost" onClick={() => setSettings({ ...settings, cookiesPath: '' })} title="Clear cookies">
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </Card>

      <Card className="space-y-4 p-5">
        <h2 className="text-sm font-semibold">Viral Detection &amp; Output Quality</h2>
        <div>
          <label className="mb-1 flex justify-between text-xs">
            <span>Virality Sensitivity Threshold</span>
            <span>{Math.round(settings.viralityThreshold * 100)}%</span>
          </label>
          <input
            type="range"
            min={0.3}
            max={0.9}
            step={0.02}
            value={settings.viralityThreshold}
            onChange={(e) => setSettings({ ...settings, viralityThreshold: Number(e.target.value) })}
            className="w-full accent-violet-500"
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-4">
          <div>
            <label className="mb-1 block text-xs text-foreground/60">Min Clip (sec)</label>
            <Input type="number" value={settings.minClipSeconds} onChange={(e) => setSettings({ ...settings, minClipSeconds: Number(e.target.value) })} />
          </div>
          <div>
            <label className="mb-1 block text-xs text-foreground/60">Max Clip (sec)</label>
            <Input type="number" value={settings.maxClipSeconds} onChange={(e) => setSettings({ ...settings, maxClipSeconds: Number(e.target.value) })} />
          </div>
          <div>
            <label className="mb-1 block text-xs text-foreground/60">Export FPS</label>
            <select
              value={settings.outputFps}
              onChange={(e) => setSettings({ ...settings, outputFps: Number(e.target.value) as 30 | 60 })}
              className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm"
            >
              <option value={30}>30 FPS</option>
              <option value={60}>60 FPS</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-foreground/60">CRF Quality</label>
            <Input type="number" min={14} max={28} value={settings.outputCrf} onChange={(e) => setSettings({ ...settings, outputCrf: Number(e.target.value) })} />
          </div>
        </div>
      </Card>
    </div>
  );
}
