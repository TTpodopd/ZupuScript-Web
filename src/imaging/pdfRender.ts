/**
 * PDF.js 渲染后处理：加粗矢量笔画，使页框/谱系线接近扫描图墨迹厚度。
 */
import { dilateBinary } from '@/imaging/preprocess';

/** 将 PDF 页 canvas 上的浅色笔画二值化并轻微膨胀，再写回（仅 PDF 导入时调用） */
export function thickenPdfRenderedPage(canvas: HTMLCanvasElement, radius = 2): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height } = canvas;
  const img = ctx.getImageData(0, 0, width, height);
  const bin = new Uint8Array(width * height);
  for (let i = 0, j = 0; j < bin.length; i += 4, j += 1) {
    const lum = (img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3;
    bin[j] = lum < 220 ? 1 : 0;
  }
  const thickened = dilateBinary(bin, width, height, radius);
  for (let i = 0, j = 0; j < thickened.length; i += 4, j += 1) {
    const v = thickened[j] ? 0 : 255;
    img.data[i] = v;
    img.data[i + 1] = v;
    img.data[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
}
