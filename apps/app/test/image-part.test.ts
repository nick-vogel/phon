import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { imagePart } from '../src/api/image-part.ts'

const JPEG = [0xff, 0xd8, 0xff, 0xe0]
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const GIF = [...'GIF89a'].map((character) => character.charCodeAt(0))
const WEBP = [...'RIFF\u0000\u0000\u0000\u0000WEBP'].map((character) => character.charCodeAt(0))

/** A picked file whose name gives one type and whose bytes begin with another's signature. */
function picked(name: string, type: string, signature: number[]) {
  const bytes = new Uint8Array(32)
  bytes.set(signature)
  return { name, type, bytes: async () => bytes }
}

describe('the image part of an upload', () => {
  it('labels JPEG bytes as image/jpeg when the file keeps a .gif or .webp name', async () => {
    // Android's picker re-encodes a GIF or WebP as JPEG below quality 1 and keeps the extension.
    for (const [name, type] of [
      ['photo.gif', 'image/gif'],
      ['photo.webp', 'image/webp'],
    ]) {
      const part = await imagePart(picked(name, type, JPEG))
      assert.equal(part.type, 'image/jpeg', name)
    }
  })

  it('labels each accepted type by its bytes', async () => {
    assert.equal((await imagePart(picked('a.png', 'image/png', PNG))).type, 'image/png')
    assert.equal((await imagePart(picked('a.jpg', 'image/jpeg', JPEG))).type, 'image/jpeg')
    assert.equal((await imagePart(picked('a.gif', 'image/gif', GIF))).type, 'image/gif')
    assert.equal((await imagePart(picked('a.webp', 'image/webp', WEBP))).type, 'image/webp')
  })

  it('keeps the file type for bytes of no accepted type, so the server refuses them plainly', async () => {
    const heic = [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]

    assert.equal((await imagePart(picked('a.heic', 'image/heic', heic))).type, 'image/heic')
  })

  it("sends the file's own name and bytes", async () => {
    const file = picked('photo.gif', 'image/gif', JPEG)

    const part = await imagePart(file)

    assert.equal(part.name, 'photo.gif')
    assert.deepEqual(await part.bytes(), await file.bytes())
  })
})
