import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';

// ZupuScript Web 构建配置：
// - React + 原生 ESM Web Worker（Comlink）
// - PWA（Workbox），manifest 使用 public/manifest.webmanifest
// - 首屏 ≤3MB：OpenCV.js / Tesseract.js / pdfjs 均按需动态加载
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      manifest: false, // 使用 public/manifest.webmanifest，避免重复生成
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // OpenCV.js 为可选懒加载增强（10MB+），不进预缓存；用到时由运行时缓存处理
        globIgnores: ['**/opencv-*.js'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallback: 'index.html',
        runtimeCaching: [
          {
            urlPattern: /\/assets\/opencv-.*\.js$/,
            handler: 'CacheFirst',
            options: { cacheName: 'opencv-lazy' },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          pdfjs: ['pdfjs-dist'],
        },
      },
    },
  },
  optimizeDeps: {
    // tesseract.js 是纯 CommonJS（顶部 require('regenerator-runtime/runtime')），必须纳入预打包
    // 让 Vite 转成 ESM 兼容代码后才能在浏览器 Worker 中 dynamic import
    include: ['tesseract.js'],
    // OpenCV.js / opencc-js 为可选懒加载增强（OpenCV 10MB+、opencc 全量字典），不进预缓存也不预打包
    exclude: ['@techstark/opencv-js', 'opencc-js'],
  },
});
