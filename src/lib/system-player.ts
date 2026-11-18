/** 桌面壳把媒体 URL 交给 Windows 的默认协议关联程序；Web 环境不冒充支持。 */
export async function openInSystemPlayer(url: string): Promise<boolean> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return false;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('open_system_player', { url });
  return true;
}
