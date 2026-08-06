/**
 * Python 脚本模板（PRD 第 10 章七段结构 + 第 11 章全部 Scribus 规避逻辑）。
 * 输出产物是整个产品的契约：UTF-8 无 BOM、人类可读、含中文注释、用户可手改。
 *
 * 七段结构：
 * 1. 编码声明与文档字符串   2. import scribus 与 haveDoc() 环境检查
 * 3. 配置常量区            4. 坐标数据区（emit.ts 生成）
 * 5. 工具函数区            6. 绘制函数区
 * 7. main() 与结果弹窗
 */
import { MM_PER_PT, PREFERRED_FONTS } from '@/lib/constants';

export interface TemplateConfig {
  sourceWidthPx: number;
  sourceHeightPx: number;
  pxPerMm: number;
  pageWidthMm: number;
  pageHeightMm: number;
  /** 强制字体全名（留空自动三层解析） */
  forceFont: string;
  preferredFonts: string[];
  clearPageFirst: boolean;
  sourceImagePath: string;
  sourceImageOpacity: number;
  autoSaveSlaPath: string;
  drawScanArtifact: boolean;
  pageCount: number;
}

export function defaultTemplateConfig(): TemplateConfig {
  return {
    sourceWidthPx: 0,
    sourceHeightPx: 0,
    pxPerMm: 0,
    pageWidthMm: 0,
    pageHeightMm: 0,
    forceFont: '',
    preferredFonts: [...PREFERRED_FONTS],
    clearPageFirst: true,
    sourceImagePath: '',
    sourceImageOpacity: 0.35,
    autoSaveSlaPath: '',
    drawScanArtifact: true,
    pageCount: 1,
  };
}

function pyBool(b: boolean): string {
  return b ? 'True' : 'False';
}

