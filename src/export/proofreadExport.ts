import { jsPDF } from 'jspdf';
import JSZip from 'jszip';
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
  if ('fonts' in document) {
    await Promise.race([document.fonts.ready, new Promise<void>((r) => window.setTimeout(r, 3000))]);
  }
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

/** 预览用缩略图（JPEG + 限尺寸），避免全分辨率 data URL 撑爆内存。 */
const PREVIEW_MAX_EDGE_PX = 720;

export async function renderProofreadPreviewBlob(page: Page, maxEdge = PREVIEW_MAX_EDGE_PX): Promise<Blob> {
  const canvas = await renderProofreadCanvas(page);
  const maxDim = Math.max(canvas.width, canvas.height);
  const scale = Math.min(1, maxEdge / maxDim);
  let target: HTMLCanvasElement = canvas;
  if (scale < 1) {
    const scaled = document.createElement('canvas');
    scaled.width = Math.max(1, Math.round(canvas.width * scale));
    scaled.height = Math.max(1, Math.round(canvas.height * scale));
    const ctx = scaled.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, scaled.width, scaled.height);
    ctx.drawImage(canvas, 0, 0, scaled.width, scaled.height);
    target = scaled;
  }
  return canvasToBlob(target, 'image/jpeg', 0.82);
}

export function revokeObjectUrls(urls: Iterable<string>): void {
  for (const url of urls) {
    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number, timeoutMs = 90_000): Promise<Blob> {
  return Promise.race([
    new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('成果图编码失败'))), type, quality);
    }),
    new Promise<Blob>((_, reject) => {
      window.setTimeout(() => reject(new Error('成果图编码超时，请尝试导出 PDF 后打印')), timeoutMs);
    }),
  ]);
}

/** 生成校对成果 PDF Blob（不含任何页眉页脚，仅页面图像）。 */
export async function buildProofreadPdfBlob(
  pages: Page[],
  onProgress?: (done: number, total: number) => void,
): Promise<Blob> {
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

  return pdf.output('blob');
}

async function waitForDocumentImages(doc: Document): Promise<void> {
  const imgs = [...doc.querySelectorAll('img')];
  await Promise.all(
    imgs.map(
      (img) =>
        new Promise<void>((resolve) => {
          if (img.complete && img.naturalWidth > 0) resolve();
          else {
            img.onload = () => resolve();
            img.onerror = () => resolve();
          }
        }),
    ),
  );
}

/** 弹出打印对话框后尽快返回，避免 afterprint 不触发导致 UI 一直转圈。 */
function openPrintDialog(win: Window): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    win.addEventListener('afterprint', finish, { once: true });
    try {
      const mql = win.matchMedia('print');
      const onPrintChange = () => {
        if (!mql.matches) {
          mql.removeEventListener('change', onPrintChange);
          finish();
        }
      };
      mql.addEventListener('change', onPrintChange);
    } catch {
      /* matchMedia 不可用 */
    }

    win.focus();
    win.print();
    window.setTimeout(finish, 1200);
  });
}

function schedulePrintCleanup(iframe: HTMLIFrameElement, imageUrls: string[], delayMs = 60_000): void {
  window.setTimeout(() => {
    revokeObjectUrls(imageUrls);
    iframe.remove();
  }, delayMs);
}

/** 调用系统打印对话框；隐藏 iframe + 全分辨率图像，不另开标签页。 */
export async function printProofreadPages(
  pages: Page[],
  _title = '校对成果',
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  if (pages.length === 0) throw new Error('没有可打印的页面');
  const sorted = [...pages].sort((a, b) => a.index - b.index);
  const imageUrls: string[] = [];

  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = 'position:fixed;left:-10000px;top:0;width:1024px;height:768px;border:0;visibility:hidden';
  document.body.appendChild(iframe);

  const cleanupNow = () => {
    revokeObjectUrls(imageUrls);
    iframe.remove();
  };

  try {
    for (let index = 0; index < sorted.length; index += 1) {
      const canvas = await renderProofreadCanvas(sorted[index]);
      const blob = await canvasToBlob(canvas, 'image/jpeg', 0.92);
      imageUrls.push(URL.createObjectURL(blob));
      onProgress?.(index + 1, sorted.length);
      await new Promise<void>((r) => window.setTimeout(r, 0));
    }

    const doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    if (!doc || !win) throw new Error('无法创建打印视图');

    const body = imageUrls
      .map((url, index) => `<img src="${url}" alt="" class="print-sheet${index > 0 ? ' print-sheet--break' : ''}" />`)
      .join('');

    doc.open();
    doc.write(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title> </title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    @page { margin: 0; size: auto; }
    html, body { background: #fff; }
    img.print-sheet {
      display: block;
      width: 100%;
      max-height: 100vh;
      object-fit: contain;
      object-position: top center;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    img.print-sheet--break {
      page-break-before: always;
      break-before: page;
    }
  </style>
</head>
<body>${body}</body>
</html>`);
    doc.close();

    await waitForDocumentImages(doc);
    await openPrintDialog(win);
    schedulePrintCleanup(iframe, imageUrls);
  } catch (error) {
    cleanupNow();
    throw error;
  }
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
  const safeFilename = `${sanitizeFilename(filename.replace(/\.pdf$/i, ''))}.pdf`;
  downloadBlob(safeFilename, await buildProofreadPdfBlob(pages, onProgress));
  return safeFilename;
}

/** 导出当前页 PDF（单页文件）。 */
export async function exportProofreadPagePdf(page: Page): Promise<string> {
  const base = sanitizeFilename(page.source.name.replace(/\.[^.]+$/, ''));
  return exportProofreadPdf([page], `${base}_校对成果.pdf`);
}

/** 多页 PNG 打包为 ZIP。 */
export async function exportProofreadPngZip(
  pages: Page[],
  filename: string,
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
  if (pages.length === 0) throw new Error('没有可导出的校对页面');
  const sorted = [...pages].sort((a, b) => a.index - b.index);
  const zip = new JSZip();
  for (let index = 0; index < sorted.length; index += 1) {
    const page = sorted[index];
    const canvas = await renderProofreadCanvas(page);
    const blob = await canvasToBlob(canvas, 'image/png');
    const base = sanitizeFilename(page.source.name.replace(/\.[^.]+$/, ''));
    zip.file(`${String(index + 1).padStart(2, '0')}_${base}_校对成果.png`, blob);
    onProgress?.(index + 1, sorted.length);
  }
  const safeFilename = `${sanitizeFilename(filename.replace(/\.zip$/i, ''))}.zip`;
  downloadBlob(safeFilename, await zip.generateAsync({ type: 'blob' }));
  return safeFilename;
}
