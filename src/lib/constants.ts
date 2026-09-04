/**
 * 全局常量（共享约定见 docs/ARCHITECTURE.md 第 8 章）。
 * 所有跨模块硬约定只允许在此定义一次，禁止在别处复制字面量。
 */

export const APP_NAME = '族谱网';

/* ---------- 标定与换算（锁定，全链路不得改） ---------- */
/** 1 pt = 0.352778 mm */
export const MM_PER_PT = 0.352778;
/** 1 mm = 2.834645669 pt */
export const PT_PER_MM = 2.834645669;
/** 默认 DPI 归一目标（F2.5） */
export const DEFAULT_DPI = 200;
/** 默认像素/毫米基准（200dpi ≈ 7.874），预处理后会按实际 DPI 重写并锁定 */
export const DEFAULT_PX_PER_MM = DEFAULT_DPI / 25.4;
/** 文本框边长 = 字号 × MM_PER_PT × 2.0（血泪教训：放大框，绝不缩字号） */
export const TEXT_BOX_SCALE = 2.0;

/* ---------- 识别 ---------- */
/** 置信度阈值，低于即标红进低置信面板（F4.6） */
export const CONFIDENCE_THRESHOLD = 0.85;
/** B 模式每批最多字符数（F4.4）。
 * 由 100 调到 64：木刻版单字细节多，64 字/8×8 网格每字可分配像素翻倍，模型才能看清 */
export const GRID_BATCH_SIZE = 64;
/** 拼图网格列数（8×8 容纳 64 字） */
export const GRID_COLS = 8;
/** 单字小图归一尺寸（木刻版繁体笔画密、断笔多，192×192 给模型 50% 以上余裕） */
export const GRID_CELL_PX = 192;
/** 拼图单元格内字符绘制区边距（编号占位 + 四周留白） */
export const GRID_CELL_PAD = 20;
/** 二值裁剪后形态学闭运算核半径（像素，修木刻断笔；0 = 关闭） */
export const GRID_CLOSE_RADIUS = 1;
/** 拼图编号字体（像素，单元格放大后同步加大以便模型读号） */
export const GRID_LABEL_FONT_PX = 16;
/** 大模型并发上限（F4.2 / F11.4） */
export const MAX_CONCURRENCY = 5;
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_RETRIES = 3;
/** 单页成本上限默认值（元，F4.10） */
export const DEFAULT_PAGE_BUDGET_CNY = 0.5;
export const DEFAULT_PROJECT_BUDGET_CNY = 20;

/* ---------- 识别后处理（字典消歧） ---------- */
/** 命中姓氏/高频词字典且置信度略低于阈值时，抬升到的置信度（免人工标红） */
export const DICT_HIT_CONF = 0.86;
/** conf 极低但 candidates 首候选在字典中时，采用候选并置的置信度（仍标红待人工） */
export const DICT_CANDIDATE_CONF = 0.8;
/** 视为「极低置信」的上限：低于此值才考虑采用 candidates 首候选 */
export const DICT_LOW_CONF_MAX = 0.5;
/** 竖排列尾结构字：人名「公」、妻名「氏」。补位与同形传播不得跨语义复制 */
export const COLUMN_END_STRUCTURAL_CHARS = ['氏', '公'] as const;
/** 大模型 max_tokens 动态系数（约每字 40 token，防整批 JSON 截断） */
export const TOKENS_PER_CHAR = 40;

