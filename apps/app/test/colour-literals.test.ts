import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * The colour check, a commit-stage test: every colour in the app comes from the theme module
 * (`src/theme/`), so a colour literal anywhere else under `app/`, `src/` or `scripts/` fails it,
 * naming the file and line. There are no exceptions.
 */

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCANNED = ['app', 'src', 'scripts']
const THEME_MODULE = 'src/theme/'

/** The CSS named colours, `transparent` included: React Native takes each of them as a colour. */
const NAMED_COLOURS = [
  'aliceblue',
  'antiquewhite',
  'aqua',
  'aquamarine',
  'azure',
  'beige',
  'bisque',
  'black',
  'blanchedalmond',
  'blue',
  'blueviolet',
  'brown',
  'burlywood',
  'cadetblue',
  'chartreuse',
  'chocolate',
  'coral',
  'cornflowerblue',
  'cornsilk',
  'crimson',
  'cyan',
  'darkblue',
  'darkcyan',
  'darkgoldenrod',
  'darkgray',
  'darkgreen',
  'darkgrey',
  'darkkhaki',
  'darkmagenta',
  'darkolivegreen',
  'darkorange',
  'darkorchid',
  'darkred',
  'darksalmon',
  'darkseagreen',
  'darkslateblue',
  'darkslategray',
  'darkslategrey',
  'darkturquoise',
  'darkviolet',
  'deeppink',
  'deepskyblue',
  'dimgray',
  'dimgrey',
  'dodgerblue',
  'firebrick',
  'floralwhite',
  'forestgreen',
  'fuchsia',
  'gainsboro',
  'ghostwhite',
  'gold',
  'goldenrod',
  'gray',
  'green',
  'greenyellow',
  'grey',
  'honeydew',
  'hotpink',
  'indianred',
  'indigo',
  'ivory',
  'khaki',
  'lavender',
  'lavenderblush',
  'lawngreen',
  'lemonchiffon',
  'lightblue',
  'lightcoral',
  'lightcyan',
  'lightgoldenrodyellow',
  'lightgray',
  'lightgreen',
  'lightgrey',
  'lightpink',
  'lightsalmon',
  'lightseagreen',
  'lightskyblue',
  'lightslategray',
  'lightslategrey',
  'lightsteelblue',
  'lightyellow',
  'lime',
  'limegreen',
  'linen',
  'magenta',
  'maroon',
  'mediumaquamarine',
  'mediumblue',
  'mediumorchid',
  'mediumpurple',
  'mediumseagreen',
  'mediumslateblue',
  'mediumspringgreen',
  'mediumturquoise',
  'mediumvioletred',
  'midnightblue',
  'mintcream',
  'mistyrose',
  'moccasin',
  'navajowhite',
  'navy',
  'oldlace',
  'olive',
  'olivedrab',
  'orange',
  'orangered',
  'orchid',
  'palegoldenrod',
  'palegreen',
  'paleturquoise',
  'palevioletred',
  'papayawhip',
  'peachpuff',
  'peru',
  'pink',
  'plum',
  'powderblue',
  'purple',
  'rebeccapurple',
  'red',
  'rosybrown',
  'royalblue',
  'saddlebrown',
  'salmon',
  'sandybrown',
  'seagreen',
  'seashell',
  'sienna',
  'silver',
  'skyblue',
  'slateblue',
  'slategray',
  'slategrey',
  'snow',
  'springgreen',
  'steelblue',
  'tan',
  'teal',
  'thistle',
  'tomato',
  'transparent',
  'turquoise',
  'violet',
  'wheat',
  'white',
  'whitesmoke',
  'yellow',
  'yellowgreen',
]

const COLOUR_LITERAL = new RegExp(
  [
    // A hex colour, not preceded by a word character, so `phon#106` is an issue and not a colour.
    '(?<![\\w#])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![0-9a-z_])',
    // A colour function.
    '\\b(?:rgba?|hsla?)\\(',
    // A quoted string that is exactly a named colour.
    `(['"\`])(?:${NAMED_COLOURS.join('|')})\\1`,
  ].join('|'),
  'gi',
)

/** The colour literals in one line of source. */
function colourLiterals(line: string): string[] {
  return [...line.matchAll(COLOUR_LITERAL)].map((match) => match[0])
}

/** Every `.ts` and `.tsx` file the check scans, relative to `apps/app`, outside the theme module. */
function scannedFiles(): string[] {
  return SCANNED.flatMap((dir) =>
    readdirSync(join(APP_ROOT, dir), { recursive: true, encoding: 'utf8' })
      .map((path) =>
        relative(APP_ROOT, join(APP_ROOT, dir, path))
          .split('\\')
          .join('/'),
      )
      .filter((path) => /\.tsx?$/.test(path) && !path.startsWith(THEME_MODULE)),
  ).sort()
}

/** Each colour literal in a file, as `file:line literal`. */
function literalsIn(path: string): string[] {
  return readFileSync(join(APP_ROOT, path), 'utf8')
    .split('\n')
    .flatMap((line, index) =>
      colourLiterals(line).map((literal) => `${path}:${index + 1} ${literal}`),
    )
}

describe('finding a colour literal', () => {
  it('flags hex colours of every length, colour functions and named colours', () => {
    assert.deepEqual(colourLiterals(`color: '#2266dd',`), ['#2266dd'])
    assert.deepEqual(colourLiterals(`<Text style={{ color: '#fff' }}>`), ['#fff'])
    assert.deepEqual(colourLiterals(`const tint = { light: '#FFF1C2' }`), ['#FFF1C2'])
    assert.deepEqual(colourLiterals(`borderColor: '#ffffff1a',`), ['#ffffff1a'])
    assert.deepEqual(colourLiterals(`backgroundColor: 'rgba(0, 0, 0, 0.5)',`), ['rgba('])
    assert.deepEqual(colourLiterals(`color: 'white',`), ["'white'"])
    assert.deepEqual(colourLiterals(`backgroundColor: "transparent",`), ['"transparent"'])
  })

  it('leaves issue references and words that only start with a colour name', () => {
    assert.deepEqual(colourLiterals('// The mention tint (phon#106).'), [])
    assert.deepEqual(colourLiterals('// Fixed in issue#123.'), [])
    assert.deepEqual(colourLiterals(`const list = 'whitelist'`), [])
    assert.deepEqual(colourLiterals(`const id = '#abcdefg'`), [])
  })
})

describe('the colour check', () => {
  const files = scannedFiles()

  it('scans the app screens, modules and scripts, and not the theme module', () => {
    assert.ok(files.includes('app/channels/[channelId].tsx'))
    assert.ok(files.includes('src/urgent-setup.ts'))
    assert.ok(files.includes('scripts/render-icons.ts'))
    assert.ok(!files.some((path) => path.startsWith(THEME_MODULE)))
  })

  it('finds no colour literal outside the theme module', () => {
    const found = files.flatMap(literalsIn)
    assert.deepEqual(
      found,
      [],
      `Take these colours from the theme module (src/theme/):\n${found.join('\n')}`,
    )
  })
})
