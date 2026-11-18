import type { RectNormalized } from '../../electron/types';

/**
 * Runs MediaPipe FaceDetector locally in the Electron Chromium GPU/WASM renderer.
 * Samples 5 frames across the clip and clusters bounding boxes to locate a persistent facecam.
 */
export async function detectFacecamInVideo(videoEl: HTMLVideoElement): Promise<RectNormalized | null> {
  try {
    const { FaceDetector, FilesetResolver } = await import('@mediapipe/tasks-vision');
    const vision = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm'
    );
    const detector = await FaceDetector.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite',
      },
      runningMode: 'IMAGE',
      minDetectionConfidence: 0.55,
    });

    const duration = videoEl.duration || 10;
    const samples = [0.15, 0.35, 0.55, 0.75, 0.9].map((r) => r * duration);
    const boxes: RectNormalized[] = [];

    const canvas = document.createElement('canvas');
    canvas.width = videoEl.videoWidth || 1280;
    canvas.height = videoEl.videoHeight || 720;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

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
      const det = res.detections?.[0]?.boundingBox;
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
