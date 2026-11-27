/**
 * The size rule for a picked photo before it uploads: the long side at most 2048 pixels, so a photo
 * in a channel is quick to send and quick to load. Pure, so a test runs it without a phone.
 */

/** The longest side, in pixels, a photo uploads at. */
export const LONG_SIDE = 2048

/**
 * Whether a picked image uploads exactly as picked: a GIF or WebP, which may be animated and would
 * lose its animation if redrawn. Typed by the picker's MIME type, else by the uri's extension.
 */
export function keepsAsPicked(image: { mimeType?: string; uri: string }): boolean {
  if (image.mimeType !== undefined) return ANIMATED_TYPES.has(image.mimeType)
  return /\.(gif|webp)$/i.test(image.uri)
}

const ANIMATED_TYPES = new Set(['image/gif', 'image/webp'])

/**
 * The size a photo uploads at: its long side scaled to at most `LONG_SIDE`, the ratio kept. A photo
 * already at or below `LONG_SIDE` keeps its size; it is never scaled up.
 */
export function uploadSize(width: number, height: number): { width: number; height: number } {
  const scale = LONG_SIDE / Math.max(width, height)
  if (scale >= 1) return { width, height }
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}
