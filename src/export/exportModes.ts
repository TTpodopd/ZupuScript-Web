import type { Page } from '@/model/types';
import { resolveSourceKind } from '@/imaging/sourceProfile';

/** 校对成果导出模式 */
export type ExportMode =
  | 'page-png'
  | 'page-pdf'
  | 'merged-pdf'
  | 'pages-png-zip';

export function getExportablePages(pages: Page[]): Page[] {
  return [...pages].filter((p) => p.chars.length > 0).sort((a, b) => a.index - b.index);
}

export function projectFromPdf(pages: Page[]): boolean {
  return pages.some((p) => resolveSourceKind(p.source) === 'pdf');
}

export function defaultExportMode(pages: Page[]): ExportMode {
  const exportable = getExportablePages(pages);
  if (exportable.length <= 1) return 'page-png';
  return projectFromPdf(pages) ? 'merged-pdf' : 'merged-pdf';
}

export function availableExportModes(pages: Page[]): ExportMode[] {
  const exportable = getExportablePages(pages);
  if (exportable.length === 0) return [];
  if (exportable.length === 1) return ['page-png', 'page-pdf'];
  return ['page-png', 'page-pdf', 'merged-pdf', 'pages-png-zip'];
}

export function exportModeLabel(mode: ExportMode): string {
  switch (mode) {
    case 'page-png':
      return '当前页 PNG';
    case 'page-pdf':
      return '当前页 PDF';
    case 'merged-pdf':
      return '全部页合并 PDF';
    case 'pages-png-zip':
      return '全部页 PNG 打包';
    default:
      return mode;
  }
}

export function exportModeDescription(mode: ExportMode, pageCount: number): string {
  switch (mode) {
    case 'page-png':
      return '导出当前选中页的校对成果为 PNG 图像。';
    case 'page-pdf':
      return '导出当前选中页为单页 PDF，尺寸沿用标定结果。';
    case 'merged-pdf':
      return `将 ${pageCount} 页校对成果按顺序合并为一个多页 PDF 文件。`;
    case 'pages-png-zip':
      return `将 ${pageCount} 页分别导出为 PNG，并打包为一个 ZIP 文件。`;
    default:
      return '';
  }
}
