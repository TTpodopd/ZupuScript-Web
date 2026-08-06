/**
 * 4 个辅助脚本（PRD 8.10，P1）：
 * 1. 字体清单脚本   2. 字框轮廓开关脚本   3. 页面尺寸检查脚本   4. 批量导出 PDF/PNG 脚本
 * 均为独立可在 Scribus 1.6.6 内执行的 Python 脚本，UTF-8 无 BOM。
 */

export interface HelperScript {
  filename: string;
  title: string;
  description: string;
  code: string;
}

/** 1. 字体清单脚本：列出 Scribus 实际可用字体全名，标出 CJK 候选，导出 txt（F8.7） */
const FONT_LIST_SCRIPT = `# -*- coding: utf-8 -*-
"""字体清单：把 Scribus 实际可用的字体全名导出到 txt，并标出 CJK 候选。"""
import scribus

CJK_KEYWORDS = ["noto", "cjk", "source han", "mingliu", "pmingliu", "simsun",
                "songti", "fangsong", "kaiti", "hei", "kai", "song"]

def main():
    if not scribus.haveDoc():
        scribus.messageBox("提示", "请先打开任意文档再运行。", scribus.ICON_WARNING)
        return
    fonts = sorted(scribus.getFontNames())
    lines = ["Scribus 可用字体清单（共 %d 个）" % len(fonts), ""]
    lines.append("== CJK 候选字体（推荐优先使用） ==")
    for f in fonts:
        low = f.lower()
        if any(k in low for k in CJK_KEYWORDS):
            lines.append("  [CJK] " + f)
    lines.append("")
    lines.append("== 全部字体 ==")
    lines.extend("  " + f for f in fonts)
    out = "\\n".join(lines)
    path = scribus.fileDialog("保存字体清单", "文本文件 (*.txt)", "scribus_fonts.txt", True)
    if path:
        with open(path, "w", encoding="utf-8") as fp:
            fp.write(out)
        scribus.messageBox("完成", "字体清单已保存：\\n" + path, scribus.ICON_INFORMATION)

main()
`;

/** 2. 字框轮廓开关脚本：一键给全部文本框加/去彩色细边，便于点选编辑 */
const FRAME_OUTLINE_SCRIPT = `# -*- coding: utf-8 -*-
"""字框轮廓开关：给当前页全部文本框加/去彩色细边，便于点选与核对。
（菜单对照：「查看 → 显示框架」在 1.6.6 已拆入子菜单，可用本脚本替代。）"""
import scribus

def main():
    if not scribus.haveDoc():
        scribus.messageBox("提示", "请先打开文档。", scribus.ICON_WARNING)
        return
    objects = scribus.getAllObjects()
    toggled = 0
    for name in objects:
        try:
            if scribus.getObjectType(name) != "TextFrame":
                continue
            # 有边 → 去边；无边 → 加淡红细边
            w = scribus.getLineWidth(name)
            if w and w > 0:
                scribus.setLineColor("None", name)
                scribus.setLineWidth(0.0, name)
            else:
                scribus.setLineColor("Red", name)
                scribus.setLineWidth(0.3, name)
            toggled += 1
        except Exception:
            pass
    scribus.redrawAll()
    scribus.messageBox("完成", "已切换 %d 个文本框的轮廓显示。" % toggled, scribus.ICON_INFORMATION)

main()
`;

