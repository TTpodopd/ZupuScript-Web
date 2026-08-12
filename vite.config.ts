import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { fileURLToPath, URL } from 'node:url';

// ZupuScript Web 构建配置：
// - React + 原生 ESM Web Worker（Comlink）
// - PWA（Workbox），manifest 使用 public/manifest.webmanifest
// - 首屏 ≤3MB：OpenCV.js / Tesseract.js / pdfjs 均按需动态加载
export default defineConfig({
  plugins: [
    react(),
    viteStaticCopy({
      targets: [
        { src: 'node_modules/tesseract.js/dist/worker.min.js', dest: 'tesseract' },
        { src: 'node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js', dest: 'tesseract/core' },
        { src: 'node_modules/tesseract.js-core/tesseract-core-lstm.wasm', dest: 'tesseract/core' },
        { src: 'node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js', dest: 'tesseract/core' },
        { src: 'node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm', dest: 'tesseract/core' },
        { src: 'node_modules/@tesseract.js-data/chi_tra/4.0.0_best_int/chi_tra.traineddata.gz', dest: 'tesseract/tessdata' },
        { src: 'node_modules/@tesseract.js-data/chi_tra_vert/4.0.0_best_int/chi_tra_vert.traineddata.gz', dest: 'tesseract/tessdata' },
      ],
    }),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      manifest: false, // 使用 public/manifest.webmanifest，避免重复生成
      workbox: {
        globPatterns: ['**/*.{js,wasm,gz,css,html,svg,png,woff2}'],
        // OpenCV.js 为可选懒加载增强（10MB+），不进预缓存；用到时由运行时缓存处理
        globIgnores: ['**/opencv-*.js'],
        // 本地 A 模式需要离线使用 Tesseract runtime 与繁体中文训练数据。
        maximumFileSizeToCacheInBytes: 32 * 1024 * 1024,
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
    // tesseract.js 由 ocr.worker.ts 静态 import，整个包打进 worker bundle（不进首屏预缓存）
    // OpenCV.js / opencc-js 为可选懒加载增强（OpenCV 10MB+、opencc 全量字典），不进预缓存也不预打包
    exclude: ['@techstark/opencv-js', 'opencc-js'],
  },
});
