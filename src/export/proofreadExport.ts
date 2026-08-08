import { jsPDF } from 'jspdf';
import type { Page } from '@/model/types';
import { renderPreviewToCanvas } from '@/verify/preview';

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || '校对成果';
}

function pageSizeMm(page: Page): [number, number] {
  const pxPerMm = page.calibration.pxPerMm > 0 ? page.calibration.pxPerMm : page.source.dpi > 0 ? page.source.dpi / 25.4 : 10;
  const width = page.calibration.pageMm[0] > 0 ? page.calibration.pageMm[0] : page.source.widthPx / pxPerMm;
  const height = page.calibration.pageMm[1] > 0 ? page.calibration.pageMm[1] : page.source.heightPx / pxPerMm;
  return [width, height];
}

/** 渲染不含选框、低置信标记和操作提示的干净成果画布。 */
export async function renderProofreadCanvas(page: Page): Promise<HTMLCanvasElement> {
  if ('fonts' in document) await document.fonts.ready;
  const canvas = document.createElement('canvas');
  renderPreviewToCanvas(page, canvas);
  return canvas;
}

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('成果图编码失败'))), type, quality);
  });
}

/** 导出不含编辑辅助标记的当前校对成果 PNG。 */
export async function exportProofreadPng(page: Page): Promise<string> {
  const canvas = await renderProofreadCanvas(page);
  const filename = `${sanitizeFilename(page.source.name.replace(/\.[^.]+$/, ''))}_校对成果.png`;
  downloadBlob(filename, await canvasToBlob(canvas, 'image/png'));
  return filename;
}

/** 将一页或多页校对成果合并为一个 PDF，页面尺寸沿用各页标定结果。 */
export async function exportProofreadPdf(
  pages: Page[],
  filename: string,
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
  if (pages.length === 0) throw new Error('没有可导出的校对页面');
  const sorted = [...pages].sort((a, b) => a.index - b.index);
  const firstSize = pageSizeMm(sorted[0]);
  const pdf = new jsPDF({
    orientation: firstSize[0] > firstSize[1] ? 'landscape' : 'portrait',
    unit: 'mm',
    format: firstSize,
    compress: true,
  });

  for (let index = 0; index < sorted.length; index += 1) {
    const page = sorted[index];
    const [widthMm, heightMm] = pageSizeMm(page);
    if (index > 0) pdf.addPage([widthMm, heightMm], widthMm > heightMm ? 'landscape' : 'portrait');
    const canvas = await renderProofreadCanvas(page);
    pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, widthMm, heightMm, undefined, 'FAST');
    onProgress?.(index + 1, sorted.length);
  }

  const safeFilename = `${sanitizeFilename(filename.replace(/\.pdf$/i, ''))}.pdf`;
  downloadBlob(safeFilename, pdf.output('blob'));
  return safeFilename;
}
