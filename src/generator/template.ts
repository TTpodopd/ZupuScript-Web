/**
 * Python 脚本模板（PRD 第 10 章七段结构 + 第 11 章全部 Scribus 规避逻辑）。
 * 参考 v7 实测脚本（倪氏宗谱 NotoSerifCJK 版）的绘制方法优化。
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

try:
    scribus.setUnit(scribus.UNIT_MILLIMETERS)
except Exception:
    pass

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

BLACK = "Black"
WHITE = "White"
ARTIFACT_GRAY = "ScanGray"

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
    return float(px) / PX_PER_MM

def pt(px):
    """像素 → pt（线宽换算）。"""
    return float(px) / PX_PER_MM * 2.834645669

def normalize_font_name(name):
    """字体名归一化：去空格、去连字符、转小写、剥离 Regular/Normal/Book 后缀。"""
    n = name.lower()
    for junk in (" ", "-", "_", ",", "."):
        n = n.replace(junk, "")
    for suffix in ("regular", "normal", "book", "medium", "roman"):
        if n.endswith(suffix):
            n = n[: -len(suffix)]
    return n

def is_probable_cjk_font(name):
    """判断字体名是否可能是 CJK 字体（含汉字或含 CJK 关键词）。"""
    for ch in name:
        if 0x2E80 <= ord(ch) <= 0x9FFF:
            return True
    low = name.lower().replace(" ", "").replace("-", "")
    keys = ("cjk", "sourcehan", "noto", "song", "ming", "hei", "kai", "fang",
            "sim", "yahei", "msjh", "msyh", "batang", "gulim", "pingfang",
            "hiragino", "wqy", "wenquanyi", "unifont", "dfkai", "kaiu")
    return any(k in low for k in keys)

# 按顺序尝试的字体全名，Noto Serif CJK 在不同平台上叫法不一样
FUZZY_KEYS = [
    "notoserifcjktc", "notoseriftc", "notoserifcjk",
    "sourcehanseriftc", "sourcehanserif",
    "notosanscjktc", "notosanscjk",
    "mingliu", "pmingliu", "simsun", "songti", "kaiti",
]

def resolve_font():
    """三层字体解析（F8.1）。找不到中文字体时中止并列出可用字体（F8.3），绝不静默生成空方框。"""
    try:
        available = list(scribus.getFontNames())
    except Exception:
        available = []

    # FORCE_FONT 精确指定
    if FORCE_FONT:
        if FORCE_FONT in available:
            return FORCE_FONT, available, True
        scribus.messageBox("字体错误", "FORCE_FONT 指定的字体不存在：%s\\n请检查字体名或改用 PREFERRED_FONTS。" % FORCE_FONT, scribus.ICON_CRITICAL)
        return None, available, False

    # 第一层：PREFERRED_FONTS 名单精确匹配
    for want in PREFERRED_FONTS:
        if want in available:
            return want, available, True

    # 第二层：关键词模糊匹配（归一化后比对，容忍字体名变形）
    normalized = [(normalize_font_name(f), f) for f in available]
    for key in FUZZY_KEYS:
        for norm, original in normalized:
            if key in norm:
                return original, available, True

    # 第三层：CJK 字符检测兜底
    for f in available:
        if is_probable_cjk_font(f):
            return f, available, True

    # 全部失败：列出可用字体并中止（宁可报错，不出豆腐块）
    listing = "\\n".join(sorted(available)[:60])
    scribus.messageBox("字体错误", "未找到任何可用中文字体，已中止。\\n请先安装 Noto Serif CJK TC（为所有用户安装，装完重启 Scribus）。\\n\\n当前可用字体：\\n" + listing, scribus.ICON_CRITICAL)
    return None, available, False

FONT_ERRORS = []  # setFont 等异常收集（F8.5），结束弹窗统一展示，绝不静默吞掉

def apply_font(obj, font):
    """字体应用（仅 setFont，不含字号；被三次调用确保字体生效）。"""
    if not font:
        return
    try:
        scribus.setFont(font, obj)
    except Exception as exc:
        if len(FONT_ERRORS) < 10:
            FONT_ERRORS.append("setFont(%s): %s" % (obj, exc))

def ensure_colors():
    """定义自定义颜色（ScanGray 用于破损痕迹）。"""
    try:
        scribus.defineColor(ARTIFACT_GRAY, 0, 0, 0, 110)
    except Exception:
        pass

# ===================== 6. 绘制函数区 =====================
def draw_border_rects(rects):
    for (x, y, w, h, name) in rects:
        item = scribus.createRect(mm(x), mm(y), mm(w), mm(h), name)
        scribus.setFillColor(BLACK, item)
        scribus.setLineColor("None", item)
        scribus.setLineWidth(0.0, item)

def draw_tag_rects(rects):
    # 装饰块：实心黑块（内部白色图形请后续在 Scribus 内手工微调）
    for (x, y, w, h, name) in rects:
        item = scribus.createRect(mm(x), mm(y), mm(w), mm(h), name)
        scribus.setFillColor(BLACK, item)
        scribus.setLineColor("None", item)
        scribus.setLineWidth(0.0, item)

def draw_tree_lines(lines):
    for (x1, y1, x2, y2, w_px, name) in lines:
        item = scribus.createLine(mm(x1), mm(y1), mm(x2), mm(y2), name)
        scribus.setLineColor(BLACK, item)
        scribus.setLineWidth(pt(w_px), item)

def draw_tree_nodes(nodes):
    # 节点圆：白色填充 + 黑色描边（白色填充覆盖穿过的连线）
    for (cx, cy, r, stroke_px, name) in nodes:
        d = r * 2.0
        item = scribus.createEllipse(mm(cx - r), mm(cy - r), mm(d), mm(d), name)
        scribus.setFillColor(WHITE, item)
        scribus.setLineColor(BLACK, item)
        scribus.setLineWidth(pt(stroke_px), item)

def draw_artifacts(strokes):
    # 破损痕迹：用 ScanGray（浅灰）而非纯黑，更接近原件
    for i, (x1, y1, x2, y2, w_px) in enumerate(strokes):
        item = scribus.createLine(mm(x1), mm(y1), mm(x2), mm(y2))
        scribus.setLineWidth(pt(w_px), item)
        scribus.setLineColor(ARTIFACT_GRAY, item)

def draw_chars(chars, font):
    """逐字建文本框。参考 v7 实测脚本的绘制方法：
    - 文本框 = 字号 × 0.352778 × 2.0（杜绝溢出红方块）
    - 三层字体应用：建空框时 / 写入文字后 / selectText 全选后
    - 水平居中 + 垂直居中 + 零边距
    - selectText 参数顺序：(start, count, name) 而非 (name, start, count)
    - 垂直居中失败时用 setTextDistances 手动补偿
    """
    first_item = None
    for entry in chars:
        ch, cx, cy, size_pt, name = entry[0], entry[1], entry[2], entry[3], entry[4]
        if ch is None or size_pt <= 0:
            continue  # 看不清的字（None）跳过，校对后再来

        box_mm = size_pt * MM_PER_PT * 2.0      # 文本框边长 = 字号的 2 倍
        x = mm(cx) - box_mm / 2.0               # 按中心定位
        y = mm(cy) - box_mm / 2.0
        item = scribus.createText(x, y, box_mm, box_mm, name)

        # 文本框样式：无填充、无描边、零线宽
        try:
            scribus.setFillColor("None", item)
            scribus.setLineColor("None", item)
            scribus.setLineWidth(0.0, item)
        except Exception as exc:
            if len(FONT_ERRORS) < 10:
                FONT_ERRORS.append("frame-style(%s): %s" % (item, exc))

        # 第 1 次字体应用：建空框时先指定字体
        apply_font(item, font)

        # 写入文字（用 setText 替换全部内容，比 insertText 更干净）
        try:
            scribus.setText(ch, item)
        except Exception:
            try:
                scribus.insertText(ch, 0, item)
            except Exception as exc:
                if len(FONT_ERRORS) < 10:
                    FONT_ERRORS.append("setText(%s): %s" % (item, exc))

        # 第 2 次字体应用：写入文字后再指定
        apply_font(item, font)

        # 第 3 次字体应用：全选文字后再指定（三道保险，防汉字落回西文字体）
        try:
            length = scribus.getTextLength(item)
            if length:
                scribus.selectText(0, length, item)  # selectText(start, count, name)
                apply_font(item, font)
        except Exception as exc:
            if len(FONT_ERRORS) < 10:
                FONT_ERRORS.append("select-font(%s): %s" % (item, exc))

        # 字号
        try:
            scribus.setFontSize(float(size_pt), item)
        except Exception as exc:
            if len(FONT_ERRORS) < 10:
                FONT_ERRORS.append("setFontSize(%s): %s" % (item, exc))

        # 文字颜色
        try:
            scribus.setTextColor(BLACK, item)
        except Exception:
            pass

        # 水平居中
        try:
            scribus.setTextAlignment(scribus.ALIGN_CENTERED, item)
        except Exception as exc:
            if len(FONT_ERRORS) < 10:
                FONT_ERRORS.append("align(%s): %s" % (item, exc))

        # 零边距（先清零，再尝试垂直居中）
        try:
            scribus.setTextDistances(0.0, 0.0, 0.0, 0.0, item)
        except Exception:
            pass

        # 垂直居中
        centered = False
        try:
            scribus.setTextVerticalAlignment(scribus.ALIGNV_CENTERED, item)
            centered = True
        except Exception:
            centered = False
        if not centered:
            # 旧版 API 无垂直居中 → 回退：用 setTextDistances 手动补偿
            try:
                line_mm = size_pt * MM_PER_PT * 1.2
                top = max(0.0, (box_mm - line_mm) / 2.0)
                scribus.setTextDistances(0.0, 0.0, top, 0.0, item)
            except Exception:
                pass

        if first_item is None:
            first_item = item
    return first_item

def place_background():
    """可选底图（半透明核对）。"""
    if not SOURCE_IMAGE_PATH:
        return
    try:
        img = scribus.createImage(0, 0, PAGE_WIDTH_MM, PAGE_HEIGHT_MM, "底图_原扫描件")
        scribus.loadImage(SOURCE_IMAGE_PATH, img)
        scribus.setScaleImageToFrame(True, True, img)
        try:
            scribus.setFillTransparency(SOURCE_IMAGE_OPACITY, img)
        except Exception:
            pass
        scribus.setLineColor("None", img)
        try:
            scribus.lowerToBottom(img)
        except Exception:
            pass
    except Exception as exc:
        FONT_ERRORS.append("background-image: %s" % exc)

# ===================== 7. main() 与结果弹窗 =====================
def main():
    font, all_fonts, go_on = resolve_font()
    if not go_on or not font:
        return

    scribus.setRedraw(False)
    try:
        if CLEAR_PAGE_FIRST:
            # 防新旧内容重叠：遍历删除当前页全部旧对象
            for obj in list(scribus.getAllObjects()):
                try:
                    scribus.deleteObject(obj)
                except Exception:
                    pass

        ensure_colors()
        place_background()

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
            except Exception as exc:
                FONT_ERRORS.append("getFont: %s" % exc)

        if AUTO_SAVE_SLA_PATH:
            try:
                scribus.saveDocAs(AUTO_SAVE_SLA_PATH)
            except Exception as exc:
                FONT_ERRORS.append("saveDocAs: %s" % exc)

        scribus.setRedraw(True)
        try:
            scribus.redrawAll()
        except Exception:
            pass
        try:
            scribus.docChanged(True)
        except Exception:
            pass

        err_text = "\\n".join(FONT_ERRORS[:20]) if FONT_ERRORS else "（无）"
        scribus.messageBox(
            "ZupuScript 执行完成",
            "重建完成。\\n\\n请求字体：%s\\n实际生效字体（getFont 反查）：%s\\n页数：%d  字符对象：%d\\n\\n异常记录（前 20 条）：\\n%s\\n\\n若实际字体与请求不符，请检查字体安装（为所有用户安装 + 重启 Scribus）。" % (font, actual_font, len(PAGES), total_chars, err_text),
            scribus.ICON_INFORMATION,
        )
    except Exception:
        scribus.setRedraw(True)
        raise

main()
`;
}
