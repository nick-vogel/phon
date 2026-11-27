import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { phonePushToken, type TokenStore } from '../src/push-token.ts'

/** A store that keeps across launches, the way SecureStore keeps across app restarts. */
function keptStore(): TokenStore & { items: Map<string, string> } {
  const items = new Map<string, string>()
  return {
    items,
    getItemAsync: async (key) => items.get(key) ?? null,
    setItemAsync: async (key, value) => {
      items.set(key, value)
    },
  }
}

/** A store whose every read and write fails, like a locked keychain. */
const brokenStore: TokenStore = {
  getItemAsync: async () => {
    throw new Error('keychain locked')
  },
  setItemAsync: async () => {
    throw new Error('keychain locked')
  },
}

describe("this phone's Expo push token, for signing out", () => {
  it('is known on a later launch that learns no token, so sign-out still names the phone', async () => {
    const store = keptStore()
    await phonePushToken(store).remember('ExponentPushToken[earlier]')

    // The next launch: offline, so Expo answers no token and nothing is remembered.
    const nextLaunch = phonePushToken(store)

    assert.equal(await nextLaunch.current(), 'ExponentPushToken[earlier]')
  })

  it("is this launch's token as soon as Expo answers, before Phon has it", async () => {
    const tokens = phonePushToken(keptStore())

    await tokens.remember('ExponentPushToken[now]')

    assert.equal(await tokens.current(), 'ExponentPushToken[now]')
  })

  it("answers this launch's token over an earlier launch's", async () => {
    const store = keptStore()
    await phonePushToken(store).remember('ExponentPushToken[old]')
    const tokens = phonePushToken(store)

    await tokens.remember('ExponentPushToken[new]')

    assert.equal(await tokens.current(), 'ExponentPushToken[new]')
    assert.equal(await phonePushToken(store).current(), 'ExponentPushToken[new]')
  })

  it('answers null on a phone that never learned a token', async () => {
    assert.equal(await phonePushToken(keptStore()).current(), null)
  })

  it("keeps this launch's token when the store cannot be written, and answers null when it cannot be read", async () => {
    const tokens = phonePushToken(brokenStore)
    assert.equal(await tokens.current(), null)

    await tokens.remember('ExponentPushToken[now]')

    assert.equal(await tokens.current(), 'ExponentPushToken[now]')
  })
})
