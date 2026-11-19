// Clipper Web — everything runs locally in the browser.
// Moments: Web Audio energy peaks. Captions: Whisper via transformers.js.
// Export: ffmpeg.wasm (single-thread core, no server needed).

import { FFmpeg } from 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/index.js';
import { toBlobURL, fetchFile } from 'https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.2/dist/esm/index.js';

const $ = (id) => document.getElementById(id);
const drop = $('drop'), fileInput = $('file'), preview = $('preview');
const overlay = $('caption-overlay');

let file = null;
let audioBuffer = null;      // decoded audio of the whole video
let cues = [];               // caption cues {start, end, text} in clip-local seconds
let clipStart = 0;

const fmt = (s) => {
  s = Math.max(0, s);
  const m = Math.floor(s / 60), r = (s % 60).toFixed(1).padStart(4, '0');
  return `${m}:${r}`;
};

// ---------- Step 1: file ----------
drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault(); drop.classList.remove('over');
  if (e.dataTransfer.files.length) setFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => { if (fileInput.files.length) setFile(fileInput.files[0]); });

function setFile(f) {
  file = f;
  audioBuffer = null; cues = [];
  preview.src = URL.createObjectURL(f);
  preview.style.display = 'block';
  drop.querySelector('.big').textContent = f.name;
  $('step-moments').classList.remove('hidden');
  $('step-export').classList.remove('hidden');
  $('moments').innerHTML = '';
  $('downloads').innerHTML = '';
  $('tx-status').textContent = '';
  $('analyze-status').textContent = '';
}

// ---------- Step 2: moment detection (audio energy) ----------
$('btn-analyze').addEventListener('click', async () => {
  if (!file) return;
  const st = $('analyze-status');
  const btn = $('btn-analyze');
  btn.disabled = true;
  try {
    st.textContent = 'Reading the audio track...';
    if (!audioBuffer) {
      const buf = await file.arrayBuffer();
      const ctx = new OfflineAudioContext(1, 1, 44100);
      audioBuffer = await ctx.decodeAudioData(buf);
    }
    st.textContent = 'Scanning for the loudest moments...';
    const moments = findMoments(audioBuffer);
    if (!moments.length) { st.textContent = 'No clear peaks found — pick a start time manually in step 3.'; return; }
    st.textContent = `Found ${moments.length} strong moments. Click one to load it into the exporter.`;
    const box = $('moments');
    box.innerHTML = '';
    moments.forEach((mo, i) => {
      const d = document.createElement('div');
      d.className = 'moment';
      d.innerHTML = `<span class="t">Moment ${i + 1} — ${fmt(mo.start)} to ${fmt(mo.end)}</span><span class="score">${mo.score}% energy</span>`;
      d.addEventListener('click', () => {
        document.querySelectorAll('.moment').forEach((x) => x.classList.remove('sel'));
        d.classList.add('sel');
        selectRange(mo.start, mo.end - mo.start);
        preview.currentTime = mo.start;
        preview.play().catch(() => {});
      });
      box.appendChild(d);
    });
    const first = moments.slice().sort((a, b) => b.score - a.score)[0];
    selectRange(first.start, first.end - first.start);
  } catch (e) {
    st.textContent = 'Could not read this file\'s audio. Try an MP4 with an audio track.';
  } finally { btn.disabled = false; }
});

function findMoments(ab) {
  const ch = ab.getChannelData(0);
  const sr = ab.sampleRate, winSec = 0.5, win = Math.floor(winSec * sr);
  const n = Math.floor(ch.length / win);
  const e = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0; const off = i * win;
    for (let j = 0; j < win; j += 4) { const v = ch[off + j]; s += v * v; }  // sample every 4th — fast enough
    e[i] = Math.sqrt(s / (win / 4));
  }
  const mean = e.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(e.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n);
  const thr = mean + sd * 0.8;
  const peaks = [];
  for (let i = 2; i < n - 2; i++) {
    if (e[i] > thr && e[i] >= e[i - 1] && e[i] >= e[i + 1] && e[i] >= e[i - 2] && e[i] >= e[i + 2]) {
      peaks.push({ t: i * winSec, v: e[i] });
    }
  }
  peaks.sort((a, b) => b.v - a.v);
  const max = peaks.length ? peaks[0].v : 1;
  const chosen = [];
  for (const p of peaks) {
    if (chosen.some((c) => Math.abs(c.t - p.t) < 25)) continue;   // keep moments apart
    chosen.push(p);
    if (chosen.length >= 5) break;
  }
  return chosen
    .map((p) => {
      const start = Math.max(0, p.t - 5);
      const end = Math.min(ab.duration, start + 30);
      return { start, end, score: Math.round((p.v / max) * 100) };
    })
    .sort((a, b) => a.start - b.start);
}

function selectRange(start, dur) {
  clipStart = start;
  $('in-start').value = start.toFixed(1);
  $('in-dur').value = Math.round(dur);
  cues = [];
  overlay.textContent = '';
  $('tx-status').textContent = '';
}

