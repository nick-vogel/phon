/**
 * The `image` part of an upload, typed by the bytes the picker wrote rather than by the file's
 * extension. Below quality 1, Android's picker re-encodes a GIF or WebP as JPEG (a PNG stays PNG)
 * and keeps the old extension, so a part typed from the extension would label JPEG bytes as
 * image/gif or image/webp, and the server would refuse it. Pure, so a test runs it without a phone.
 */

/** A picked image file as the upload reads it: an expo-file-system `File` has this shape. */
export interface PickedFile {
  readonly name: string
  /** The type the file's extension gives. */
  readonly type: string
  bytes(): Promise<Uint8Array>
}

/** The `image` part of an upload, as `expo/fetch` writes a `FormData` part. */
export interface ImagePart {
  name: string
  type: string
  bytes(): Promise<Uint8Array>
}

/**
 * The part for a picked file: its name and bytes, typed by the bytes' signature. Bytes of no type
 * the server takes keep the file's own type, so the server refuses them plainly (415).
 */
export async function imagePart(file: PickedFile): Promise<ImagePart> {
  const bytes = await file.bytes()
  return { name: file.name, type: typeOf(bytes) ?? file.type, bytes: async () => bytes }
}

/** The first bytes of each image type the server takes, the same signatures it checks. */
function typeOf(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'image/gif'
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes.subarray(8), ascii('WEBP')))
    return 'image/webp'
  return null
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.length <= bytes.length && prefix.every((byte, index) => bytes[index] === byte)
}

function ascii(text: string): number[] {
  return [...text].map((character) => character.charCodeAt(0))
}
