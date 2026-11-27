import { createExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import type { ChurchList } from '@phon/api-types'
import { describe, expect, it } from 'vitest'
import { CHURCH_LIST_PERIOD_MS, CHURCH_LIST_RETRY_MS, ChurchListCache } from '../src/church-list.ts'
import { REGISTRY_NAME } from '../src/church-registry.ts'
import { type ExpoPushMessage, sendPushes } from '../src/expo-push.ts'
import { syncAllChurches } from '../src/roster-sync.ts'
import { createWorker } from '../src/worker.ts'
import {
  envWithDirectory,
  envWithRegistry,
  registerDeviceWith,
  requestWith,
} from './support/bindings.ts'
import { withCaller } from './support/callers.ts'
import { postMessage, registerDevice, seedChurch } from './support/church.ts'
import { fakeExpoPush, tokenOf } from './support/expo-push.ts'
import { connectSyncAccount, pcoChurchId } from './support/flows.ts'
import { refusingMailer } from './support/mailer.ts'
import { fakePlanningCenter, newOrganizationId } from './support/planning-center.ts'
import { fakeServices } from './support/services.ts'
import { testIdentities } from './support/test-worker.ts'

/**
 * How many requests reach the one `all` ChurchRegistry for a push batch and for a registration.
 * Every church shares that object, so these counts are what `docs/adr/0001-one-church-registry.md`
 * multiplies by the expected load to decide whether it needs sharding. The registration counts are
 * a budget rather than an exact pin: a test here going red means the ADR's arithmetic is stale.
 */

/** The registry calls the ADR's arithmetic allows for one `POST /devices`. */
const REGISTRATION_BUDGET = 3

/**
 * The Worker's bindings with the real registry behind a counter: every RPC method called on it is
 * recorded by name, then forwarded, unless `failing.churches` makes a `churches` call throw as an
 * overloaded registry does. `held.hold()` holds every `churches` call until `held.release()`,
 * as a slow registry does.
 */
function countingRegistry() {
  const calls: string[] = []
  const failing = { churches: false }
  const held = holding()
  const registry = env.CHURCH_REGISTRY.getByName(REGISTRY_NAME)
  const counted = new Proxy(registry, {
    get: (target, property) => {
      const value = Reflect.get(target, property)
      if (typeof property !== 'string' || typeof value !== 'function') return value
      return (...args: unknown[]) => {
        calls.push(property)
        if (property === 'churches') {
          return held.until().then(() => {
            if (failing.churches) throw new Error('Durable Object is overloaded')
            return Reflect.apply(value, target, args)
          })
        }
        // `Reflect.apply`: an RPC method is not a plain function, and has no `apply` of its own.
        return Reflect.apply(value, target, args)
      }
    },
  })
  return { bindings: envWithRegistry(counted), calls, failing, held }
}

/** A hold that `until()` waits on once `hold()` is called, until `release()`. */
function holding() {
  let held: Promise<void> | null = null
  let release = () => {}
  return {
    hold: () => {
      held = new Promise((resolve) => {
        release = resolve
      })
    },
    release: () => {
      release()
      held = null
    },
    until: () => held ?? Promise.resolve(),
  }
}

/** Starts `count` church lists at once, then releases the held registry and waits for them all. */
async function listAtOnce(
  count: number,
  bindings: Env,
  churchList: ChurchListCache,
  held: ReturnType<typeof holding>,
): Promise<PromiseSettledResult<Response>[]> {
  held.hold()
  const lists = Array.from({ length: count }, () => listChurchesWith(bindings, churchList))
  await new Promise((resolve) => setTimeout(resolve, 50))
  held.release()
  return Promise.allSettled(lists)
}

const ana = { personId: 'ana', name: 'Ana Ortiz', role: 'admin' as const }
const ben = { personId: 'ben', name: 'Ben Okafor' }
const cy = { personId: 'cy', name: 'Cy Park' }
const fay = { personId: 'fay', name: 'Fay Okafor', role: 'chat-admin' as const }
const general = { channelId: 'general', name: 'general', kind: 'open' as const }

/** One push to each of `count` devices, as one church's batch. */
function batchOf(count: number): ExpoPushMessage<object>[] {
  return Array.from({ length: count }, (_, index) => ({
    to: tokenOf(`device-${index}`),
    title: '#general',
    body: 'Ana Ortiz: Service starts at ten',
    data: {},
    sound: 'default',
    priority: 'high',
    interruptionLevel: 'active',
    channelId: 'messages',
    badge: 0,
  }))
}

describe('the registry load of one push batch', () => {
  it('is one ownedBy call, however many Expo requests and SQL chunks the batch spans', async () => {
    const expo = fakeExpoPush()
    const churchId = crypto.randomUUID()
    // 250 devices: three Expo requests of at most 100, and three `ownedBy` queries of at most 99.
    const messages = batchOf(250)
    const registry = env.CHURCH_REGISTRY.getByName(REGISTRY_NAME)
    for (const message of messages) await registry.claimDevice(message.to, churchId)
    const { bindings, calls } = countingRegistry()

    await sendPushes(bindings, churchId, messages)

    expect(calls).toEqual(['ownedBy'])
    expect(expo.pushes()).toHaveLength(250)
  })

  it('is one ownedBy call for every push a report sends', async () => {
    const { churchId } = await seedChurch({ people: [ana, ben, cy, fay], channels: [general] })
    for (const personId of ['ana', 'ben', 'cy', 'fay']) {
      expect((await registerDevice(churchId, personId, tokenOf(personId))).status).toBe(204)
    }
    const expo = fakeExpoPush()
    const message = await postMessage(churchId, 'ben', 'general', 'Something unkind')
    const { bindings, calls } = countingRegistry()

    const response = await requestWith(
      bindings,
      churchId,
      'cy',
      `/channels/general/messages/${message.id}/reports`,
      { method: 'POST' },
    )

    expect(response.status).toBe(204)
    expect(calls).toEqual(['ownedBy'])
    const reportPushes = expo
      .pushes()
      .filter((push) => (push.data as { type?: string }).type === 'report')
    expect(reportPushes.map((push) => push.to).sort()).toEqual(
      [tokenOf('ana'), tokenOf('fay')].sort(),
    )
  })
})

describe('the registry load of one registration', () => {
  it('stays within budget for a first registration', async () => {
    const { churchId } = await seedChurch({ people: [ben], channels: [] })
    const { bindings, calls } = countingRegistry()

    const response = await registerDeviceWith(bindings, churchId, 'ben', tokenOf('ben'))

    expect(response.status).toBe(204)
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.length).toBeLessThanOrEqual(REGISTRATION_BUDGET)
  })

  it('stays within budget for a phone moving from church A to church B', async () => {
    const a = await seedChurch({ people: [cy], channels: [] })
    const b = await seedChurch({ people: [cy], channels: [] })
    const shared = tokenOf('shared-phone')
    expect((await registerDevice(a.churchId, 'cy', shared)).status).toBe(204)
    const { bindings, calls } = countingRegistry()

    const response = await registerDeviceWith(bindings, b.churchId, 'cy', shared)

    expect(response.status).toBe(204)
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.length).toBeLessThanOrEqual(REGISTRATION_BUDGET)
  })

  it('stays within budget for a registration the church refuses after the knows check', async () => {
    const { churchId } = await seedChurch({ people: [cy], channels: [] })
    const { bindings, calls } = countingRegistry()
    const leftMeanwhile = envWithDirectory(
      churchId,
      { knows: async () => true, registerDevice: async () => 'not-known' },
      bindings,
    )

    const response = await registerDeviceWith(leftMeanwhile, churchId, 'cy', tokenOf('cy'))

    expect(response.status).toBe(404)
    expect(calls.length).toBeLessThanOrEqual(REGISTRATION_BUDGET)
  })

  it('makes no registry call for a caller the church does not know', async () => {
    const { churchId } = await seedChurch({ people: [ben], channels: [] })
    const { bindings, calls } = countingRegistry()

    const response = await registerDeviceWith(bindings, churchId, 'stranger', tokenOf('stranger'))

    expect(response.status).toBe(404)
    expect(calls).toEqual([])
  })
})

