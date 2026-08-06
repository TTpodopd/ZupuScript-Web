# ZupuScript Web — 交付总览

## TL;DR
基于 PRD v2.0 完成「族谱图像转 Scribus 脚本工具」纯前端 Web 应用开发：57 个源文件 + 7 个配置 + 6 个测试套件，TypeScript 严格模式 0 错误，构建成功，QA 159/159 测试通过。

## 交付状态
| 阶段 | 负责 | 结果 |
| --- | --- | --- |
| PRD 解析存档 | 主理人 | `docs/PRD-v2.0.md`（PDF→Markdown） |
| 架构设计 | 高见远 | `docs/ARCHITECTURE.md` + 类图/时序图，66 文件清单、5 任务分解 |
| 代码实现 | 寇豆码 | 62 文件，`tsc --noEmit` 0 error，`vite build` 成功，IS_PASS: YES（一轮通过） |
| 测试验证 | 严过关 | 159/159 通过，ROUTE: NoOne，`docs/TEST-REPORT.md` |

## 关键实现
- **纯前端零后端**：Vite 5 + React 18 + TypeScript strict + Zustand + Tailwind + PWA，数据全部本地（OPFS/IndexedDB）
- **本地分析管线**：纯 JS 投影去斜 / Otsu+Sauvola / 形态学开运算 / 连通域分割，Web Worker + Comlink；OpenCV.js 懒加载可选增强
- **识别层**：唯一出网点 orchestrator（≤100字/批、并发≤5、指数退避、数量守恒校验、失败降级 Tesseract）；Gemini/OpenAI/Anthropic/custom 四 Provider；三级隐私模式 A/B/C，密钥 AES-GCM
- **生成器**（最高风险模块）：七段结构 + haveDoc/CLEAR_PAGE_FIRST/三层字体解析/setFont 三次/getFont 反查，文本框=字号2倍，导出前 lint 自检，4 个辅助脚本
- **校对台**：Canvas 双栏联动、EditCommand 撤销栈（栈深 100、idb 持久）、低置信面板

## 已知遗留（不阻塞）
1. calibrate 聚类未排除 side 字，边栏字偏小时会抢占最小组语义（建议后续过滤）
2. CI/沙箱环境 build 需预授权清空 dist
3. 拼图像素级效果建议浏览器端目检一次
4. OpenCV 增强算法未启用（纯 JS 已达 P0）；双模型交叉验证仅接口预留；装饰块内部白图形以实心黑块近似

## 下一步建议
1. `npm run dev` 本地启动，导入一张族谱扫描图走完整流程
2. 在设置中填入 Gemini API Key（BYOK）实测 B 模式识别
3. 导出的 .py 在 Scribus 1.6.6「脚本控制台」实跑一次
4. 目检拼图预览与校对台渲染效果
5. 后续迭代：side 字聚类过滤、OpenCV 增强、双模型交叉验证 UI
