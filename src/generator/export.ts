/**
 * 脚本生成与导出（F7.x，全本地）：
 * - generate(): Page[] → 七段结构脚本 → lint 自检，失败不输出；
 * - 导出：默认只输出 Scribus 实际执行所需的 .py 脚本。
 */
import JSZip from 'jszip';
import { DEFAULT_PX_PER_MM, PT_PER_MM } from '@/lib/constants';
import type { Page, Project } from '@/model/types';
import { exportProject } from '@/model/zpproj';
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
  /** 网页校对后的完整场景数据，供回溯、二次编辑和外部工具读取。 */
  sceneJson: { filename: string; code: string };
  /** 给 Scribus 操作员的最短执行说明。 */
  readme: { filename: string; code: string };
  reportHtml?: { filename: string; code: string };
}

function buildReadme(project: Project, pages: Page[], mode: 'perPage' | 'merged'): string {
  const scriptHint = mode === 'merged' ? `${project.name}_合并_scribus.py` : 'scripts/ 目录内任一页面脚本';
  return `# ${project.name} · Scribus 最终排版包

本工作包采用“双引擎”流程：网页负责识别、编辑和校对，Scribus 负责最终字体排版与印刷级输出。

## 在 Scribus 1.6.6 中执行

1. 打开 Scribus，新建自定义页面。页面尺寸以脚本顶部的 PAGE_WIDTH_MM / PAGE_HEIGHT_MM 为准，单位使用毫米。
2. 打开“脚本 → 执行脚本…”，执行 ${scriptHint}。
3. 首次执行若提示字体缺失，先执行 helpers/字体清单脚本.py，再把实际中文字体全名填入脚本的 FORCE_FONT。
4. 执行完成后在 Scribus 中检查字体、出血和页面尺寸，再导出 PDF/PNG。

## 数据约定

- 所有坐标以原图像素为基准；脚本内部按 PX_PER_MM 换算为毫米。
- 文本框、字号、居中、节点白色遮挡和黑标折角已按 v7 规则生成。
- scene.json 保存网页端校对后的可编辑数据，可用于回溯和二次导入。
- 本包不包含 API Key；原图是否携带由用户自行控制。

页面数：${pages.length}
生成时间：${new Date().toLocaleString('zh-CN')}
`;
}

/** 浏览器逐个下载关键脚本；场景、说明和辅助文件不再混入默认导出。 */
export function downloadBundle(bundle: ExportBundle): void {
  for (const s of bundle.scripts) {
    if (!s.ok) continue;
    downloadText(s.filename, s.code, 'text/x-python');
  }
}

/** JSZip 打包一次性下载（F7.8） */
export async function downloadZip(bundle: ExportBundle, zipName: string): Promise<void> {
  const zip = new JSZip();
  const scriptDir = zip.folder('scripts');
  for (const s of bundle.scripts) {
    if (!s.ok) continue;
    scriptDir?.file(s.filename, s.code);
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
  const safeName = sanitizeFilename(project.name);
  return {
    scripts,
    helpers,
    sceneJson: { filename: 'scene.json', code: exportProject(project, sorted) },
    readme: { filename: `${safeName}_Scribus使用说明.md`, code: buildReadme(project, sorted, mode) },
    reportHtml,
  };
}

/** 线宽换算展示用（F5.3 公式在界面可查看） */
export { PT_PER_MM };