// ---------- Step 3a: captions (Whisper in the browser) ----------
let transcriber = null;
$('btn-transcribe').addEventListener('click', async () => {
  if (!file || !audioBuffer) { $('tx-status').textContent = 'Run "Find Viral Moments" first (it loads the audio).'; return; }
  const st = $('tx-status');
  const btn = $('btn-transcribe');
  btn.disabled = true;
  try {
    const start = parseFloat($('in-start').value) || 0;
    const dur = parseFloat($('in-dur').value) || 30;
    clipStart = start;
    if (!transcriber) {
      st.textContent = 'Loading the Whisper AI model (one-time download, ~80 MB)...';
      const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js');
      env.allowLocalModels = false;
      transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-base', {
        progress_callback: (p) => {
          if (p.status === 'progress' && p.total) {
            st.textContent = `Loading Whisper model: ${Math.round((p.loaded / p.total) * 100)}%`;
          }
        },
      });
    }
    st.textContent = 'Transcribing your clip...';
    const samples = await segmentSamples(audioBuffer, start, dur);
    const out = await transcriber(samples, { return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5 });
    cues = wordsToCues(out.chunks || []);
    if (!cues.length && out.text) cues = [{ start: 0, end: dur, text: out.text.trim() }];
    st.textContent = cues.length ? `Captions ready — ${cues.length} lines. Play the preview to see them, export to keep them as an .srt file.` : 'No speech found in this range.';
  } catch (e) {
    st.textContent = 'Transcription failed (model download needs a good connection). You can still export the clip.';
  } finally { btn.disabled = false; }
});

async function segmentSamples(ab, start, dur) {
  const sr = 16000;
  const len = Math.floor(dur * sr);
  const off = new OfflineAudioContext(1, len, sr);
  const src = off.createBufferSource();
  src.buffer = ab;
  src.connect(off.destination);
  src.start(0, start, dur + 0.1);
  const rendered = await off.startRendering();
  return rendered.getChannelData(0);
}

function wordsToCues(chunks) {
  const words = chunks
    .filter((c) => c.timestamp && c.timestamp[0] != null)
    .map((c) => ({ w: c.text.trim(), s: c.timestamp[0], e: c.timestamp[1] ?? c.timestamp[0] + 0.4 }))
    .filter((c) => c.w);
  const out = [];
  let line = [], lineStart = 0;
  for (const wd of words) {
    if (!line.length) lineStart = wd.s;
    line.push(wd);
    if (line.length >= 4 || wd.e - lineStart > 2.6) {
      out.push({ start: lineStart, end: wd.e, text: line.map((x) => x.w).join(' ') });
      line = [];
    }
  }
  if (line.length) out.push({ start: lineStart, end: line[line.length - 1].e, text: line.map((x) => x.w).join(' ') });
  return out;
}

// Caption overlay on the preview (clip-local time)
preview.addEventListener('timeupdate', () => {
  if (!cues.length) return;
  const t = preview.currentTime - clipStart;
  const cue = cues.find((c) => t >= c.start && t <= c.end + 0.15);
  overlay.textContent = cue ? cue.text : '';
});

// ---------- Step 3b: export vertical clip (ffmpeg.wasm) ----------
let ffmpeg = null;
$('btn-export').addEventListener('click', async () => {
  if (!file) return;
  const st = $('export-status');
  const btn = $('btn-export');
  const bar = $('export-progress');
  btn.disabled = true;
  try {
    const start = parseFloat($('in-start').value) || 0;
    const dur = parseFloat($('in-dur').value) || 30;
    if (!ffmpeg) {
      st.textContent = 'Loading the video engine (one-time download)...';
      ffmpeg = new FFmpeg();
      ffmpeg.on('progress', ({ progress }) => {
        bar.classList.remove('hidden');
        bar.value = Math.min(100, Math.round(progress * 100));
      });
      const base = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
      await ffmpeg.load({
        coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
      });
    }
    st.textContent = 'Writing your file...';
    await ffmpeg.writeFile('in.mp4', await fetchFile(file));
    st.textContent = 'Cutting the vertical clip — this can take a minute...';
    const code = await ffmpeg.exec([
      '-ss', String(start), '-i', 'in.mp4', '-t', String(dur),
      '-vf', "crop='min(iw,ih*9/16)':ih,scale=720:1280:flags=lanczos",
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-c:a', 'aac', '-b:a', '128k', 'clip.mp4',
    ]);
    if (code !== 0) throw new Error('ffmpeg failed');
    const data = await ffmpeg.readFile('clip.mp4');
    const url = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
    const box = $('downloads');
    box.innerHTML = '';
    const a = document.createElement('a');
    a.href = url; a.download = 'clipper-clip.mp4'; a.textContent = 'Download Your Clip (MP4)';
    box.appendChild(a);
    if (cues.length) {
      const srt = new Blob([toSrt(cues)], { type: 'text/plain' });
      const b = document.createElement('a');
      b.href = URL.createObjectURL(srt); b.download = 'clipper-captions.srt'; b.textContent = 'Download Captions (.srt)';
      box.appendChild(b);
    }
    st.textContent = 'Done. Your vertical clip is ready.';
  } catch (e) {
    st.textContent = 'Export failed — try a shorter clip or a smaller file.';
  } finally { btn.disabled = false; }
});

function toSrt(list) {
  const ts = (s) => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = Math.floor(s % 60), ms = Math.floor((s % 1) * 1000);
    const p = (v, n = 2) => String(v).padStart(n, '0');
    return `${p(h)}:${p(m)}:${p(ss)},${p(ms, 3)}`;
  };
  return list.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text}\n`).join('\n');
}