/* ---------- 图像算法参数 ---------- */
/** 自动去斜搜索范围 ±5°（F2.2） */
export const DESKEW_RANGE_DEG = 5;
/** 形态学横核/纵核长度（F3.1/F3.2/F3.3） */
export const KERNEL_H_LEN = 80;
export const KERNEL_V_LEN = 80;
export const KERNEL_LINE_V_LEN = 40;
/** 谱系线最小长度（像素） */
export const MIN_LINE_LEN = 40;
/** 字符包围盒合理范围（像素，过滤噪声与超大块） */
export const CHAR_MIN_SIZE = 6;
export const CHAR_MAX_SIZE = 400;
/** 小连通域最小面积（字符分割） */
export const CHAR_MIN_AREA = 20;
/** 字号聚类相对容差 15%（PDF S7.1） */
export const FONT_CLUSTER_REL_TOL = 0.15;
/** 粘连拆分：相对典型字面积阈值（PDF S1.2） */
export const CHAR_SPLIT_REL_AREA = 1.6;
/** 断裂合并：合并后相对面积上限（PDF S1.3） */
export const CHAR_MERGE_REL_AREA_MAX = 1.4;
/** 断裂合并：次要方向重合度下限（PDF S1.3） */
export const CHAR_MERGE_OVERLAP_MIN = 0.6;
/** 断裂合并：主方向最大间隙 = 字宽 × 此系数（PDF S1.3） */
export const CHAR_MERGE_GAP_FACTOR = 0.25;
/** 版面视觉分析上传图最长边（降低 429 与超时概率） */
export const LAYOUT_VISION_MAX_EDGE = 1280;
/** C 模式整页上行最长边（兼顾小字可读性与 API 体积） */
export const PAGE_RECOGNITION_MAX_EDGE = 2048;
/** 版面视觉 429 后本会话暂停时长（毫秒） */
export const LAYOUT_VISION_RATE_LIMIT_COOLDOWN_MS = 5 * 60_000;

/** 页边正文区推断：外框条带外视为页边 */
export const MARGIN_EDGE_STRIP_RATIO = 0.14;
/** 正文区内缩，避免误删贴框字 */
export const MARGIN_CONTENT_INSET_RATIO = 0.012;
/** 中值滤波半径 */
export const MEDIAN_RADIUS = 1;
/** 小连通域剔除的最小面积 */
export const DENOISE_MIN_AREA = 8;
/** 空白页判定：降采样后墨迹像素占比低于此值则视为空白（0.15%） */
export const BLANK_PAGE_MAX_INK_RATIO = 0.0015;
/** 空白页检测：亮度低于此灰度值计为墨迹 */
export const BLANK_PAGE_DARK_THRESHOLD = 240;
/** 空白页检测降采样最长边（像素） */
export const BLANK_PAGE_PROBE_MAX_EDGE = 256;
/** PDF 本地拆页渲染 DPI（矢量页框约 1pt，450 DPI 下约 6px，配合边缘检测可稳定识别） */
export const PDF_RENDER_DPI = 450;
/** PDF/矢量源二值化后笔画加粗半径（连接 anti-alias 断点，0=关闭） */
export const PDF_STROKE_DILATE_RADIUS = 4;
/** PDF 字符分割用二值图：小连通域剔除下限（高于扫描图，抑制矢量渲染噪点） */
export const PDF_SEGMENT_DENOISE_MIN_AREA = 22;
/** 节点圆扫描半径范围 */
export const NODE_R_MIN = 6;
export const NODE_R_MAX = 28;

/* ---------- 存储键名 ---------- */
export const DB_NAME = 'zupuscript-web';
export const DB_VERSION = 2;
export const STORE_PROJECTS = 'projects';
export const STORE_PAGES = 'pages';
export const STORE_UNDO = 'undoStacks';
export const STORE_AUDIT = 'auditLogs';
export const STORE_CACHE = 'recognizeCache';
export const STORE_BLOBS = 'blobs';
export const STORE_KEYSTORE = 'keystore';
export const STORE_RECOGNITION_MEMORY = 'recognitionMemory';
/** OPFS 图像目录名 */
export const OPFS_IMAGE_DIR = 'images';

/* ---------- 编辑 ---------- */
/** 撤销栈深度（F6.7，≥100） */
export const UNDO_LIMIT = 100;
/** 审计日志保留天数（仅存本地） */
export const AUDIT_RETENTION_DAYS = 30;

/* ---------- 生成脚本默认字体名单（PRD 8.8 推荐优先级） ---------- */
export const PREFERRED_FONTS: readonly string[] = [
  'Noto Serif CJK TC Regular',
  'Source Han Serif TC Regular',
  'MingLiU Regular',
  'PMingLiU Regular',
  'SimSun Regular',
] as const;

/** 强制全本地模式的 URL 参数（P1.7）：?local=1 */
export const FORCE_LOCAL_PARAM = 'local';