/**
 * `GET /churches`, with no sign-in, through a Worker running on the given bindings, and with the
 * given church list cache, or the Worker's default one.
 */
async function listChurchesWith(bindings: Env, churchList?: ChurchListCache): Promise<Response> {
  const worker = createWorker({ authenticate: testIdentities, mailer: refusingMailer, churchList })
  const request = new Request('https://phon.test/churches', { headers: withCaller() }) as Request<
    unknown,
    IncomingRequestCfProperties
  >
  const response = await worker.fetch?.(request, bindings, createExecutionContext())
  if (response === undefined) throw new Error('The Worker has no fetch handler')
  return response
}

/**
 * Connects two churches' sync accounts: one whose name is read at connect, and one whose read
 * fails, so the next tick backfills it. Only the nameless church's sync account reads Services.
 */
async function connectNamedAndNameless() {
  const planningCenter = fakePlanningCenter()
  const named = newOrganizationId()
  const nameless = newOrganizationId()
  fakeServices(planningCenter, { syncPersonId: 'nameless-sync', teams: [] })
  await connectSyncAccount(planningCenter, {
    organizationId: named,
    personId: 'named-sync',
    administrator: true,
  })
  planningCenter.failOrganizationReads(1)
  await connectSyncAccount(planningCenter, {
    organizationId: nameless,
    personId: 'nameless-sync',
    administrator: true,
  })
  return { named: pcoChurchId(named), nameless: pcoChurchId(nameless) }
}

