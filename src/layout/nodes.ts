/**
 * 节点圆 / 装饰块内部反色 / 破损残留检测（F3.4–F3.6，全本地）。
 */
import { CHAR_MAX_SIZE, CHAR_MIN_AREA, CHAR_MIN_SIZE, NODE_R_MAX, NODE_R_MIN } from '@/lib/constants';
import { connectedComponents } from '@/imaging/raster';
import type { ArtifactStroke, TreeLine, TreeNode } from '@/model/types';
import { uuid } from '@/lib/utils';

/**
 * 检测节点空心圆（F3.4）：环形窗口扫描。
 * 对每个候选中心，采样半径 r 的圆周覆盖率（≥0.55）与内部覆盖率（≤0.3），
 * 满足即判定为空心圆；NMS 去重。
 */
export function detectNodes(bin: Uint8Array, width: number, height: number, lines: TreeLine[] = []): TreeNode[] {
  /**
   * 竖线端点附近的空心圆扫描。
   * 允许圆环的一小段被竖线穿过，因此不能再用“圆必须是独立连通域”的假设。
   */
  const endpointCandidates: Array<{ cx: number; cy: number; r: number; score: number }> = [];
  const horizontalLines = lines.filter((line) => line.orientation === 'h');
  const verticalEndpoints = lines
    .filter((line) => line.orientation === 'v')
    .flatMap((line) => [
      { x: line.x1, y: line.y1, widthPx: line.widthPx },
      { x: line.x2, y: line.y2, widthPx: line.widthPx },
    ]);
  // 横竖线交叉处是分支连接，不是圆节点。只扫描竖线没有接入横线的自由端点。
  const freeEndpoints = verticalEndpoints.filter((endpoint) =>
    !horizontalLines.some((line) => {
      const tolerance = Math.max(4, Math.ceil((endpoint.widthPx + line.widthPx) / 2) + 2);
      return endpoint.x >= Math.min(line.x1, line.x2) - tolerance
        && endpoint.x <= Math.max(line.x1, line.x2) + tolerance
        && Math.abs(endpoint.y - line.y1) <= tolerance;
    }),
  );
  const sampleInk = (x: number, y: number): number =>
    x >= 0 && x < width && y >= 0 && y < height ? bin[y * width + x] : 0;
  for (const endpoint of freeEndpoints) {
    const { x: ex, y: ey } = endpoint;
    let best: { cx: number; cy: number; r: number; score: number } | null = null;
    const centerStep = 2;
    for (let dy = -NODE_R_MAX; dy <= NODE_R_MAX; dy += centerStep) {
      for (let dx = -4; dx <= 4; dx += centerStep) {
        const cx = ex + dx;
        const cy = ey + dy;
        for (let r = NODE_R_MIN; r <= Math.min(NODE_R_MAX, 20); r += 1) {
          const endpointDistance = Math.hypot(cx - ex, cy - ey);
          if (endpointDistance > r * 1.6 + 2) continue;
          let ringHits = 0;
          let ringTotal = 0;
          let innerHits = 0;
          let innerTotal = 0;
          const quadrantHits = [0, 0, 0, 0];
          for (let s = 0; s < 32; s += 1) {
            const theta = (2 * Math.PI * s) / 32;
            const x = Math.round(cx + r * Math.cos(theta));
            const y = Math.round(cy + r * Math.sin(theta));
            ringTotal += 1;
            // 1px 容错，适配扫描缩放后的断续圆环。
            const hit = Math.max(
              sampleInk(x, y),
              sampleInk(x + 1, y),
              sampleInk(x - 1, y),
              sampleInk(x, y + 1),
              sampleInk(x, y - 1),
            );
            ringHits += hit;
            quadrantHits[Math.floor(s / 8)] += hit;
          }
          for (let iy = -Math.floor(r * 0.42); iy <= Math.floor(r * 0.42); iy += 2) {
            for (let ix = -Math.floor(r * 0.42); ix <= Math.floor(r * 0.42); ix += 2) {
              if (ix * ix + iy * iy > (r * 0.42) ** 2) continue;
              innerTotal += 1;
              innerHits += sampleInk(Math.round(cx + ix), Math.round(cy + iy));
            }
          }
          const ringCoverage = ringTotal ? ringHits / ringTotal : 0;
          const innerCoverage = innerTotal ? innerHits / innerTotal : 1;
          const allQuadrantsPresent = quadrantHits.every((hits) => hits >= 4);
          if (ringCoverage >= 0.55 && innerCoverage <= 0.28 && allQuadrantsPresent) {
            const axisPenalty = (Math.abs(cx - ex) / Math.max(1, r)) * 0.2;
            const candidate = { cx, cy, r, score: ringCoverage - innerCoverage - axisPenalty };
            if (!best || candidate.score > best.score) best = candidate;
          }
        }
      }
    }
    if (best) endpointCandidates.push(best);
  }
  // 节点统一由谱系线自由端点驱动，避免“独立圆候选 + 端点候选”在同一处重复输出。
  const candidates: Array<{ cx: number; cy: number; r: number; score: number }> = endpointCandidates;
  candidates.sort((a, b) => b.score - a.score);
  const kept: typeof candidates = [];
  for (const c of candidates) {
    if (!kept.some((k) => Math.hypot(k.cx - c.cx, k.cy - c.cy) < Math.max(k.r, c.r) * 1.5)) kept.push(c);
  }
  return kept.map((c) => ({ id: uuid(), cx: c.cx, cy: c.cy, r: c.r, strokePx: 2 }));
}

