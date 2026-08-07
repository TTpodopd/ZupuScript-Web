/**
 * ZupuScript Web — CORS 代理 Cloudflare Worker
 *
 * 用途：浏览器从 localhost / 自部署站点直连阿里百炼 / 智谱等国内 API 时
 *       被浏览器 CORS 预检拦截，本 Worker 透传请求并补 CORS 头。
 *
 * 用法：
 *   1. 部署到 Cloudflare Workers（免费额度 10 万次/天够用）
 *   2. 在 ZupuScript 设置面板「可选代理 URL」填入：
 *      https://<你的-worker名>.<你的子域>.workers.dev
 *   3. 设置面板「Endpoint URL」仍填百炼原地址（如 https://dashscope.aliyuncs.com/compatible-mode）
 *      ——代码会自动用 proxyUrl 替换 endpoint 域名发起请求
 *
 * 安全：Worker 不存储密钥，Authorization 头由浏览器端 BYOK 透传。
 *       如需限制来源，在 ALLOWED_ORIGINS 加你的站点域名。
 */

// 允许的来源（* = 所有；生产建议填你的站点域名以防滥用）
const ALLOWED_ORIGINS = '*'; // 或 ['https://your-site.com', 'http://localhost:5173']

// CORS 响应头
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGINS,
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  'Access-Control-Max-Age': '86400',
  'Access-Control-Allow-Credentials': 'true',
};

export default {
  async fetch(request, env, ctx) {
    // 1) 预检请求直接返回
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // 2) 从路径取目标 URL
    //    调用方式：https://<worker>/https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
    //    或：      https://<worker>/?target=https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
    const url = new URL(request.url);
    let targetUrl = url.searchParams.get('target');

    if (!targetUrl) {
      // 路径前缀模式：/<完整目标URL>
      const pathPart = url.pathname.slice(1); // 去掉前导 /
      if (pathPart.startsWith('http://') || pathPart.startsWith('https://')) {
        targetUrl = decodeURIComponent(pathPart) + url.search.replace('?', '&').replace(/^&/, '?').replace(/^\?$/, '');
        // 上面拼装太复杂，简化：直接用原始 path + search
        targetUrl = decodeURIComponent(pathPart) + url.search;
      }
    }

    if (!targetUrl) {
      return new Response(
        JSON.stringify({
          error: 'missing target URL',
          usage: 'GET https://<worker>/?target=https://api.example.com/v1/chat/completions',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } },
      );
    }

    // 3) 构造转发请求
    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.delete('cf-');
    headers.delete('cdn-');
    // 保留 Authorization（BYOK 密钥）、Content-Type 等

    const init = {
      method: request.method,
      headers,
      redirect: 'follow',
    };

    // GET / HEAD 不带 body；POST/PUT 透传 body
    if (!['GET', 'HEAD'].includes(request.method)) {
      init.body = request.body;
    }

    // 4) 发起上游请求
    try {
      const upstream = await fetch(targetUrl, init);

      // 5) 复制上游响应头 + 追加 CORS 头
      const respHeaders = new Headers(upstream.headers);
      for (const [k, v] of Object.entries(CORS_HEADERS)) {
        respHeaders.set(k, v);
      }

      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: respHeaders,
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: 'upstream fetch failed', detail: String(err) }),
        { status: 502, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } },
      );
    }
  },
};
