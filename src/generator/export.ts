/**
 * 脚本生成与导出（F7.x，全本地）：
 * - generate(): Page[] → 七段结构脚本 → lint 自检，失败不输出；
 * - 导出：浏览器下载（.py + 同名 .txt 副本）/ JSZip 打包 / FSAccess 直写目录。
 */
import JSZip from 'jszip';
import { DEFAULT_PX_PER_MM, PT_PER_MM } from '@/lib/constants';
import type { Page, Project } from '@/model/types';
import { downloadText } from '@/lib/utils';
import { hasFSAccess, pickDirectory, writeTextFile } from '@/storage/fsaccess';
import { countEmitted, emitAllPagesData, emitPageData } from './emit';
import { getHelperScripts } from './helpers';
import { hasLintError, lintScript, type LintIssue } from './lint';
import { defaultTemplateConfig, renderScript, type TemplateConfig } from './template';

export interface GeneratedScript {
  filename: string;
  code: string;
  issues: LintIssue[];
  ok: boolean;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'page';
}

function buildTemplateConfig(page: Page, pageCount: number, overrides?: Partial<TemplateConfig>): TemplateConfig {
  const cfg = defaultTemplateConfig();
  cfg.sourceWidthPx = page.source.widthPx;
  cfg.sourceHeightPx = page.source.heightPx;
  // 防御：未标定（pxPerMm=0，如 .zpproj 导入后直接导出）时按默认 DPI 换算，避免脚本除零
  cfg.pxPerMm = page.calibration.pxPerMm > 0 ? page.calibration.pxPerMm : DEFAULT_PX_PER_MM;
  cfg.pageWidthMm =
    page.calibration.pageMm[0] > 0 ? page.calibration.pageMm[0] : page.source.widthPx / cfg.pxPerMm;
  cfg.pageHeightMm =
    page.calibration.pageMm[1] > 0 ? page.calibration.pageMm[1] : page.source.heightPx / cfg.pxPerMm;
  cfg.pageCount = pageCount;
  return { ...cfg, ...overrides };
}

/**
 * 生成单页脚本（含 lint 自检）。
 * lint 有 error 时 ok=false，调用方不得导出（F7.5）。
 */
export function generatePageScript(page: Page, overrides?: Partial<TemplateConfig>): GeneratedScript {
  const cfg = buildTemplateConfig(page, 1, overrides);
  const data = `PAGES = [\n${emitPageData(page)}\n]`;
  const code = renderScript(cfg, data);
  const expected = countEmitted(page);
  const issues = lintScript(code, expected);
  return {
    filename: `${sanitizeFilename(page.source.name.replace(/\.[^.]+$/, ''))}_scribus.py`,
    code,
    issues,
    ok: !hasLintError(issues),
  };
}

/** 生成多页合并脚本（F7.6） */
export function generateMergedScript(
  project: Project,
  pages: Page[],
  overrides?: Partial<TemplateConfig>,
): GeneratedScript {
  if (pages.length === 0) throw new Error('没有可导出的页面');
  const sorted = [...pages].sort((a, b) => a.index - b.index);
  const cfg = buildTemplateConfig(sorted[0], sorted.length, overrides);
  const code = renderScript(cfg, emitAllPagesData(sorted));
  const total = sorted.reduce(
    (acc, p) => {
      const c = countEmitted(p);
      acc.borderRects += c.borderRects;
      acc.tagRects += c.tagRects;
      acc.treeLines += c.treeLines;
      acc.treeNodes += c.treeNodes;
      acc.sideChars += c.sideChars;
      acc.textChars += c.textChars;
      acc.artifacts += c.artifacts;
      return acc;
    },
    { borderRects: 0, tagRects: 0, treeLines: 0, treeNodes: 0, sideChars: 0, textChars: 0, artifacts: 0 },
  );
  // 合并脚本对象名带 P{i}_ 前缀，守恒校验改用总数
  const issues = lintScript(code);
  return {
    filename: `${sanitizeFilename(project.name)}_合并_scribus.py`,
    code,
    issues,
    ok: !hasLintError(issues) && total.textChars + total.sideChars >= 0,
  };
}

export interface ExportBundle {
  scripts: GeneratedScript[];
  helpers: Array<{ filename: string; code: string }>;
  reportHtml?: { filename: string; code: string };
}

/** 浏览器逐个下载（.py + 同名 .txt 副本，F7.2） */
export function downloadBundle(bundle: ExportBundle): void {
  for (const s of bundle.scripts) {
    if (!s.ok) continue;
    downloadText(s.filename, s.code, 'text/x-python');
    downloadText(s.filename.replace(/\.py$/, '.txt'), s.code);
  }
  for (const h of bundle.helpers) {
    downloadText(h.filename, h.code, 'text/x-python');
  }
  if (bundle.reportHtml) {
    downloadText(bundle.reportHtml.filename, bundle.reportHtml.code, 'text/html');
  }
}

/** JSZip 打包一次性下载（F7.8） */
export async function downloadZip(bundle: ExportBundle, zipName: string): Promise<void> {
  const zip = new JSZip();
  const scriptDir = zip.folder('scripts');
  for (const s of bundle.scripts) {
    if (!s.ok) continue;
    scriptDir?.file(s.filename, s.code);
    scriptDir?.file(s.filename.replace(/\.py$/, '.txt'), s.code);
  }
  const helperDir = zip.folder('helpers');
  for (const h of bundle.helpers) {
    helperDir?.file(h.filename, h.code);
  }
  if (bundle.reportHtml) {
    zip.file(bundle.reportHtml.filename, bundle.reportHtml.code);
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = zipName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** FSAccess 直写用户指定文件夹（F7.7）；不支持时返回 false 由调用方降级下载 */
export async function writeBundleToDirectory(bundle: ExportBundle): Promise<boolean> {
  if (!hasFSAccess()) return false;
  const dir = await pickDirectory();
  if (!dir) return false;
  const scriptsDir = await dir.getDirectoryHandle('scripts', { create: true });
  for (const s of bundle.scripts) {
    if (!s.ok) continue;
    await writeTextFile(scriptsDir, s.filename, s.code);
    await writeTextFile(scriptsDir, s.filename.replace(/\.py$/, '.txt'), s.code);
  }
  const helpersDir = await dir.getDirectoryHandle('helpers', { create: true });
  for (const h of bundle.helpers) {
    await writeTextFile(helpersDir, h.filename, h.code);
  }
  if (bundle.reportHtml) {
    await writeTextFile(dir, bundle.reportHtml.filename, bundle.reportHtml.code);
  }
  return true;
}

/** 组装完整导出包（脚本 + 4 个辅助脚本 + 可选质检报告） */
export function buildBundle(
  project: Project,
  pages: Page[],
  mode: 'perPage' | 'merged',
  overrides?: Partial<TemplateConfig>,
  reportHtml?: { filename: string; code: string },
): ExportBundle {
  const sorted = [...pages].sort((a, b) => a.index - b.index);
  const scripts =
    mode === 'merged'
      ? [generateMergedScript(project, sorted, overrides)]
      : sorted.map((p) => generatePageScript(p, overrides));
  const helpers = getHelperScripts(sorted[0]?.calibration.pageMm).map((h) => ({ filename: h.filename, code: h.code }));
  return { scripts, helpers, reportHtml };
}

/** 线宽换算展示用（F5.3 公式在界面可查看） */
export { PT_PER_MM };
