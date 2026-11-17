/**
 * 进度条点击 / 拖动定位：把指针 X 映射为 [0, 1] 比例。
 * ArtPlayer 在 isMobile 时不给进度条挂 click/mousedown；桌面点在圆点上也会被库忽略。
 */

export function seekRatioFromClientX(
  clientX: number,
  rect: Pick<DOMRect, 'left' | 'width'>
): number {
  if (!Number.isFinite(clientX) || !Number.isFinite(rect.left) || !(rect.width > 0)) {
    return 0;
  }
  const ratio = (clientX - rect.left) / rect.width;
  if (ratio <= 0) return 0;
  if (ratio >= 1) return 1;
  return ratio;
}

export function seekTimeFromClientX(
  clientX: number,
  rect: Pick<DOMRect, 'left' | 'width'>,
  duration: number
): number | null {
  if (!Number.isFinite(duration) || duration <= 0) return null;
  return seekRatioFromClientX(clientX, rect) * duration;
}