function pyStrList(list: string[]): string {
  return '[' + list.map((s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(', ') + ']';
}

/** 组装完整脚本。dataSection 来自 emit.emitAllPagesData()。 */
export function renderScript(cfg: TemplateConfig, dataSection: string): string {
  const mmPerPt = MM_PER_PT; // 0.352778
  return `# -*- coding: utf-8 -*-
"""
====================================================================
 ZupuScript Web 生成脚本 —— 族谱版面重建（Scribus 1.6.6 适用）
====================================================================
用法：
  1. 打开 Scribus 1.6.6，菜单「文件 → 新建」，页面尺寸设为
     ${cfg.pageWidthMm.toFixed(1)} x ${cfg.pageHeightMm.toFixed(1)} mm（单页），单位选毫米。
     注意：脚本不会自动新建文档——newDoc() 在 1.6.6 已无法脚本化调用。
  2. 菜单「脚本 → 执行脚本…」，选择本文件。
  3. 执行结束查看弹窗报告（含字体反查结果与逐对象异常列表）。
提示：
  - 若字体解析失败脚本会主动中止并列出可用字体，绝不会静默生成空方框。
  - 底部配置常量区全部可调，改完重新执行即可（CLEAR_PAGE_FIRST=True 会先清页）。
====================================================================
"""

# ===================== 2. import 与环境检查 =====================
import scribus

if not scribus.haveDoc():
    scribus.messageBox("ZupuScript", "请先新建文档（页面 ${cfg.pageWidthMm.toFixed(1)} x ${cfg.pageHeightMm.toFixed(1)} mm），再执行本脚本。", scribus.ICON_WARNING)
    raise Exception("no document open")

# ===================== 3. 配置常量区（用户可调） =====================
SOURCE_WIDTH_PX  = ${cfg.sourceWidthPx}      # 原图像素宽
SOURCE_HEIGHT_PX = ${cfg.sourceHeightPx}     # 原图像素高
PX_PER_MM        = ${cfg.pxPerMm.toFixed(6)} # 像素/毫米换算基准（网页端已锁定）
PAGE_WIDTH_MM    = ${cfg.pageWidthMm.toFixed(3)}  # 目标页面宽（mm）
PAGE_HEIGHT_MM   = ${cfg.pageHeightMm.toFixed(3)} # 目标页面高（mm）

# 字体策略：FORCE_FONT 精确指定 → PREFERRED_FONTS 名单精确匹配 → 关键词模糊匹配
FORCE_FONT       = "${cfg.forceFont.replace(/"/g, '\\"')}"  # 强制指定字体全名，留空则自动
PREFERRED_FONTS  = ${pyStrList(cfg.preferredFonts)}

CLEAR_PAGE_FIRST = ${pyBool(cfg.clearPageFirst)}   # 执行前清空当前页旧对象（防新旧重叠）
SOURCE_IMAGE_PATH    = r"${cfg.sourceImagePath}"   # 底图路径（用于半透明核对），留空不铺底
SOURCE_IMAGE_OPACITY = ${cfg.sourceImageOpacity}   # 底图不透明度
AUTO_SAVE_SLA_PATH   = r"${cfg.autoSaveSlaPath}"   # 自动另存 .sla 路径，留空不另存
DRAW_SCAN_ARTIFACT   = ${pyBool(cfg.drawScanArtifact)}  # 是否绘制扫描破损痕迹

MM_PER_PT = ${mmPerPt}  # 1 pt = 0.352778 mm

# ===================== 4. 坐标数据区（网页生成，勿手改结构） =====================
# 元组格式：
#   BORDER_RECTS     (x, y, w, h, name)          外框实心黑条
#   TAG_RECT         (x, y, w, h, name)          装饰块
#   TREE_LINES       (x1, y1, x2, y2, w_px, name) 谱系连线
#   TREE_NODES       (cx, cy, r, stroke_px, name) 节点空心圆
#   SIDE_CHARS       (char, cx, cy, size_pt, name) 书名/页码竖排字
#   TEXT_CHARS       (char, cx, cy, size_pt, name) 正文字符（char 为 None 时跳过）
#   ARTIFACT_STROKES (x1, y1, x2, y2, w_px)      破损痕迹线
# 所有坐标均为原图像素坐标（字符/节点为中心坐标），统一用 mm(px) 换算。
${dataSection}

# ===================== 5. 工具函数区 =====================
def mm(px):
    """像素 → 毫米。"""
    return px / PX_PER_MM

def px_width_to_pt(w_px):
    """线宽像素 → pt。"""
    return w_px / PX_PER_MM * 2.834645669

def normalize_font_name(name):
    """字体名归一化：去空格、去连字符、转小写、剥离 Regular/Normal/Book 后缀。"""
    n = name.lower().replace(" ", "").replace("-", "")
    for suffix in ("regular", "normal", "book"):
        if n.endswith(suffix):
            n = n[: -len(suffix)]
    return n

def resolve_font():
    """三层字体解析（F8.1）。找不到中文字体时中止并列出可用字体（F8.3），绝不静默生成空方框。"""
    available = list(scribus.getFontNames())
    norm_map = {}
    for f in available:
        norm_map.setdefault(normalize_font_name(f), f)

    # 第一层：FORCE_FONT 精确指定
    if FORCE_FONT:
        if FORCE_FONT in available:
            return FORCE_FONT
        key = normalize_font_name(FORCE_FONT)
        if key in norm_map:
            return norm_map[key]
        scribus.messageBox("字体错误", "FORCE_FONT 指定的字体不存在：%s\\n请检查字体名或改用 PREFERRED_FONTS。" % FORCE_FONT, scribus.ICON_CRITICAL)
        raise Exception("FORCE_FONT not found: " + FORCE_FONT)

    # 第二层：PREFERRED_FONTS 名单精确匹配（名归一化后比对）
    for want in PREFERRED_FONTS:
        if want in available:
            return want
        key = normalize_font_name(want)
        if key in norm_map:
            return norm_map[key]

    # 第三层：关键词模糊匹配（覆盖常见 CJK 字体命名变体）
    keywords = ["notoserifcjk", "sourcehanserif", "notosanscjk", "pmingliu", "mingliu",
                "simsun", "songti", "fangsong", "kaiti", "cjk", "ming"]
    for kw in keywords:
        for f in available:
            if kw in normalize_font_name(f):
                return f

    # 全部失败：列出可用字体并中止（宁可报错，不出豆腐块）
    listing = "\\n".join(available[:60])
    scribus.messageBox("字体错误", "未找到任何可用中文字体，已中止。\\n请先安装 Noto Serif CJK TC（为所有用户安装，装完重启 Scribus）。\\n\\n当前可用字体：\\n" + listing, scribus.ICON_CRITICAL)
    raise Exception("no CJK font available")

FONT_ERRORS = []  # setFont 等异常收集（F8.5），结束弹窗统一展示，绝不静默吞掉

def apply_font(item, font, size_pt):
    """字体 + 字号应用（被三次调用：建空框时 / 写入文字后 / selectText 全选后）。"""
    try:
        scribus.setFont(font, item)
        scribus.setFontSize(size_pt, item)
    except Exception as e:
        FONT_ERRORS.append("setFont(%s): %s" % (item, e))

# ===================== 6. 绘制函数区 =====================
def draw_border_rects(rects):
    for (x, y, w, h, name) in rects:
        item = scribus.createRect(mm(x), mm(y), mm(w), mm(h), name)
        scribus.setFillColor("Black", item)
        scribus.setLineColor("None", item)

def draw_tag_rects(rects):
    # 装饰块：实心黑块（内部白色图形请后续在 Scribus 内手工微调）
    draw_border_rects(rects)

def draw_tree_lines(lines):
    for (x1, y1, x2, y2, w_px, name) in lines:
        item = scribus.createLine(mm(x1), mm(y1), mm(x2), mm(y2), name)
        scribus.setLineWidth(px_width_to_pt(w_px), item)
        scribus.setLineColor("Black", item)

def draw_tree_nodes(nodes):
    for (cx, cy, r, stroke_px, name) in nodes:
        item = scribus.createEllipse(mm(cx - r), mm(cy - r), mm(2 * r), mm(2 * r), name)
        scribus.setFillColor("None", item)
        scribus.setLineColor("Black", item)
        scribus.setLineWidth(px_width_to_pt(stroke_px), item)

def draw_artifacts(strokes):
    for (x1, y1, x2, y2, w_px) in strokes:
        item = scribus.createLine(mm(x1), mm(y1), mm(x2), mm(y2))
        scribus.setLineWidth(px_width_to_pt(w_px), item)
        scribus.setLineColor("Black", item)

def draw_chars(chars, font):
    """逐字建文本框。血泪教训：保持实测字号，把文本框放大到字号的 2 倍，切勿缩字号防溢出。"""
    first_item = None
    for entry in chars:
        ch, cx, cy, size_pt, name = entry[0], entry[1], entry[2], entry[3], entry[4]
        if ch is None or size_pt <= 0:
            continue  # 看不清的字（None）跳过，校对后再来
        box_mm = size_pt * MM_PER_PT * 2.0      # 文本框边长 = 字号的 2 倍，杜绝溢出红方块
        x = mm(cx) - box_mm / 2.0               # 按中心定位
        y = mm(cy) - box_mm / 2.0
        item = scribus.createText(x, y, box_mm, box_mm, name)
        apply_font(item, font, size_pt)          # 第 1 次：建空框时
        try:
            scribus.setFillColor("None", item)
            scribus.setLineColor("None", item)
            scribus.setLineWidth(0.0, item)
        except Exception as e:
            FONT_ERRORS.append("frame-style(%s): %s" % (item, e))
        scribus.insertText(ch, 0, item)
        apply_font(item, font, size_pt)          # 第 2 次：写入文字后
        try:
            scribus.setTextAlignment(scribus.ALIGN_CENTERED, item)
        except Exception as e:
            FONT_ERRORS.append("align(%s): %s" % (item, e))
        try:
            scribus.setTextVerticalAlignment(scribus.ALIGNV_CENTERED, item)
        except Exception:
            # 旧版 API 无垂直居中 → 回退：文本距离补偿近似居中
            try:
                scribus.setTextDistances(0, 0, 0, 0, item)
            except Exception as e2:
                FONT_ERRORS.append("valign(%s): %s" % (item, e2))
        try:
            scribus.selectText(item, 0, -1)      # 全选
            apply_font(item, font, size_pt)      # 第 3 次：selectText 全选后
            scribus.deselectAll()
        except Exception as e:
            FONT_ERRORS.append("select-font(%s): %s" % (item, e))
        if first_item is None:
            first_item = item
    return first_item

# ===================== 7. main() 与结果弹窗 =====================
def main():
    scribus.setRedraw(False)
    try:
        if CLEAR_PAGE_FIRST:
            # 防新旧内容重叠：遍历删除当前页全部旧对象
            for obj in list(scribus.getAllObjects()):
                try:
                    scribus.deleteObject(obj)
                except Exception:
                    pass

        font = resolve_font()

        # 可选底图（半透明核对）
        if SOURCE_IMAGE_PATH:
            try:
                img = scribus.createImage(0, 0, PAGE_WIDTH_MM, PAGE_HEIGHT_MM)
                scribus.loadImage(SOURCE_IMAGE_PATH, img)
                scribus.setScaleImageToFrame(True, True, img)
                scribus.sendToBack(img)
            except Exception as e:
                FONT_ERRORS.append("background-image: %s" % e)

        total_chars = 0
        first_item = None
        for pi, D in enumerate(PAGES):
            if pi > 0:
                scribus.newPage(-1)  # 追加一页（尺寸继承文档设置）
            draw_border_rects(D["BORDER_RECTS"])
            draw_tag_rects(D["TAG_RECT"])
            draw_tree_lines(D["TREE_LINES"])
            draw_tree_nodes(D["TREE_NODES"])
            if DRAW_SCAN_ARTIFACT:
                draw_artifacts(D["ARTIFACT_STROKES"])
            it1 = draw_chars(D["TEXT_CHARS"], font)
            it2 = draw_chars(D["SIDE_CHARS"], font)
            total_chars += len(D["TEXT_CHARS"]) + len(D["SIDE_CHARS"])
            if first_item is None:
                first_item = it1 or it2

        # getFont() 反查实际生效字体（F8.6）
        actual_font = "(无字符对象)"
        if first_item is not None:
            try:
                actual_font = scribus.getFont(first_item)
            except Exception as e:
                FONT_ERRORS.append("getFont: %s" % e)

        if AUTO_SAVE_SLA_PATH:
            try:
                scribus.saveDocAs(AUTO_SAVE_SLA_PATH)
            except Exception as e:
                FONT_ERRORS.append("saveDocAs: %s" % e)

        scribus.setRedraw(True)
        scribus.redrawAll()

        err_text = "\\n".join(FONT_ERRORS[:20]) if FONT_ERRORS else "（无）"
        scribus.messageBox(
            "ZupuScript 执行完成",
            "重建完成。\\n\\n请求字体：%s\\n实际生效字体（getFont 反查）：%s\\n页数：%d　字符对象：%d\\n\\n异常记录（前 20 条）：\\n%s\\n\\n若实际字体与请求不符，请检查字体安装（为所有用户安装 + 重启 Scribus）。" % (font, actual_font, len(PAGES), total_chars, err_text),
            scribus.ICON_INFORMATION,
        )
    except Exception:
        scribus.setRedraw(True)
        raise

main()
`;
}