/**
 * 检测装饰块内部白色图形（F3.5 第二步）。
 * 输入装饰块列表，输出每个块内反色区域的描述（目前仅统计存在性，
 * 详细矢量由生成脚本以实心块 + 留白方式近似）。
 * 返回每个装饰块内检测到的反色子区域数。
 */
export function analyzeTagRectInversions(
  bin: Uint8Array,
  width: number,
  height: number,
  rect: { x: number; y: number; w: number; h: number },
): number {
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = Math.min(width, rect.x + rect.w);
  const y1 = Math.min(height, rect.y + rect.h);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return 0;
  // 区域内反色：白=1
  const inv = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      inv[y * w + x] = bin[(y0 + y) * width + (x0 + x)] ? 0 : 1;
    }
  }
  const { boxes } = connectedComponents(inv, w, h);
  // 忽略贴边背景（必然连通到区域外）与过小区域
  return boxes.filter((b) => {
    const touchesEdge = b.x === 0 || b.y === 0 || b.x + b.w === w || b.y + b.h === h;
    return !touchesEdge && b.area >= 20;
  }).length;
}

/**
 * 标记疑似扫描破损区域（F3.6）：去除谱系线与字符尺寸连通域后的残留笔画。
 * 输出为短划线段（生成脚本的 ARTIFACT_STROKES）。
 */
export function detectArtifacts(
  bin: Uint8Array,
  width: number,
  height: number,
  lines: TreeLine[],
): ArtifactStroke[] {
  // 1. 去除谱系线（按包围盒加 padding 抹除）
  const residual = new Uint8Array(bin);
  for (const l of lines) {
    const pad = Math.ceil(l.widthPx / 2) + 2;
    const x0 = Math.max(0, Math.floor(Math.min(l.x1, l.x2) - pad));
    const x1 = Math.min(width, Math.ceil(Math.max(l.x1, l.x2) + pad));
    const y0 = Math.max(0, Math.floor(Math.min(l.y1, l.y2) - pad));
    const y1 = Math.min(height, Math.ceil(Math.max(l.y1, l.y2) + pad));
    for (let y = y0; y < y1; y++) residual.fill(0, y * width + x0, y * width + x1);
  }
  // 2. 连通域：字符尺寸的保留（交给分割），其余视作残留
  const { boxes } = connectedComponents(residual, width, height);
  const artifacts: ArtifactStroke[] = [];
  for (const b of boxes) {
    if (b.area < CHAR_MIN_AREA) continue;
    const aspect = Math.max(b.w, b.h) / Math.max(1, Math.min(b.w, b.h));
    const isCharLike =
      b.w >= CHAR_MIN_SIZE && b.h >= CHAR_MIN_SIZE && b.w <= CHAR_MAX_SIZE && b.h <= CHAR_MAX_SIZE;
    if (isCharLike || (aspect < 3 && Math.max(b.w, b.h) < 80)) continue; // 字符与细碎污点不算破损
    // 残留块 → 以包围盒主对角线 + 估算宽度表示
    const longSide = Math.max(b.w, b.h);
    const widthPx = Math.max(1, Math.round(b.area / longSide));
    if (aspect < 3 || widthPx > 12) continue;
    artifacts.push({
      id: uuid(),
      x1: b.x,
      y1: b.y,
      x2: b.x + b.w,
      y2: b.y + b.h,
      widthPx,
    });
    if (artifacts.length >= 300) break; // 安全上限
  }
  return artifacts;
}
