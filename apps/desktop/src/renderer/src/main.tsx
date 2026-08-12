import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { toast } from './toast';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: true } },
});

// 任何来源的数据变更(M5 起 UI 写入、M9 起 agent 写入)→ 全量缓存失效
//
// actor='agent' 时额外弹一条 toast:中间栏突然多出一行、少掉一行,用户必须知道是谁干的。
// 连续多次写入合并成一条(agent 一轮里可能改好几处),否则 toast 会刷屏。
let agentWrites = 0;
let agentTimer: ReturnType<typeof setTimeout> | null = null;
window.gtd.onChanged((ev) => {
  void queryClient.invalidateQueries();
  if (ev.actor !== 'agent') return;
  agentWrites += 1;
  if (agentTimer !== null) clearTimeout(agentTimer);
  agentTimer = setTimeout(() => {
    toast(`Claude 改动了数据(${String(agentWrites)} 次写入)`);
    agentWrites = 0;
    agentTimer = null;
  }, 800);
});

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');
createRoot(container).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
