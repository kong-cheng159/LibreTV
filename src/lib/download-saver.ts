/**
 * 下载文件的保存目标：
 * - 桌面壳（Tauri）：系统另存为 + 原生流式写盘（确认落盘）
 * - Chromium：showSaveFilePicker 边下边写盘（FS Access API），
 *   必须在**用户手势内**调用（点击处理器的同步栈中）；
 * - 其余环境：内存聚合为 Blob 后触发浏览器下载（>500MB 时让用户确认）。
 *
 * 「交给浏览器」不等于「已存到设备」（issue #977）：`a.click()` 是 fire-and-forget。
 */

export interface SaveTarget {
  /** 'fs' = 磁盘直写；'memory' = 内存聚合 */
  kind: 'fs' | 'memory';
  /** 建议文件名：内存模式重复触发保存时沿用；桌面模式为绝对路径 */
  filename: string;
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
  /**
   * close() 之后可取到的 Blob objectURL，供「保存到设备 / 重新保存」复用。
   * fs 直写恒为 null。
   */
  savedUrl(): string | null;
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function supportsFileSystemAccess(): boolean {
  return typeof window !== 'undefined' && 'showSaveFilePicker' in window;
}

export function detectSavingCapability(): 'fs-access' | 'memory' {
  if (isTauriRuntime()) return 'fs-access';
  return supportsFileSystemAccess() ? 'fs-access' : 'memory';
}

export class UserCancelledError extends Error {
  constructor() {
    super('用户取消了保存');
  }
}

/** Uint8Array → base64（分块，避免大数组展开栈溢出） */
function bytesToBase64(data: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < data.length; i += step) {
    binary += String.fromCharCode(...data.subarray(i, i + step));
  }
  return btoa(binary);
}

const DESKTOP_FLUSH_BYTES = 1024 * 1024;

/**
 * 桌面壳：系统另存为 + 原生追加写。失败（非取消）返回 null，由调用方回退。
 */
async function createDesktopSaveTarget(filename: string): Promise<SaveTarget | null> {
  if (!isTauriRuntime()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : 'bin';
    const path = await invoke<string | null>('desktop_download_pick', {
      defaultName: filename,
      extensions: [ext],
    });
    if (path == null) throw new UserCancelledError();
    const id = await invoke<number>('desktop_download_open', { path });

    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    let closed = false;

    const flush = async () => {
      if (pendingBytes === 0) return;
      const merged = new Uint8Array(pendingBytes);
      let offset = 0;
      for (const part of pending) {
        merged.set(part, offset);
        offset += part.byteLength;
      }
      pending = [];
      pendingBytes = 0;
      await invoke('desktop_download_write', {
        id,
        chunkBase64: bytesToBase64(merged),
      });
    };

    return {
      kind: 'fs',
      filename: path,
      async write(data) {
        if (closed) return;
        pending.push(data);
        pendingBytes += data.byteLength;
        if (pendingBytes >= DESKTOP_FLUSH_BYTES) await flush();
      },
      async close() {
        if (closed) return;
        closed = true;
        await flush();
        await invoke('desktop_download_close', { id });
      },
      async abort() {
        if (closed) return;
        closed = true;
        pending = [];
        pendingBytes = 0;
        try {
          await invoke('desktop_download_abort', { id });
        } catch {
          /* 句柄可能已关 */
        }
      },
      savedUrl: () => null,
    };
  } catch (err) {
    if (err instanceof UserCancelledError) throw err;
    return null;
  }
}

/**
 * 把 objectURL 交给浏览器下载。注意这只是「发起」保存：没有任何回执可等。
 */
export function triggerBrowserDownload(url: string, filename: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
  }, 0);
}

/** 丢弃内存模式保留的 Blob：任务记录删除时调用。 */
export function releaseSavedBlob(target: SaveTarget): void {
  const url = target.savedUrl();
  if (url) URL.revokeObjectURL(url);
}

/** 内存聚合目标：导出仅为便于对「阈值确认 / 取消不产出」这类分支做测试。 */
export function createMemoryTarget(filename: string, confirmOverBytes = 500 * 1024 * 1024): SaveTarget {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let done = false;
  let aborted = false;
  let url: string | null = null;
  const flush = () => {
    if (aborted || url) return;
    done = true;
    const blob = new Blob(chunks.map((c) => c.buffer as ArrayBuffer));
    chunks.length = 0;
    url = URL.createObjectURL(blob);
    triggerBrowserDownload(url, filename);
  };
  return {
    kind: 'memory',
    filename,
    async write(data) {
      if (done) return;
      bytes += data.byteLength;
      if (bytes > confirmOverBytes && bytes - data.byteLength <= confirmOverBytes) {
        if (
          !window.confirm(
            `下载体积已超过 ${Math.round(confirmOverBytes / 1024 / 1024)}MB，继续将暂存在内存中，可能导致页面卡顿。是否继续？`
          )
        ) {
          throw new Error('用户取消了下载（内存超限）');
        }
      }
      chunks.push(data);
    },
    async close() {
      flush();
    },
    async abort() {
      aborted = true;
      done = true;
      chunks.length = 0;
    },
    savedUrl: () => url,
  };
}

/**
 * 选择保存目标并打开写入流。showSaveFilePicker / 桌面另存为必须在用户手势内调用。
 * 用户取消文件选择器时抛出 UserCancelledError。
 */
export async function pickSaveTarget(filename: string, estimatedBytes?: number): Promise<SaveTarget> {
  const desktop = await createDesktopSaveTarget(filename);
  if (desktop) return desktop;

  if (supportsFileSystemAccess()) {
    try {
      const picker = (
        window as unknown as {
          showSaveFilePicker: (opts: {
            suggestedName: string;
          }) => Promise<{ createWritable: () => Promise<WritableStream> }>;
        }
      ).showSaveFilePicker;
      const handle = await picker({ suggestedName: filename });
      const writable = await handle.createWritable();
      const writer = writable.getWriter();
      return {
        kind: 'fs',
        filename,
        async write(data) {
          await writer.write(data);
        },
        async close() {
          await writer.close();
        },
        async abort() {
          try {
            await writer.abort();
          } catch {
            /* 已关闭则忽略 */
          }
        },
        savedUrl: () => null,
      };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new UserCancelledError();
      }
    }
  }
  if (estimatedBytes && estimatedBytes > 500 * 1024 * 1024) {
    if (
      !window.confirm(
        '该视频体积较大（未提供磁盘直写能力的环境），将暂存在内存中，可能导致页面卡顿。是否继续？'
      )
    ) {
      throw new UserCancelledError();
    }
  }
  return createMemoryTarget(filename);
}
