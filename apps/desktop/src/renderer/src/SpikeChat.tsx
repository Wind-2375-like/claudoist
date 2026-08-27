import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * M1 临时聊天界面:验证流式输出与图片粘贴。
 * 正式面板(会话列表、权限弹窗、工具 chip、模型切换)在 M8–M10。
 */

interface ChatImage {
  data: string;
  mediaType: string;
}

interface ChatItem {
  role: 'user' | 'assistant' | 'meta' | 'error';
  text: string;
  imageCount?: number;
}

interface StreamEvent {
  type?: string;
  message?: string;
  event?: { type?: string; delta?: { type?: string; text?: string } };
  subtype?: string;
  session_id?: string;
  model?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  duration_ms?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function SpikeChat(): React.JSX.Element {
  const [items, setItems] = useState<ChatItem[]>([
    { role: 'meta', text: 'M1 spike:验证打包内 SDK 会话。可粘贴图片。' },
  ]);
  const [draft, setDraft] = useState('');
  const [images, setImages] = useState<ChatImage[]>([]);
  const [busy, setBusy] = useState(false);
  const streamBuf = useRef('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const flushAssistant = useCallback((finalize: boolean) => {
    const text = streamBuf.current;
    setItems((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last && last.role === 'assistant') {
        next[next.length - 1] = { role: 'assistant', text };
      } else if (text) {
        next.push({ role: 'assistant', text });
      }
      return next;
    });
    if (finalize) streamBuf.current = '';
  }, []);

  useEffect(() => {
    return window.agent.onStream((raw) => {
      const msg = raw as StreamEvent;
      if (msg.type === 'stream_event') {
        const ev = msg.event;
        if (
          ev?.type === 'content_block_delta' &&
          ev.delta?.type === 'text_delta' &&
          ev.delta.text
        ) {
          streamBuf.current += ev.delta.text;
          flushAssistant(false);
        }
      } else if (msg.type === 'system' && msg.subtype === 'init') {
        setItems((p) => [
          ...p,
          { role: 'meta', text: `session ${msg.session_id?.slice(0, 8)} · ${msg.model ?? ''}` },
        ]);
      } else if (msg.type === 'result') {
        flushAssistant(true);
        setBusy(false);
        const tokens = msg.usage
          ? `${msg.usage.input_tokens ?? 0}→${msg.usage.output_tokens ?? 0} tok`
          : '';
        setItems((p) => [
          ...p,
          {
            role: msg.is_error ? 'error' : 'meta',
            text: `${msg.is_error ? '出错' : '完成'} · ${((msg.duration_ms ?? 0) / 1000).toFixed(1)}s · ${tokens} · $${(msg.total_cost_usd ?? 0).toFixed(4)}`,
          },
        ]);
      } else if (msg.type === 'spike_error') {
        flushAssistant(true);
        setBusy(false);
        setItems((p) => [...p, { role: 'error', text: msg.message ?? 'unknown error' }]);
      }
    });
  }, [flushAssistant]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items]);

  const onPaste = useCallback((e: React.ClipboardEvent) => {
    for (const item of e.clipboardData.items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = () => {
          const url = String(reader.result);
          const comma = url.indexOf(',');
          setImages((prev) => [...prev, { data: url.slice(comma + 1), mediaType: item.type }]);
        };
        reader.readAsDataURL(file);
      }
    }
  }, []);

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    streamBuf.current = '';
    setItems((p) => [...p, { role: 'user', text, imageCount: images.length }]);
    void window.agent.send(text, images);
    setDraft('');
    setImages([]);
  }, [draft, images, busy]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3 text-sm">
        {items.map((item, i) => (
          <div key={i}>
            {item.role === 'user' && (
              <div className="ml-8 rounded-lg bg-blue-600 px-3 py-2 whitespace-pre-wrap text-white">
                {item.text}
                {item.imageCount ? (
                  <span className="ml-2 text-xs opacity-75">[{item.imageCount} 图]</span>
                ) : null}
              </div>
            )}
            {item.role === 'assistant' && (
              <div className="mr-8 rounded-lg bg-neutral-800 px-3 py-2 whitespace-pre-wrap text-neutral-100">
                {item.text}
              </div>
            )}
            {item.role === 'meta' && (
              <div className="text-center text-xs text-neutral-500">{item.text}</div>
            )}
            {item.role === 'error' && (
              <div className="rounded-lg border border-red-800 bg-red-950 px-3 py-2 text-red-300">
                {item.text}
              </div>
            )}
          </div>
        ))}
        {busy && <div className="text-center text-xs text-neutral-500">思考中…</div>}
      </div>
      {images.length > 0 && (
        <div className="flex gap-2 px-4 pb-1">
          {images.map((img, i) => (
            <div key={i} className="relative">
              <img
                src={`data:${img.mediaType};base64,${img.data}`}
                className="h-12 w-12 rounded border border-neutral-600 object-cover"
              />
              <button
                type="button"
                className="absolute -top-1 -right-1 h-4 w-4 rounded-full bg-neutral-700 text-[10px] leading-none text-white"
                onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="border-t border-neutral-700 p-3">
        <textarea
          className="w-full resize-none rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 outline-none placeholder:text-neutral-500"
          rows={2}
          placeholder="给 Claude 发消息…(Enter 发送,可粘贴图片)"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="mt-1 flex justify-between text-xs text-neutral-500">
          <span>{busy ? '生成中…' : 'M1 临时界面'}</span>
          {busy ? (
            <button
              type="button"
              className="text-red-400"
              onClick={() => void window.agent.interrupt()}
            >
              中断
            </button>
          ) : (
            <button type="button" className="text-blue-400" onClick={send}>
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
