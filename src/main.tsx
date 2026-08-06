import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// 入口：挂载 App。Service Worker 由 vite-plugin-pwa 的 injectRegister 自动注册。
const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('找不到 #root 挂载点');
}

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
