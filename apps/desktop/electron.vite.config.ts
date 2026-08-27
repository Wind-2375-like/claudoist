import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  main: {
    // workspace 包以 TS 源码消费,必须打进 bundle(不能 externalize);
    // node:sqlite 是内置模块,天然 external。
    plugins: [externalizeDepsPlugin({ exclude: ['@gtd/domain', '@gtd/storage-sqlite'] })],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react(), tailwindcss()],
  },
});
