import { createExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { REGISTRY_NAME } from '../../src/church-registry.ts'
import { createWorker } from '../../src/worker.ts'
import { withCaller } from './callers.ts'
import { testIdentity } from './church.ts'
import { refusingMailer } from './mailer.ts'
import { testIdentities } from './test-worker.ts'

/**
 * The Worker's bindings with stand-ins, and a Worker that runs a request on them. A test reaches a
 * failure inside a Durable Object call this way, through the route a person calls.
 */

/** The given bindings, with one binding replaced. */
function envWith(
  base: Env,
  name: 'CHANNEL' | 'CHURCH_DIRECTORY' | 'CHURCH_REGISTRY',
  binding: object,
): Env {
  return new Proxy(base, {
    get: (target, property) => (property === name ? binding : Reflect.get(target, property)),
  })
}

/** The Worker's bindings, or the given ones, with one church's directory answered by a stub. */
export function envWithDirectory(churchId: string, directory: object, base: Env = env): Env {
  const directories = new Proxy(base.CHURCH_DIRECTORY, {
    get: (target, property) =>
      property === 'getByName'
        ? (name: string) => (name === churchId ? directory : target.getByName(name))
        : Reflect.get(target, property),
  })
  return envWith(base, 'CHURCH_DIRECTORY', directories)
}

/** The Worker's bindings, with every `evict` on one channel object failing like a reset object. */
export function envWithFailingEvict(objectName: string): Env {
  const failing = {
    evict: async () => {
      throw new Error('Durable Object reset')
    },
  }
  const channels = new Proxy(env.CHANNEL, {
    get: (target, property) =>
      property === 'getByName'
        ? (name: string) => (name === objectName ? failing : target.getByName(name))
        : Reflect.get(target, property),
  })
  return envWith(env, 'CHANNEL', channels)
}

/** The Worker's bindings, or the given ones, with the registry answered by the given stub. */
export function envWithRegistry(registry: object, base: Env = env): Env {
  const registries = new Proxy(base.CHURCH_REGISTRY, {
    get: (target, property) =>
      property === 'getByName' ? () => registry : Reflect.get(target, property),
  })
  return envWith(base, 'CHURCH_REGISTRY', registries)
}

/**
 * The real registry, with some of its calls answered by stand-ins. Every other call goes through
 * to the registry itself.
 */
function registryWith(overrides: Record<string, (...args: never[]) => Promise<unknown>>): object {
  const registry = env.CHURCH_REGISTRY.getByName(REGISTRY_NAME)
  return new Proxy(registry, {
    get: (target, property) => {
      if (typeof property === 'string' && property in overrides) return overrides[property]
      const value = Reflect.get(target, property)
      // `Reflect.apply`: an RPC method is not a plain function, and has no `apply` of its own.
      return typeof value === 'function'
        ? (...args: unknown[]) => Reflect.apply(value, target, args)
        : value
    },
  })
}

/**
 * The Worker's bindings, with every `claimDevice` on the registry failing: before it takes effect,
 * or once it has.
 */
export function envWithFailingClaim(when: 'before' | 'after'): Env {
  const registry = env.CHURCH_REGISTRY.getByName(REGISTRY_NAME)
  return envWithRegistry(
    registryWith({
      claimDevice: async (token: string, churchId: string) => {
        if (when === 'after') await registry.claimDevice(token, churchId)
        throw new Error('Durable Object reset')
      },
    }),
  )
}

/**
 * The Worker's bindings, with every `claimDevice` on the registry held until the test opens it:
 * `reached` resolves once a claim is waiting, and `open` lets it through.
 */
export function envWithHeldClaim() {
  const registry = env.CHURCH_REGISTRY.getByName(REGISTRY_NAME)
  let reach = () => {}
  let open = () => {}
  const reached = new Promise<void>((resolve) => {
    reach = resolve
  })
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  const bindings = envWithRegistry(
    registryWith({
      claimDevice: async (token: string, churchId: string) => {
        reach()
        await opened
        return registry.claimDevice(token, churchId)
      },
    }),
  )
  return { bindings, reached, open }
}

/** Runs one request as a person of a church, through a Worker running on the given bindings. */
export async function requestWith(
  bindings: Env,
  churchId: string,
  personId: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const worker = createWorker({ authenticate: testIdentities, mailer: refusingMailer })
  const headers = withCaller(init.headers)
  headers.set('authorization', testIdentity(churchId, personId))
  const request = new Request(`https://phon.test${path}`, {
    ...init,
    headers,
  }) as Request<unknown, IncomingRequestCfProperties>
  const response = await worker.fetch?.(request, bindings, createExecutionContext())
  if (response === undefined) throw new Error('The Worker has no fetch handler')
  return response
}

/** Registers a person's device through a Worker running on the given bindings. */
export function registerDeviceWith(
  bindings: Env,
  churchId: string,
  personId: string,
  token: string,
): Promise<Response> {
  return requestWith(bindings, churchId, personId, '/devices', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
}
