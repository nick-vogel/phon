/**
 * Renders the app icon, the launch screen images and the Android notification icon from the
 * colourless source artwork, `assets/source/phon-mark.svg`, in the theme module's colours
 * (phon#251). Run it after editing the artwork or the default theme, and commit the PNGs:
 *
 *   pnpm --filter @phon/app icons
 *
 * `test/app-icon.test.ts` holds `app.json` to the same theme colours.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { SILHOUETTE } from '../src/theme/icon-colours.ts'
import { DEFAULT_THEME, resolveTheme } from '../src/theme/theme.ts'

const APP_ROOT = join(import.meta.dirname, '..')
const IMAGES = join(APP_ROOT, 'assets/images')

const source = readFileSync(join(APP_ROOT, 'assets/source/phon-mark.svg'), 'utf8')
const shapes = source.match(/<svg[^>]*>([\s\S]*)<\/svg>/)?.[1]
if (!shapes) throw new Error('assets/source/phon-mark.svg holds no <svg> element')

const light = resolveTheme({ church: DEFAULT_THEME, choice: 'light', scheme: null }).tokens
const dark = resolveTheme({ church: DEFAULT_THEME, choice: 'dark', scheme: null }).tokens

/** The whole canvas, and a square close around the mark for the small notification icon. */
const CANVAS = '0 0 1024 1024'
const MARK_ONLY = '242 246 540 540'

interface Output {
  file: string
  size: number
  mark: string
  /** An opaque background; without one, the PNG keeps its transparency. */
  background?: string
  viewBox?: string
}

const OUTPUTS: Output[] = [
  // iOS rejects an icon with transparency, so the home screen icon is opaque.
  {
    file: 'icon.png',
    size: 1024,
    mark: DEFAULT_THEME.accent.onFill,
    background: DEFAULT_THEME.accent.fill,
  },
  // Android draws the adaptive background from `app.json`'s `backgroundColor`.
  { file: 'adaptive-icon.png', size: 1024, mark: DEFAULT_THEME.accent.onFill },
  { file: 'adaptive-icon-monochrome.png', size: 1024, mark: SILHOUETTE },
  { file: 'splash-icon.png', size: 1024, mark: light.primaryText },
  { file: 'splash-icon-dark.png', size: 1024, mark: dark.primaryText },
  { file: 'notification-icon.png', size: 96, mark: SILHOUETTE, viewBox: MARK_ONLY },
]

for (const { file, size, mark, background, viewBox = CANVAS } of OUTPUTS) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${viewBox}" color="${mark}">${shapes}</svg>`
  const image = sharp(Buffer.from(svg))
  const png = background ? image.flatten({ background }).removeAlpha() : image.ensureAlpha()
  await png.png().toFile(join(IMAGES, file))
  console.log(`assets/images/${file}`)
}
