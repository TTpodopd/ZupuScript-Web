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
export function detectNodes(bin: Uint8Array, width: number, height: number): TreeNode[] {
  const candidates: Array<{ cx: number; cy: number; r: number; score: number }> = [];
  const SAMPLES = 24;
  const step = 4;
  for (let cy = NODE_R_MAX; cy < height - NODE_R_MAX; cy += step) {
    for (let cx = NODE_R_MAX; cx < width - NODE_R_MAX; cx += step) {
      for (let r = NODE_R_MIN; r <= NODE_R_MAX; r += 3) {
        // 圆周覆盖率
        let ringHits = 0;
        for (let s = 0; s < SAMPLES; s++) {
          const theta = (2 * Math.PI * s) / SAMPLES;
          // 圆周线宽容忍 ±1px，取两处样本之一命中即可
          let hit = 0;
          for (const rr of [r - 1, r, r + 1]) {
            const x = Math.round(cx + rr * Math.cos(theta));
            const y = Math.round(cy + rr * Math.sin(theta));
            if (x >= 0 && x < width && y >= 0 && y < height && bin[y * width + x]) {
              hit = 1;
              break;
            }
          }
          ringHits += hit;
        }
        const ringCoverage = ringHits / SAMPLES;
        if (ringCoverage < 0.55) continue;
        // 内部覆盖率（抽样内盘）
        let innerHits = 0;
        let innerTotal = 0;
        const innerR = r - 3;
        for (let dy = -innerR; dy <= innerR; dy += 2) {
          for (let dx = -innerR; dx <= innerR; dx += 2) {
            if (dx * dx + dy * dy > innerR * innerR) continue;
            innerTotal++;
            if (bin[(cy + dy) * width + (cx + dx)]) innerHits++;
          }
        }
        const innerCoverage = innerTotal > 0 ? innerHits / innerTotal : 1;
        if (innerCoverage > 0.3) continue;
        candidates.push({ cx, cy, r, score: ringCoverage - innerCoverage });
        break; // 该中心取最小匹配半径即可
      }
    }
  }
  // NMS：按得分排序，抑制中心距离 < r 的重叠候选
  candidates.sort((a, b) => b.score - a.score);
  const kept: typeof candidates = [];
  for (const c of candidates) {
    const overlap = kept.some((k) => Math.hypot(k.cx - c.cx, k.cy - c.cy) < Math.min(k.r, c.r));
    if (!overlap) kept.push(c);
    if (kept.length >= 500) break; // 安全上限
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
    const isCharLike =
      b.w >= CHAR_MIN_SIZE && b.h >= CHAR_MIN_SIZE && b.w <= CHAR_MAX_SIZE && b.h <= CHAR_MAX_SIZE;
    if (isCharLike) continue; // 字符候选，不算破损
    // 残留块 → 以包围盒主对角线 + 估算宽度表示
    const longSide = Math.max(b.w, b.h);
    const widthPx = Math.max(1, Math.round(b.area / longSide));
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
