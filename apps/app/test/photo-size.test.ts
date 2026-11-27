import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { keepsAsPicked, LONG_SIDE, uploadSize } from '../src/photo-size.ts'

describe('the size a picked photo uploads at', () => {
  it('scales a 4032x3024 photo to 2048x1536', () => {
    assert.deepEqual(uploadSize(4032, 3024), { width: 2048, height: 1536 })
  })

  it('scales a portrait photo by its long side', () => {
    assert.deepEqual(uploadSize(3024, 4032), { width: 1536, height: 2048 })
  })

  it('keeps a 1600x1200 photo at its size', () => {
    assert.deepEqual(uploadSize(1600, 1200), { width: 1600, height: 1200 })
  })

  it('keeps a photo whose long side is already 2048', () => {
    assert.equal(LONG_SIDE, 2048)
    assert.deepEqual(uploadSize(2048, 1536), { width: 2048, height: 1536 })
  })
})

describe('which picked images pass through untouched', () => {
  it('keeps a GIF or WebP as picked, so an animation survives', () => {
    assert.equal(keepsAsPicked({ mimeType: 'image/gif', uri: 'file:///a/photo.gif' }), true)
    assert.equal(keepsAsPicked({ mimeType: 'image/webp', uri: 'file:///a/photo.webp' }), true)
  })

  it('keeps a .gif as picked when the picker gave no type', () => {
    assert.equal(keepsAsPicked({ uri: 'file:///a/photo.gif' }), true)
  })

  it('shrinks a JPEG or PNG', () => {
    assert.equal(keepsAsPicked({ mimeType: 'image/jpeg', uri: 'file:///a/photo.jpg' }), false)
    assert.equal(keepsAsPicked({ mimeType: 'image/png', uri: 'file:///a/photo.png' }), false)
  })
})
