/**
 * 全局常量（共享约定见 docs/ARCHITECTURE.md 第 8 章）。
 * 所有跨模块硬约定只允许在此定义一次，禁止在别处复制字面量。
 */

export const APP_NAME = 'ZupuScript Web';

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
/** B 模式每批最多字符数（F4.4） */
export const GRID_BATCH_SIZE = 100;
/** 拼图网格列数（10×10） */
export const GRID_COLS = 10;
/** 单字小图归一尺寸（成本控制：64×64 够用即可） */
export const GRID_CELL_PX = 64;
/** 大模型并发上限（F4.2 / F11.4） */
export const MAX_CONCURRENCY = 5;
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_RETRIES = 3;
/** 单页成本上限默认值（元，F4.10） */
export const DEFAULT_PAGE_BUDGET_CNY = 0.5;
export const DEFAULT_PROJECT_BUDGET_CNY = 20;

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
export const CHAR_MIN_AREA = 20;
/** 中值滤波半径 */
export const MEDIAN_RADIUS = 1;
/** 小连通域剔除的最小面积 */
export const DENOISE_MIN_AREA = 8;
/** 节点圆扫描半径范围 */
export const NODE_R_MIN = 6;
export const NODE_R_MAX = 28;

/* ---------- 存储键名 ---------- */
export const DB_NAME = 'zupuscript-web';
export const DB_VERSION = 1;
export const STORE_PROJECTS = 'projects';
export const STORE_PAGES = 'pages';
export const STORE_UNDO = 'undoStacks';
export const STORE_AUDIT = 'auditLogs';
export const STORE_CACHE = 'recognizeCache';
export const STORE_BLOBS = 'blobs';
export const STORE_KEYSTORE = 'keystore';
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
