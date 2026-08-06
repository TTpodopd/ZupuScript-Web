# ZupuScript Web — 族谱图像转 Scribus 脚本工具

> 打开网页就能用的**零安装**工具：拖入族谱扫描图或 PDF，在浏览器内完成版面分析，调用大模型识别文字，校对后导出一份可直接在 **Scribus 1.6.6** 中执行的 Python 脚本。图像与项目数据**全程留在本地，无服务器存储**。

| | |
| --- | --- |
| 版本 | 2.0.0（Web 版，由 v1.0 桌面 exe 方案重构而来） |
| 形态 | 纯前端静态 SPA / PWA，访问链接即用 |
| 后端 | 无业务后端（仅可选的无状态 Edge 代理用于跨域中转） |
| 识别 | 多模态大模型（BYOK 自带密钥）+ WASM OCR 本地兜底 |
| 数据存储 | OPFS / IndexedDB / File System Access API，均在用户本机 |
| 配套软件 | Scribus 1.6.6（Python 3 Scripter） |

---

## ✨ 功能特性

- **本地图像处理管线**：投影法去斜、Otsu/Sauvola 二值化、中值去噪、形态学开运算、连通域字符分割（纯 JS 实现，Web Worker 不卡 UI；OpenCV.js 懒加载可选增强）
- **三级隐私模式**：
  - **A 模式** — 全本地：Tesseract.js 繁体 OCR，不出网
  - **B 模式（默认）** — 拼图上云：字符打乱拼成编号网格图再上传，模型看不到版面
  - **C 模式** — 整页上云：识别精度最高，原图上云
- **多厂商识别**：Gemini / OpenAI / Anthropic / 自定义 OpenAI 兼容端点（百炼、智谱、DeepSeek、Ollama…），密钥 AES-GCM 加密、绝不落盘
- **Canvas 校对台**：双栏联动、撤销/重做（100 步、刷新可恢复）、低置信面板、字号标定
- **Scribus 脚本生成**：内建 1.6.6 全部规避逻辑（`haveDoc()` 检查、`CLEAR_PAGE_FIRST`、三层字体解析、`setFont` 三次应用、`getFont()` 反查），导出前 lint 自检，另附 4 个辅助脚本

---

## 🚀 快速开始

### 环境要求

| 项 | 要求 |
| --- | --- |
| Node.js | ≥ 18（推荐 20+，本项目开发于 Node 22） |
| npm | ≥ 9 |
| 浏览器 | Chrome/Edge 119+（需 `Promise.withResolvers`、OPFS、File System Access） |
| Scribus（仅导出后使用） | 1.6.6 且启用 Python Scripter |

### 安装与运行

```bash
# 1. 安装依赖
npm install

# 2. 本地开发（热更新，默认 http://localhost:5173）
npm run dev
```

### 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动开发服务器 |
| `npm run build` | 生产构建，产物在 `dist/` |
| `npm run preview` | 本地预览生产构建产物 |
| `npm run typecheck` | TypeScript 类型检查（`tsc --noEmit`） |

---

## 🏗️ 部署

本项目为**纯静态站点**，`npm run build` 后把 `dist/` 目录丢到任意静态托管即可，**无需服务器**：

```bash
npm run build          # 生成 dist/
```

适配的托管平台（任选其一）：

| 平台 | 说明 |
| --- | --- |
| 任意 Nginx / Caddy / Apache | 把 `dist/` 指向网站根目录；SPA 需配置 fallback 到 `index.html` |
| GitHub Pages | 用 `actions/upload-pages-artifact` 上传 `dist/`；注意若部署到子路径需设 `vite.config.ts` 的 `base` |
| Vercel / Netlify / Cloudflare Pages | 构建命令 `npm run build`，输出目录 `dist` |
| 局域网 / 本机直开 | `npm run preview` 或任意静态服务器（如 `npx serve dist`） |

### 部署注意事项

1. **必须 HTTPS（或 localhost）**：PWA Service Worker、OPFS、File System Access API 均要求安全上下文。
2. **PWA 缓存策略**（`vite.config.ts` 已配好）：
   - 首屏预缓存 js/css/html/svg/png/woff2；
   - OpenCV.js（约 10MB）**不进预缓存**，用到时由 Workbox 运行时 `CacheFirst` 缓存，避免首屏膨胀；
   - `navigateFallback: index.html` 已支持 SPA 路由回退。
3. **`manifest`**：使用 `public/manifest.webmanifest`，构建时 `VitePWA({ manifest: false })` 避免重复生成，勿改动。
4. **Worker**：`build.worker.format: 'es'`，Vite 5 原生 ESM Worker，无需额外配置。

---

## 🗂️ 项目结构