describe('the registry load of the church list and its backfill', () => {
  it('is one churches call for a church list', async () => {
    await connectNamedAndNameless()
    const { bindings, calls } = countingRegistry()

    const response = await listChurchesWith(bindings)

    expect(response.status).toBe(200)
    expect(((await response.json()) as ChurchList).churches).toHaveLength(1)
    expect(calls).toEqual(['churches'])
  })

  it('is one churches call for every church list inside the cache period', async () => {
    await connectNamedAndNameless()
    let now = 1_000_000
    const churchList = new ChurchListCache(CHURCH_LIST_PERIOD_MS, () => now)
    const { bindings, calls } = countingRegistry()

    for (let list = 0; list < 5; list++) {
      const response = await listChurchesWith(bindings, churchList)
      expect(response.status).toBe(200)
      expect(((await response.json()) as ChurchList).churches).toHaveLength(1)
      now += 10_000
    }

    expect(calls).toEqual(['churches'])
  })

  it('is one more churches call once the cache period has passed', async () => {
    await connectNamedAndNameless()
    let now = 1_000_000
    const churchList = new ChurchListCache(60_000, () => now)
    const { bindings, calls } = countingRegistry()

    expect((await listChurchesWith(bindings, churchList)).status).toBe(200)
    now += 59_999
    expect((await listChurchesWith(bindings, churchList)).status).toBe(200)
    expect(calls).toEqual(['churches'])
    now += 1
    expect((await listChurchesWith(bindings, churchList)).status).toBe(200)

    expect(calls).toEqual(['churches', 'churches'])
  })

  it('is no more churches calls inside the cache period once a read fails, and lists the last answer', async () => {
    await connectNamedAndNameless()
    let now = 1_000_000
    const churchList = new ChurchListCache(CHURCH_LIST_PERIOD_MS, () => now)
    const { bindings, calls, failing } = countingRegistry()

    expect((await listChurchesWith(bindings, churchList)).status).toBe(200)
    now += CHURCH_LIST_PERIOD_MS
    failing.churches = true
    for (let list = 0; list < 5; list++) {
      const response = await listChurchesWith(bindings, churchList)
      expect(response.status).toBe(200)
      expect(((await response.json()) as ChurchList).churches).toHaveLength(1)
      now += 10_000
    }

    expect(calls).toEqual(['churches', 'churches'])
  })

  it('is no more churches calls inside the retry period once a first read fails', async () => {
    await connectNamedAndNameless()
    let now = 1_000_000
    const churchList = new ChurchListCache(CHURCH_LIST_PERIOD_MS, () => now)
    const { bindings, calls, failing } = countingRegistry()

    failing.churches = true
    for (let list = 0; list < 5; list++) {
      await expect(listChurchesWith(bindings, churchList)).rejects.toThrow('overloaded')
      now += 1_000
    }
    expect(calls).toEqual(['churches'])
    failing.churches = false
    now += CHURCH_LIST_RETRY_MS
    expect((await listChurchesWith(bindings, churchList)).status).toBe(200)

    expect(calls).toEqual(['churches', 'churches'])
  })

  it('is one churches call for church lists that arrive together on a cold cache', async () => {
    await connectNamedAndNameless()
    const churchList = new ChurchListCache(CHURCH_LIST_PERIOD_MS, () => 1_000_000)
    const { bindings, calls, held } = countingRegistry()

    const lists = await listAtOnce(5, bindings, churchList, held)

    for (const list of lists) {
      if (list.status === 'rejected') throw list.reason
      expect(list.value.status).toBe(200)
      expect(((await list.value.json()) as ChurchList).churches).toHaveLength(1)
    }
    expect(calls).toEqual(['churches'])
  })

  it('is one churches call for church lists that arrive together on a cold cache whose read fails', async () => {
    await connectNamedAndNameless()
    const churchList = new ChurchListCache(CHURCH_LIST_PERIOD_MS, () => 1_000_000)
    const { bindings, calls, failing, held } = countingRegistry()
    failing.churches = true

    const lists = await listAtOnce(5, bindings, churchList, held)

    for (const list of lists) {
      expect(list.status).toBe('rejected')
      if (list.status === 'rejected') expect(String(list.reason)).toContain('overloaded')
    }
    expect(calls).toEqual(['churches'])
  })

  it('is one more churches call for church lists that arrive together once the cache period has passed, and lists the last answer while it reads', async () => {
    await connectNamedAndNameless()
    let now = 1_000_000
    const churchList = new ChurchListCache(CHURCH_LIST_PERIOD_MS, () => now)
    const { bindings, calls, held } = countingRegistry()
    expect((await listChurchesWith(bindings, churchList)).status).toBe(200)
    now += CHURCH_LIST_PERIOD_MS

    const lists = await listAtOnce(5, bindings, churchList, held)

    for (const list of lists) {
      if (list.status === 'rejected') throw list.reason
      expect(list.value.status).toBe(200)
      expect(((await list.value.json()) as ChurchList).churches).toHaveLength(1)
    }
    expect(calls).toEqual(['churches', 'churches'])
  })

  it('is one churches call and one nameChurch per nameless church for a roster sync tick', async () => {
    const { nameless } = await connectNamedAndNameless()
    const { bindings, calls } = countingRegistry()

    await syncAllChurches(bindings)

    expect(calls).toEqual(['churches', 'nameChurch'])
    const listed = await env.CHURCH_REGISTRY.getByName(REGISTRY_NAME).churches()
    expect(listed.find((church) => church.churchId === nameless)?.name).not.toBeNull()
  })

  it('adds no call to a push batch or a registration after a list and a backfill', async () => {
    await connectNamedAndNameless()
    await syncAllChurches(env)
    expect((await listChurchesWith(env)).status).toBe(200)
    const { churchId } = await seedChurch({ people: [ben], channels: [] })
    fakeExpoPush()
    const messages = batchOf(3)
    const registry = env.CHURCH_REGISTRY.getByName(REGISTRY_NAME)
    for (const message of messages) await registry.claimDevice(message.to, churchId)

    const batch = countingRegistry()
    await sendPushes(batch.bindings, churchId, messages)
    const registration = countingRegistry()
    const response = await registerDeviceWith(
      registration.bindings,
      churchId,
      'ben',
      tokenOf('ben'),
    )

    expect(batch.calls).toEqual(['ownedBy'])
    expect(response.status).toBe(204)
    expect(registration.calls.length).toBeLessThanOrEqual(REGISTRATION_BUDGET)
  })
})
