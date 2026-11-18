import type { FaceKeyframe, RectNormalized } from '../../electron/types';

async function createMediaPipeDetector() {
  const { FaceDetector, FilesetResolver } = await import('@mediapipe/tasks-vision');
  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm'
  );
  return FaceDetector.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite',
    },
    runningMode: 'IMAGE',
    minDetectionConfidence: 0.45,
  });
}

function pickPrimaryFace(
  detections: Array<{ boundingBox?: { originX: number; originY: number; width: number; height: number } }>
) {
  let best = detections[0]?.boundingBox;
  let bestArea = best ? best.width * best.height : 0;
  for (const d of detections) {
    const bb = d.boundingBox;
    if (!bb) continue;
    const area = bb.width * bb.height;
    if (area > bestArea) {
      best = bb;
      bestArea = area;
    }
  }
  return best;
}

export async function detectFacecamInVideo(videoEl: HTMLVideoElement): Promise<RectNormalized | null> {
  try {
    const detector = await createMediaPipeDetector();
    const duration = videoEl.duration || 10;
    const samples = [0.15, 0.35, 0.55, 0.75, 0.9].map((r) => r * duration);
    const boxes: RectNormalized[] = [];

    const canvas = document.createElement('canvas');
    canvas.width = videoEl.videoWidth || 1280;
    canvas.height = videoEl.videoHeight || 720;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      detector.close();
      return null;
    }

    for (const t of samples) {
      await new Promise<void>((resolve) => {
        const onSeek = () => {
          videoEl.removeEventListener('seeked', onSeek);
          resolve();
        };
        videoEl.addEventListener('seeked', onSeek);
        videoEl.currentTime = t;
      });
      ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
      const res = detector.detect(canvas);
      const det = pickPrimaryFace(res.detections ?? []);
      if (det) {
        const padX = det.width * 0.85;
        const padY = det.height * 0.65;
        const x = Math.max(0, (det.originX - padX) / canvas.width);
        const y = Math.max(0, (det.originY - padY * 0.7) / canvas.height);
        const w = Math.min(1 - x, (det.width + padX * 2) / canvas.width);
        const h = Math.min(1 - y, (det.height + padY * 2) / canvas.height);
        boxes.push({ x, y, w, h });
      }
    }

    detector.close();
    if (boxes.length === 0) return null;

    const avg = boxes.reduce(
      (acc, b) => ({ x: acc.x + b.x, y: acc.y + b.y, w: acc.w + b.w, h: acc.h + b.h }),
      { x: 0, y: 0, w: 0, h: 0 }
    );
    return {
      x: Number((avg.x / boxes.length).toFixed(3)),
      y: Number((avg.y / boxes.length).toFixed(3)),
      w: Number((avg.w / boxes.length).toFixed(3)),
      h: Number((avg.h / boxes.length).toFixed(3)),
    };
  } catch {
    return null;
  }
}

/**
 * Tracks the primary face across [startSec, endSec] so full-bleed 9:16
 * crops stay centered on whoever is speaking regardless of left/center/right position.
 */
export async function trackFacesInClip(
  videoUrl: string,
  startSec: number,
  endSec: number
): Promise<{ primaryBox: RectNormalized | null; faceTrack: FaceKeyframe[] }> {
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.src = videoUrl;

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Video load timeout')), 12000);
      video.onloadedmetadata = () => { clearTimeout(timer); resolve(); };
      video.onerror = () => { clearTimeout(timer); reject(new Error('Video load error')); };
    });

    const detector = await createMediaPipeDetector();
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(640, video.videoWidth || 640);
    canvas.height = Math.round(canvas.width * ((video.videoHeight || 360) / (video.videoWidth || 640)));
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      detector.close();
      return { primaryBox: null, faceTrack: [] };
    }

    const dur = Math.max(1, endSec - startSec);
    const step = Math.max(1, dur / 35);
    const faceTrack: FaceKeyframe[] = [];
    let firstBox: RectNormalized | null = null;

    for (let rel = 0; rel <= dur; rel += step) {
      await new Promise<void>((resolve) => {
        const onSeek = () => { video.removeEventListener('seeked', onSeek); resolve(); };
        video.addEventListener('seeked', onSeek);
        video.currentTime = Math.min(video.duration || endSec, startSec + rel);
      });
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const res = detector.detect(canvas);
      const det = pickPrimaryFace(res.detections ?? []);
      if (det) {
        const cx = Number(((det.originX + det.width / 2) / canvas.width).toFixed(3));
        const cy = Number(((det.originY + det.height / 2) / canvas.height).toFixed(3));
        faceTrack.push({ t: Number(rel.toFixed(2)), cx, cy });
        if (!firstBox) {
          const padX = det.width * 0.85;
          const padY = det.height * 0.65;
          const x = Math.max(0, (det.originX - padX) / canvas.width);
          const y = Math.max(0, (det.originY - padY * 0.7) / canvas.height);
          firstBox = {
            x: Number(x.toFixed(3)),
            y: Number(y.toFixed(3)),
            w: Number(Math.min(1 - x, (det.width + padX * 2) / canvas.width).toFixed(3)),
            h: Number(Math.min(1 - y, (det.height + padY * 2) / canvas.height).toFixed(3)),
          };
        }
      }
    }

    detector.close();
    return { primaryBox: firstBox, faceTrack };
  } catch {
    return { primaryBox: null, faceTrack: [] };
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}