/** 3. 页面尺寸检查脚本：校验当前文档尺寸是否与目标一致 */
const PAGE_SIZE_CHECK_SCRIPT = `# -*- coding: utf-8 -*-
"""页面尺寸检查：校验当前文档尺寸是否与目标一致（单位 mm）。"""
import scribus

# ===== 修改为生成脚本里 PAGE_WIDTH_MM / PAGE_HEIGHT_MM 的值 =====
TARGET_W = 0.0
TARGET_H = 0.0

def main():
    if not scribus.haveDoc():
        scribus.messageBox("提示", "请先打开文档。", scribus.ICON_WARNING)
        return
    w, h = scribus.getPageSize()
    if TARGET_W <= 0 or TARGET_H <= 0:
        scribus.messageBox("页面尺寸", "当前页面：%.2f x %.2f mm\\n（未设置目标尺寸，请编辑脚本顶部 TARGET_W/TARGET_H）" % (w, h), scribus.ICON_INFORMATION)
        return
    if abs(w - TARGET_W) < 0.5 and abs(h - TARGET_H) < 0.5:
        scribus.messageBox("检查通过", "页面尺寸一致：%.2f x %.2f mm" % (w, h), scribus.ICON_INFORMATION)
    else:
        scribus.messageBox("尺寸不符", "当前 %.2f x %.2f mm，目标 %.2f x %.2f mm。\\n请在「文件 → 文档设置」中调整。" % (w, h, TARGET_W, TARGET_H), scribus.ICON_WARNING)

main()
`;

/** 4. 批量导出脚本：遍历多页文档批量导出 PDF/PNG */
const BATCH_EXPORT_SCRIPT = `# -*- coding: utf-8 -*-
"""批量导出：把当前多页文档逐页导出为 PNG，并整体导出一份 PDF。"""
import os
import scribus

# ===== 输出目录（改为你的目录） =====
OUTPUT_DIR = r""
BASE_NAME = "page"
EXPORT_PDF = True
EXPORT_PNG = True
PNG_DPI = 200

def main():
    if not scribus.haveDoc():
        scribus.messageBox("提示", "请先打开文档。", scribus.ICON_WARNING)
        return
    if not OUTPUT_DIR:
        scribus.messageBox("提示", "请先编辑脚本顶部 OUTPUT_DIR。", scribus.ICON_WARNING)
        return
    if not os.path.isdir(OUTPUT_DIR):
        os.makedirs(OUTPUT_DIR)
    pages = scribus.getPageCount()
    if EXPORT_PNG:
        for i in range(1, pages + 1):
            scribus.gotoPage(i)
            img = scribus.ImageExport()
            img.type = "PNG"
            img.dpi = PNG_DPI
            img.name = os.path.join(OUTPUT_DIR, "%s_%03d" % (BASE_NAME, i))
            img.save()
    if EXPORT_PDF:
        pdf = scribus.PDFfile()
        pdf.file = os.path.join(OUTPUT_DIR, BASE_NAME + ".pdf")
        pdf.save()
    scribus.messageBox("完成", "已导出 %d 页到：\\n%s" % (pages, OUTPUT_DIR), scribus.ICON_INFORMATION)

main()
`;

export function getHelperScripts(pageMm?: [number, number]): HelperScript[] {
  let sizeScript = PAGE_SIZE_CHECK_SCRIPT;
  if (pageMm && pageMm[0] > 0) {
    sizeScript = sizeScript
      .replace('TARGET_W = 0.0', `TARGET_W = ${pageMm[0].toFixed(3)}`)
      .replace('TARGET_H = 0.0', `TARGET_H = ${pageMm[1].toFixed(3)}`);
  }
  return [
    {
      filename: 'helper_字体清单.py',
      title: '字体清单脚本',
      description: '列出 Scribus 实际可用字体全名，标出 CJK 候选，导出 txt（先跑它确认字体名）',
      code: FONT_LIST_SCRIPT,
    },
    {
      filename: 'helper_字框轮廓开关.py',
      title: '字框轮廓开关脚本',
      description: '一键给全部文本框加/去彩色细边，便于点选编辑',
      code: FRAME_OUTLINE_SCRIPT,
    },
    {
      filename: 'helper_页面尺寸检查.py',
      title: '页面尺寸检查脚本',
      description: '校验当前文档尺寸是否与目标一致',
      code: sizeScript,
    },
    {
      filename: 'helper_批量导出.py',
      title: '批量导出脚本',
      description: '遍历多页文档批量导出 PDF/PNG',
      code: BATCH_EXPORT_SCRIPT,
    },
  ];
}
