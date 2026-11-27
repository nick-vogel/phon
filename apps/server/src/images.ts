/**
 * Posted images: which uploads Phon accepts, and where each one is kept in R2.
 */

/** The largest image Phon accepts. A phone photo is a few MiB. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/**
 * The image types Phon accepts, each with the first bytes every file of that type begins with.
 * These four display on both phone platforms; HEIC is refused, and the app asks iOS for JPEG.
 */
const SIGNATURES: Record<string, (bytes: Uint8Array) => boolean> = {
  'image/jpeg': (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]),
  'image/png': (bytes) => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/gif': (bytes) => startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a')),
  'image/webp': (bytes) =>
    startsWith(bytes, ascii('RIFF')) && startsWith(bytes.subarray(8), ascii('WEBP')),
}

/** Why an upload's image part was refused, for the Worker to map to a status. */
export type ImageRefusal =
  /** There is no `image` file part, or it is empty (400). */
  | 'missing'
  /** It is not one of the accepted types, or its bytes are not what its type says (415). */
  | 'unsupported'
  /** It is larger than `MAX_IMAGE_BYTES` (413). */
  | 'too-large'

/** An accepted image: its bytes and its checked type. */
export interface AcceptedImage {
  bytes: ArrayBuffer
  contentType: string
}

/**
 * Checks an upload's `image` part: a non-empty file of at most `MAX_IMAGE_BYTES`, of an accepted
 * type, whose first bytes carry that type's signature, so a non-image is never served as one.
 */
export async function acceptImage(
  part: File | string | null,
): Promise<AcceptedImage | ImageRefusal> {
  if (part === null || typeof part === 'string' || part.size === 0) return 'missing'
  if (part.size > MAX_IMAGE_BYTES) return 'too-large'
  const contentType = part.type.toLowerCase()
  const matches = SIGNATURES[contentType]
  if (matches === undefined) return 'unsupported'
  const bytes = await part.arrayBuffer()
  if (!matches(new Uint8Array(bytes))) return 'unsupported'
  return { bytes, contentType }
}

/**
 * Where an image is kept in R2: `<churchId>/<channelId>/<imageId>`, each part URI-encoded so no ID
 * can reach into another's prefix. The church and channel come from the caller's identity and the
 * gated channel, never from anything the upload says.
 */
export function imageKey(churchId: string, channelId: string, imageId: string): string {
  return [churchId, channelId, imageId].map(encodeURIComponent).join('/')
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.length <= bytes.length && prefix.every((byte, index) => bytes[index] === byte)
}

function ascii(text: string): number[] {
  return [...text].map((character) => character.charCodeAt(0))
}
