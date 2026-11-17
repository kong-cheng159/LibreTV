'use client';

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/**
 * 下载管理 UI 挂载点：/downloads 页提供 DOM 锚点，
 * GlobalDownloadManager 把同一套运行时面板 portal 进去，避免双实例抢事件。
 */
interface DownloadSlotValue {
  slot: HTMLElement | null;
  setSlot: (node: HTMLElement | null) => void;
}

const DownloadSlotContext = createContext<DownloadSlotValue>({
  slot: null,
  setSlot: () => {},
});

export function DownloadSlotProvider({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const value = useMemo(() => ({ slot, setSlot }), [slot]);
  return <DownloadSlotContext.Provider value={value}>{children}</DownloadSlotContext.Provider>;
}

export function useDownloadSlot(): DownloadSlotValue {
  return useContext(DownloadSlotContext);
}

/** 下载页锚点：登记节点供下载面板 portal；卸载时清空 */
export function DownloadPageAnchor({ className }: { className?: string }) {
  const { setSlot } = useDownloadSlot();
  const nodeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setSlot(nodeRef.current);
    return () => setSlot(null);
  }, [setSlot]);

  return <div ref={nodeRef} className={className} />;
}
