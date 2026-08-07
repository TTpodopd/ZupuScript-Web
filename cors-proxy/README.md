# ZupuScript CORS 代理 Cloudflare Worker

浏览器从本地 / 自部署站点直连阿里百炼、智谱等国内 API 时，浏览器 CORS 预检会拦截请求。本 Worker 透传请求并补 CORS 头，让浏览器能直连。

## 部署步骤（5 分钟）

### 方法 1：网页部署（最快，0 安装）

1. 打开 https://dash.cloudflare.com → Workers & Pages → Create
2. 选 "Hello World" 模板 → 给 Worker 起名（如 `zupuscript-cors-proxy`）
3. 把 `worker.js` 内容完整粘贴进编辑器 → Save and Deploy
4. 复制 Worker URL（形如 `https://zupuscript-cors-proxy.<你的子域>.workers.dev`）
5. 在 ZupuScript 设置面板「可选代理 URL」粘贴该 URL

### 方法 2：Wrangler CLI 部署

```bash
# 安装 wrangler
npm install -g wrangler

# 登录 Cloudflare
wrangler login

# 进入本目录部署
cd cors-proxy
wrangler deploy

# 部署后会输出 Worker URL，复制到 ZupuScript 设置面板
```

## 配置 ZupuScript

在「分析」页识别面板或「设置」对话框中：

| 字段 | 填什么 |
|---|---|
| Provider | 自定义 / 国内厂商 |
| **Endpoint URL** | 百炼原地址（如 `https://dashscope.aliyuncs.com/compatible-mode`） |
| **可选代理 URL** | 你的 Worker URL（如 `https://zupuscript-cors-proxy.xxx.workers.dev`） |
| Model | `qwen-vl-max`（百炼视觉模型） |
| API Key | 你的百炼 API Key |

代码会自动用「代理 URL」替换「Endpoint 域名」发起请求，Worker 转发到百炼并补 CORS 头。

## 工作原理

```
浏览器 fetch
  → https://zupuscript-cors-proxy.xxx.workers.dev/?target=https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
  → Worker 收到后 fetch 百炼真实地址
  → 百炼返回结果
  → Worker 补 Access-Control-Allow-* 头后返回给浏览器
  → 浏览器通过 CORS 预检，识别成功
```

## 安全

- Worker **不存储任何密钥**，Authorization 头由浏览器 BYOK 透传
- Worker 只做转发 + 补 CORS 头，不解析不修改请求体
- 如需限制来源防止被他人滥用，编辑 `worker.js` 中 `ALLOWED_ORIGINS` 改为你的站点域名

## 免费额度

Cloudflare Workers 免费版每天 10 万次请求——按每页约 4 批拼图算，每天可识别约 2.5 万页族谱，足够日常使用。
