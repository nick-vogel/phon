import type { Gif, MessageImage } from '@phon/api-types'
import { Directory, File, Paths } from 'expo-file-system'
import { imageUrl } from './client'
import { authorizationHeader } from './session'

/** The file extension for each image type the server serves. */
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/** The downloads still running, by image ID, so two screens showing one image fetch it once. */
const downloading = new Map<string, Promise<string>>()

/**
 * A posted image as a file on the device, downloaded once with the `Authorization` header and kept
 * in the cache: an image ID never changes its bytes. Answers the file's URI, for the chat library,
 * whose photo viewer loads a URI with no headers and so could not open the server's URL itself.
 * The download lands under a temporary name first, so a failed one never passes for the image.
 */
export function localImage(channelId: string, image: MessageImage): Promise<string> {
  const running = downloading.get(image.id)
  if (running !== undefined) return running
  const download = fetchOnce(channelId, image).finally(() => {
    downloading.delete(image.id)
  })
  downloading.set(image.id, download)
  return download
}

async function fetchOnce(channelId: string, image: MessageImage): Promise<string> {
  const directory = new Directory(Paths.cache, 'images')
  const name = `${encodeURIComponent(image.id)}.${EXTENSIONS[image.contentType] ?? 'img'}`
  const file = new File(directory, name)
  if (file.exists) return file.uri
  directory.create({ intermediates: true, idempotent: true })
  const partial = new File(directory, `${name}.part`)
  const downloaded = await File.downloadFileAsync(imageUrl(channelId, image.id), partial, {
    headers: authorizationHeader(),
    idempotent: true,
  })
  await downloaded.move(file)
  return file.uri
}

/**
 * A GIF picked from a search, as a file on the device, for `postImage` to upload as `image/gif`.
 * It downloads the `send` file the server chose from KLIPY's CDN, with no `Authorization` header:
 * the Phon session never goes to KLIPY. Kept in the cache by the GIF's ID, under a temporary name
 * until the download finishes, as a posted image is.
 */
export async function localGif(gif: Gif): Promise<string> {
  const directory = new Directory(Paths.cache, 'gifs')
  const name = `${encodeURIComponent(gif.id)}.gif`
  const file = new File(directory, name)
  if (file.exists) return file.uri
  directory.create({ intermediates: true, idempotent: true })
  const partial = new File(directory, `${name}.part`)
  const downloaded = await File.downloadFileAsync(gif.send.url, partial, { idempotent: true })
  await downloaded.move(file)
  return file.uri
}
