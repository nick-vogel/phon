import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/** One of the app package's JSON files, parsed as EAS and the Expo CLI read it. */
function appFile(name: string) {
  return JSON.parse(readFileSync(join(import.meta.dirname, '..', name), 'utf8'))
}

/** Android's Application ID rule: two or more dot-separated segments, each starting a-z. */
const APPLICATION_ID = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/

describe('the release configuration for the store builds', () => {
  it('names the iOS bundle ID and the Android package name', () => {
    const { expo } = appFile('app.json')
    assert.equal(expo.ios.bundleIdentifier, 'chat.phon.app')
    assert.equal(expo.android.package, 'chat.phon.app')
    assert.match(expo.ios.bundleIdentifier, APPLICATION_ID)
    assert.match(expo.android.package, APPLICATION_ID)
  })

  it('configures the iOS capability for Time Sensitive notifications', () => {
    const { expo } = appFile('app.json')
    assert.equal(
      expo.ios.entitlements['com.apple.developer.usernotifications.time-sensitive'],
      true,
    )
  })

  it('has EAS build profiles for development, preview and production', () => {
    const eas = appFile('eas.json')
    assert.equal(eas.cli.appVersionSource, 'remote')
    assert.deepEqual(eas.build.development, { developmentClient: true, distribution: 'internal' })
    assert.equal(eas.build.preview.distribution, 'internal')
    assert.equal(eas.build.production.autoIncrement, true)
    assert.notEqual(eas.build.production.distribution, 'internal')
    // A development build depends on the development client.
    assert.ok(appFile('package.json').dependencies['expo-dev-client'])
  })
})
