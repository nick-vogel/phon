import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DEFAULT_THEME, resolveTheme } from '../src/theme/theme.ts'

/**
 * The app icon, the launch screen and the Android notification icon (phon#251). `app.json` is JSON,
 * so it cannot import the theme module: these tests hold its colours to the theme, and check that
 * each image it names is a PNG of the size and kind the platforms ask for.
 */

const APP_ROOT = join(import.meta.dirname, '..')

/** `app.json`'s `expo` object, parsed as the Expo CLI reads it. */
function expoConfig() {
  return JSON.parse(readFileSync(join(APP_ROOT, 'app.json'), 'utf8')).expo
}

/** A config plugin's options, from its `[name, options]` entry. */
function pluginOptions(name: string) {
  const entry = expoConfig().plugins.find(
    (plugin: unknown) => Array.isArray(plugin) && plugin[0] === name,
  )
  assert.ok(entry, `app.json configures the ${name} plugin with options`)
  return entry[1]
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
/** The IHDR colour types: 2 is RGB with no alpha, 6 is RGB with alpha. */
const RGB = 2
const RGBA = 6

/** A PNG's size and colour type, read from its IHDR chunk. */
function png(path: string) {
  const file = join(APP_ROOT, path)
  assert.ok(existsSync(file), `${path} exists`)
  const bytes = readFileSync(file)
  assert.deepEqual([...bytes.subarray(0, 8)], PNG_SIGNATURE, `${path} is a PNG`)
  assert.equal(bytes.toString('latin1', 12, 16), 'IHDR')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colourType: bytes[25] }
}

const light = resolveTheme({ church: DEFAULT_THEME, choice: 'light', scheme: null }).tokens
const dark = resolveTheme({ church: DEFAULT_THEME, choice: 'dark', scheme: null }).tokens

describe('the app icon', () => {
  it('is a 1024 x 1024 PNG with no transparency, since iOS rejects a transparent icon', () => {
    const { icon } = expoConfig()
    assert.equal(icon, './assets/images/icon.png')
    assert.deepEqual(png(icon), { width: 1024, height: 1024, colourType: RGB })
  })

  it('has an Android adaptive foreground and monochrome image on the accent fill', () => {
    const { adaptiveIcon } = expoConfig().android
    assert.equal(adaptiveIcon.backgroundColor, DEFAULT_THEME.accent.fill)
    for (const image of [adaptiveIcon.foregroundImage, adaptiveIcon.monochromeImage]) {
      assert.deepEqual(png(image), { width: 1024, height: 1024, colourType: RGBA })
    }
  })

  it('keeps its source artwork in the repo, with no colour of its own', () => {
    const svg = readFileSync(join(APP_ROOT, 'assets/source/phon-mark.svg'), 'utf8')
    assert.match(svg, /<svg[^>]*viewBox="0 0 1024 1024"/)
    const paints = [...svg.matchAll(/\b(?:fill|stroke|color|stop-color)="([^"]*)"/g)].map(
      (match) => match[1],
    )
    assert.ok(paints.length > 0)
    assert.deepEqual(
      paints.filter((paint) => paint !== 'currentColor' && paint !== 'none'),
      [],
    )
    // A hex colour or a colour function anywhere, as the colour check finds one; `phon#251` is not.
    assert.doesNotMatch(svg, /(?<![\w#])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![0-9a-z_])/i)
    assert.doesNotMatch(svg, /\b(?:rgba?|hsla?)\(|style=/)
  })
})

describe('the launch screen', () => {
  const splash = pluginOptions('expo-splash-screen')

  it('shows the mark on the light background in light mode', () => {
    assert.equal(splash.backgroundColor, light.background)
    assert.deepEqual(png(splash.image), { width: 1024, height: 1024, colourType: RGBA })
  })

  it('shows the mark on the dark background in dark mode', () => {
    assert.equal(splash.dark.backgroundColor, dark.background)
    assert.notEqual(splash.dark.image, splash.image)
    assert.deepEqual(png(splash.dark.image), { width: 1024, height: 1024, colourType: RGBA })
  })

  it('follows the phone between the two', () => {
    assert.equal(expoConfig().userInterfaceStyle, 'automatic')
  })

  it('is a dependency of the app, so its config plugin resolves', () => {
    const manifest = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8'))
    assert.ok(manifest.dependencies['expo-splash-screen'])
  })
})

describe('the Android notification icon', () => {
  const notifications = pluginOptions('expo-notifications')

  it('is a 96 x 96 PNG with transparency', () => {
    assert.deepEqual(png(notifications.icon), { width: 96, height: 96, colourType: RGBA })
  })

  it('is tinted with the accent fill', () => {
    assert.equal(notifications.color, DEFAULT_THEME.accent.fill)
  })
})
