/**
 * 质检报告（P1 最小实现，F9.x）：
 * 红/蓝/黑三色叠加比对（原图独有=红、重建独有=蓝、重合=黑），
 * 墨迹 IoU、字符命中率、平均偏移量，输出单文件 HTML（图片 base64 内联，可离线打开）。
 */
import { CONFIDENCE_THRESHOLD } from '@/lib/constants';
import type { Page } from '@/model/types';
import { renderPreviewBinary } from './preview';

export interface VerifyMetrics {
  /** 墨迹 IoU（0..1） */
  iou: number;
  /** 字符命中率：重建图中字符中心附近有墨的比例 */
  charHitRate: number;
  /** 平均偏移量（px）：每个字框内重建墨迹质心与字符中心的平均距离 */
  avgOffsetPx: number;
  totalChars: number;
  recognizedChars: number;
  lowConfChars: number;
  /** 叠加比对图（红/蓝/黑）dataURL */
  overlayDataUrl: string;
}

/** 计算质检指标与叠加图 */
export function computeVerify(page: Page, origBin: Uint8Array, width: number, height: number): VerifyMetrics {
  const reconBin = renderPreviewBinary(page);

  // 1. 叠加比对图 + IoU
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(width, height);
  let inter = 0;
  let union = 0;
  for (let i = 0, j = 0; j < origBin.length; i += 4, j++) {
    const o = origBin[j];
    const r = reconBin[j];
    let red = 255;
    let green = 255;
    let blue = 255;
    if (o && r) {
      red = 0; green = 0; blue = 0; // 重合 → 黑
      inter++;
      union++;
    } else if (o) {
      red = 220; green = 38; blue = 38; // 原图独有 → 红
      union++;
    } else if (r) {
      red = 37; green = 99; blue = 235; // 重建独有 → 蓝
      union++;
    }
    img.data[i] = red;
    img.data[i + 1] = green;
    img.data[i + 2] = blue;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const iou = union > 0 ? inter / union : 1;

  // 2. 字符命中率与平均偏移
  let hits = 0;
  let offsetSum = 0;
  let offsetCount = 0;
  const withText = page.chars.filter((c) => c.text);
  for (const c of page.chars) {
    if (!c.text) continue;
    const [x0, y0, x1, y1] = c.bbox;
    let inkCount = 0;
    let sumX = 0;
    let sumY = 0;
    const cx0 = Math.max(0, Math.floor(x0));
    const cy0 = Math.max(0, Math.floor(y0));
    const cx1 = Math.min(width, Math.ceil(x1));
    const cy1 = Math.min(height, Math.ceil(y1));
    for (let y = cy0; y < cy1; y++) {
      for (let x = cx0; x < cx1; x++) {
        if (reconBin[y * width + x]) {
          inkCount++;
          sumX += x;
          sumY += y;
        }
      }
    }
    if (inkCount > 0) {
      hits++;
      const mx = sumX / inkCount;
      const my = sumY / inkCount;
      offsetSum += Math.hypot(mx - c.cx, my - c.cy);
      offsetCount++;
    }
  }

  return {
    iou,
    charHitRate: withText.length > 0 ? hits / withText.length : 0,
    avgOffsetPx: offsetCount > 0 ? offsetSum / offsetCount : 0,
    totalChars: page.chars.length,
    recognizedChars: withText.length,
    lowConfChars: page.chars.filter((c) => c.conf < CONFIDENCE_THRESHOLD).length,
    overlayDataUrl: canvas.toDataURL('image/png'),
  };
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 生成单文件 HTML 质检报告（F9.4） */
export function buildReportHtml(page: Page, metrics: VerifyMetrics): string {
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const iouWarn = metrics.iou < 0.5;
  const lowConfSample = page.chars
    .filter((c) => c.conf < CONFIDENCE_THRESHOLD)
    .slice(0, 50)
    .map((c) => `<tr><td>${esc(c.text ?? '（空）')}</td><td>${c.conf.toFixed(2)}</td><td>${c.note}</td><td>(${Math.round(c.cx)}, ${Math.round(c.cy)})</td></tr>`)
    .join('\n');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>质检报告 - ${esc(page.source.name)}</title>
<style>
body{font-family:"Noto Serif CJK SC",SimSun,serif;max-width:960px;margin:24px auto;padding:0 16px;color:#1c1917}
h1{font-size:22px} table{border-collapse:collapse;width:100%;margin:12px 0}
td,th{border:1px solid #d6d3d1;padding:6px 10px;font-size:14px;text-align:left}
.warn{background:#fef2f2;color:#b91c1c;padding:10px;border-radius:6px}
img{max-width:100%;border:1px solid #d6d3d1}
.legend span{display:inline-block;width:14px;height:14px;margin-right:4px;vertical-align:middle}
</style>
</head>
<body>
<h1>ZupuScript 质检报告</h1>
<p>页面：${esc(page.source.name)}　生成时间：${new Date().toLocaleString('zh-CN')}</p>
${iouWarn ? '<p class="warn">⚠ 墨迹 IoU 偏低，建议返回校对界面检查后再导出。</p>' : ''}
<h2>指标</h2>
<table>
<tr><th>墨迹 IoU</th><td>${metrics.iou.toFixed(3)}</td></tr>
<tr><th>字符命中率</th><td>${pct(metrics.charHitRate)}</td></tr>
<tr><th>平均偏移量</th><td>${metrics.avgOffsetPx.toFixed(2)} px</td></tr>
<tr><th>字符总数 / 已识别</th><td>${metrics.totalChars} / ${metrics.recognizedChars}</td></tr>
<tr><th>低置信字符</th><td>${metrics.lowConfChars}</td></tr>
</table>
<h2>叠加比对图</h2>
<p class="legend">
<span style="background:#000"></span>重合（黑）　
<span style="background:#dc2626"></span>原图独有（红）　
<span style="background:#2563eb"></span>重建独有（蓝）
</p>
<img src="${metrics.overlayDataUrl}" alt="叠加比对图" />
${lowConfSample ? `<h2>低置信字符（前 50 条）</h2>
<table><tr><th>字</th><th>置信度</th><th>标记</th><th>中心坐标</th></tr>
${lowConfSample}
</table>` : ''}
</body>
</html>`;
}