```
ZupuScript Web/
├── index.html                     # 入口 HTML
├── vite.config.ts                 # Vite + PWA + Worker 配置
├── tailwind.config.ts             # Tailwind 配置
├── public/
│   └── manifest.webmanifest       # PWA 清单
├── docs/
│   ├── PRD-v2.0.md                # 产品需求文档（PDF 转 Markdown）
│   ├── ARCHITECTURE.md            # 架构设计 + 任务分解
│   ├── TEST-REPORT.md             # QA 测试报告（159/159 通过）
│   ├── class-diagram.mermaid      # 类图
│   └── sequence-diagram.mermaid   # 时序图
├── tests/                         # 5 个测试套件（node --experimental-strip-types 可跑）
└── src/
    ├── main.tsx / App.tsx         # 入口与顶层视图切换
    ├── model/                     # 类型定义 + .zpproj.json 序列化
    ├── store/                     # Zustand 状态（项目/编辑器撤销栈/设置）
    ├── storage/                   # idb / OPFS / File System Access
    ├── privacy/                   # 隐私模式 A/B/C + AES-GCM 密钥 + 审计日志
    ├── workers/                   # pipeline.worker（预处理/分析/分割）+ ocr.worker
    ├── imaging/                   # 预处理算法（纯 JS）+ OpenCV 懒加载
    ├── layout/                    # 外框/连线/节点/装饰块检测
    ├── segment/                   # 字符分割 + 拼图分批（≤100 字/批，编号打乱）
    ├── recognize/                 # 唯一出网点 orchestrator + Provider + Tesseract 兜底
    ├── calibrate/                 # px→mm、字高→pt、字号聚类
    ├── generator/                 # Python 脚本生成（七段结构 + Scribus 规避逻辑）+ lint + 导出
    ├── verify/                    # 重建预览 + 红蓝黑叠加 IoU 报告（P1）
    └── ui/                        # 页面组件 + shadcn 风格轻量基元
```

---

## 🔑 识别配置（BYOK）

首次识别前需在 **设置** 面板中配置：

1. **选择 Provider**：Gemini（推荐，CORS 友好）/ OpenAI / Anthropic / 自定义端点
2. **填入 API Key**：密钥经 Web Crypto **AES-GCM 加密后存 IndexedDB**，支持「仅会话」（关页即毁），**绝不写入项目文件 `.zpproj.json`**
3. **选择隐私模式**：A 全本地 / B 拼图上云（默认）/ C 整页上云
4. （可选）自定义端点可填**无状态 Edge 代理 URL**解决跨域

> 💡 全应用**唯一的网络出网点**是 `src/recognize/orchestrator.ts`，隐私审计日志可在设置中查看（30 天）。加 URL 参数 `?local=1` 可强制全本地模式。

---

## 📦 生成与使用 Scribus 脚本

1. 校对完成后进入 **导出** 页，预览脚本并确认 lint 通过
2. 选择导出方式：直接下载 `.py` / JSZip 打包（含 4 个辅助脚本）/ File System Access 直写目录
3. 打开 **Scribus 1.6.6** → 菜单「**编辑 → 脚本**」打开脚本执行器（或在「脚本控制台」中）
4. 运行生成的 `.py`，脚本会自动创建文本框、连线、节点等版面元素

> 生成的脚本已内建 Scribus 1.6.6 的全部已知坑规避逻辑（`haveDoc()` 检查、`CLEAR_PAGE_FIRST` 清页、三层字体解析、`setFont` 三次应用、`getFont()` 反查弹窗），文本框尺寸 = 字号 × 2，无需手动调整。

---

## 🧪 测试

```bash
# 运行全部测试套件（无需单测框架，直接可执行）
node --experimental-strip-types tests/generator.test.mjs
node --experimental-strip-types tests/calibrate.test.mjs
node --experimental-strip-types tests/zpproj.test.mjs
node --experimental-strip-types tests/grid.test.mjs
node --experimental-strip-types tests/preprocess.test.mjs
```

当前状态：**159 / 159 通过**（详见 `docs/TEST-REPORT.md`）。

---

## 🛠️ 技术栈

| 层 | 选型 |
| --- | --- |
| 构建 | Vite 5 + TypeScript 5（strict） |
| UI | React 18 + Zustand 5 + Tailwind 3 + shadcn 风格基元 |
| Worker | 原生 ESM Worker + Comlink |
| 图像 | 纯 JS 算法 + OpenCV.js 懒加载增强 |
| PDF | pdfjs-dist 4.x |
| 存储 | idb + OPFS + File System Access API |
| 识别 | fetch 直调 + Tesseract.js 5 兜底 |
| 打包/离线 | JSZip + vite-plugin-pwa（Workbox） |

---

## ⚠️ 已知限制

1. OpenCV.js 增强算法未启用（纯 JS 已达 P0），仅提供懒加载骨架
2. 双模型交叉验证仅预留 `orchestrator.crossValidate()` 接口，无 UI
3. 装饰块内部白色图形在生成脚本中以实心黑块近似，需 Scribus 内微调
4. TIFF 导入依赖浏览器解码，不支持时提示转 PNG
5. 批处理为本地分析顺序极简版（不含云端识别批跑）

---

## 📄 文档索引

| 文档 | 内容 |
| --- | --- |
| `docs/PRD-v2.0.md` | 完整产品需求 |
| `docs/ARCHITECTURE.md` | 架构设计、文件清单、类型契约、任务分解 |
| `docs/TEST-REPORT.md` | QA 测试报告 |
| `docs/sequence-diagram.mermaid` | 主流程时序图 |

---

## 📜 许可

内部项目。图像与项目数据全程留在本地，不上传任何服务器（除用户主动选择的云端识别）。
