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

async function saveViaBrowserDownload(filename: string, contents: string): Promise<SaveTextFileResult> {
  const blob = new Blob([contents], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  triggerBrowserDownload(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { path: null, mode: 'download' };
}

async function saveViaFsAccess(
  filename: string,
  getContents: () => Promise<string>,
  extDots: string[]
): Promise<SaveTextFileResult | null> {
  if (!supportsFileSystemAccess()) return null;
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
    const contents = await getContents();
    const writable = await handle.createWritable();
    const writer = writable.getWriter();
    await writer.write(new TextEncoder().encode(contents));
    await writer.close();
    return { path: filename, mode: 'fs-access' };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new UserCancelledError();
    }
    return null;
  }
}

/**
 * 把文本保存到用户选定的位置。
 * - 桌面壳：系统「另存为」（IPC 失败时回退下载）
 * - 浏览器：优先 File System Access
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
    try {
      const contents = await options.getContents();
      const { invoke } = await import('@tauri-apps/api/core');
      const path = await invoke<string | null>('save_text_file', {
        defaultName: filename,
        contents,
        extensions,
      });
      if (path == null) throw new UserCancelledError();
      return { path, mode: 'desktop-dialog' };
    } catch (err) {
      if (err instanceof UserCancelledError) throw err;
      // ACL / 远程页面未放行时 invoke 会失败；回退到 FS Access 或下载，避免整页「导出失败」
      const viaFs = await saveViaFsAccess(filename, options.getContents, extDots);
      if (viaFs) return viaFs;
      const contents = await options.getContents();
      return saveViaBrowserDownload(filename, contents);
    }
  }

  const viaFs = await saveViaFsAccess(filename, options.getContents, extDots);
  if (viaFs) return viaFs;

  const contents = await options.getContents();
  return saveViaBrowserDownload(filename, contents);
}
