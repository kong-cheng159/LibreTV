import { supportsFileSystemAccess, triggerBrowserDownload, UserCancelledError } from './download-saver';

export { UserCancelledError };

export interface SaveTextFileResult {
  /** 系统另存为会返回绝对路径；浏览器选择器通常只有文件名；下载回退为 null */
  path: string | null;
  /** desktop-dialog = 系统另存为；fs-access = 浏览器文件选择器；download = 浏览器下载回退 */
  mode: 'desktop-dialog' | 'fs-access' | 'download';
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * 把文本保存到用户选定的位置。
 * - 桌面壳：系统「另存为」
 * - 浏览器：优先 File System Access（必须在用户手势内先弹窗，所以内容用 getContents 延后生成）
 * - 再不行：浏览器下载
 * 用户取消时抛出 UserCancelledError。
 */
export async function saveTextFile(options: {
  filename: string;
  getContents: () => Promise<string>;
  /** 另存为过滤器扩展名，不含点；默认 json */
  extensions?: string[];
}): Promise<SaveTextFileResult> {
  const filename = options.filename;
  const extensions = options.extensions?.length ? options.extensions : ['json'];
  const extDots = extensions.map((ext) => (ext.startsWith('.') ? ext : `.${ext}`));

  if (isTauriRuntime()) {
    const contents = await options.getContents();
    const { invoke } = await import('@tauri-apps/api/core');
    const path = await invoke<string | null>('save_text_file', {
      defaultName: filename,
      contents,
      extensions,
    });
    if (path == null) throw new UserCancelledError();
    return { path, mode: 'desktop-dialog' };
  }

  if (supportsFileSystemAccess()) {
    try {
      const picker = (
        window as unknown as {
          showSaveFilePicker: (opts: {
            suggestedName: string;
            types?: { description: string; accept: Record<string, string[]> }[];
          }) => Promise<{ createWritable: () => Promise<WritableStream> }>;
        }
      ).showSaveFilePicker;
      // 先弹窗，保住点击手势；再生成内容并写入
      const handle = await picker({
        suggestedName: filename,
        types: [{ description: 'JSON', accept: { 'application/json': extDots } }],
      });
      const contents = await options.getContents();
      const writable = await handle.createWritable();
      const writer = writable.getWriter();
      await writer.write(new TextEncoder().encode(contents));
      await writer.close();
      return { path: filename, mode: 'fs-access' };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new UserCancelledError();
      }
      // 选择器不可用时落到下载
    }
  }

  const contents = await options.getContents();
  const blob = new Blob([contents], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  triggerBrowserDownload(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { path: null, mode: 'download' };
}
