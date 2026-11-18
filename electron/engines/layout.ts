import type { LayoutMode, LayoutTemplate, RectNormalized } from '../types';

export interface FilterGraphResult {
  filterComplex: string;
  videoMap: string;
  suggestedMode: LayoutMode;
}

/** Auto-suggests stacked collage if facecam exists, otherwise fullscreen. */
export function suggestLayoutFromFacecam(facecamBox: RectNormalized | null): LayoutMode {
  return facecamBox ? 'stacked' : 'fullscreen';
}

function clampEven(n: number): number {
  const v = Math.max(2, Math.round(n));
  return v % 2 === 0 ? v : v - 1;
}

/**
 * Compiles exact 1080x1920 FFmpeg filter_complex graphs for all 4 Clipper layouts.
 */
export function buildLayoutFilterGraph(params: {
  sourceWidth: number;
  sourceHeight: number;
  mode: LayoutMode;
  template: LayoutTemplate;
  facecamBox: RectNormalized | null;
}): FilterGraphResult {
  const W = 1080;
  const H = 1920;
  const sw = Math.max(320, params.sourceWidth);
  const sh = Math.max(180, params.sourceHeight);

  const box: RectNormalized = params.facecamBox ?? { x: 0.02, y: 0.68, w: 0.26, h: 0.28 };
  const fx = clampEven(Math.min(sw - 64, Math.max(0, box.x * sw)));
  const fy = clampEven(Math.min(sh - 64, Math.max(0, box.y * sh)));
  const fw = clampEven(Math.min(sw - fx, Math.max(64, box.w * sw)));
  const fh = clampEven(Math.min(sh - fy, Math.max(64, box.h * sh)));

  if (params.mode === 'stacked') {
    const topRatio = Math.min(0.55, Math.max(0.25, params.template.topRatio ?? 0.38));
    const topH = clampEven(H * topRatio);
    const botH = H - topH;

    const filterComplex = [
      `[0:v]split=2[vcam][vgame]`,
      `[vcam]crop=${fw}:${fh}:${fx}:${fy},scale=${W}:${topH}:force_original_aspect_ratio=increase,crop=${W}:${topH}[top]`,
      `[vgame]scale=${W}:${botH}:force_original_aspect_ratio=increase,crop=${W}:${botH}[bot]`,
      `[top][bot]vstack=inputs=2[vout]`,
    ].join(';');

    return { filterComplex, videoMap: '[vout]', suggestedMode: suggestLayoutFromFacecam(params.facecamBox) };
  }

  if (params.mode === 'pip') {
    const scale = Math.min(0.45, Math.max(0.2, params.template.pipScale ?? 0.30));
    const pipW = clampEven(W * scale);
    const pipH = clampEven(pipW * (fh / fw));
    const pad = 36;
    const pos = params.template.pipPosition ?? 'bottom-right';
    const ox = pos.includes('left') ? pad : W - pipW - pad;
    const oy = pos.includes('top') ? 160 : H - pipH - 260;

    const filterComplex = [
      `[0:v]split=2[vbg][vcam]`,
      `[vbg]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}[bg]`,
      `[vcam]crop=${fw}:${fh}:${fx}:${fy},scale=${pipW}:${pipH}[pip]`,
      `[bg][pip]overlay=${ox}:${oy}[vout]`,
    ].join(';');

    return { filterComplex, videoMap: '[vout]', suggestedMode: suggestLayoutFromFacecam(params.facecamBox) };
  }

  if (params.mode === 'split') {
    const halfW = W / 2;
    const midH = 960;
    const filterComplex = [
      `[0:v]split=3[vblur][vl][vr]`,
      `[vblur]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:6[bg]`,
      `[vl]crop=${fw}:${fh}:${fx}:${fy},scale=${halfW}:${midH}:force_original_aspect_ratio=increase,crop=${halfW}:${midH}[left]`,
      `[vr]scale=${halfW}:${midH}:force_original_aspect_ratio=increase,crop=${halfW}:${midH}[right]`,
      `[left][right]hstack=inputs=2[mid]`,
      `[bg][mid]overlay=0:${(H - midH) / 2}[vout]`,
    ].join(';');

    return { filterComplex, videoMap: '[vout]', suggestedMode: suggestLayoutFromFacecam(params.facecamBox) };
  }

  const cropW = clampEven(Math.min(sw, sh * (9 / 16)));
  const faceCenterX = (box.x + box.w / 2) * sw;
  const cropX = params.facecamBox && params.template.smartCrop !== false
    ? clampEven(Math.min(sw - cropW, Math.max(0, faceCenterX - cropW / 2)))
    : clampEven((sw - cropW) / 2);

  const filterComplex = `[0:v]crop=${cropW}:${sh}:${cropX}:0,scale=${W}:${H}[vout]`;
  return { filterComplex, videoMap: '[vout]', suggestedMode: suggestLayoutFromFacecam(params.facecamBox) };
}
