import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach } from 'vitest'
import { churchListCache } from '../../src/church-list.ts'
import { network } from './network.ts'

beforeEach(() => {
  network.install()
})

afterEach(async () => {
  try {
    network.verify()
  } finally {
    network.reset()
    network.uninstall()
    // Storage outlives a test, so the next test's sync would otherwise also sync every church this
    // test connected, against a fake that no longer exists, and a token this test registered would
    // still be listed for this test's church.
    await runInDurableObject(env.CHURCH_REGISTRY.getByName('all'), (_registry, state) => {
      state.storage.sql.exec('DELETE FROM churches')
      state.storage.sql.exec('DELETE FROM church_names')
      state.storage.sql.exec('DELETE FROM device_churches')
    })
    // The church list cache outlives a test too, so the next test's list would otherwise answer
    // with this test's churches.
    churchListCache.clear()
  }
})
