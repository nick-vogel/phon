import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it } from 'vitest'
import { network } from './support/network.ts'

describe('the network recorder', () => {
  afterEach(() => {
    // These tests make unstubbed calls on purpose; the shared afterEach would fail them.
    network.reset()
  })

  it('refuses an unstubbed call and names it', async () => {
    await expect(fetch('https://api.planningcenteronline.com/people/v2/me')).rejects.toThrow(
      'Unstubbed fetch: GET https://api.planningcenteronline.com/people/v2/me',
    )
  })

  it('still fails the test when the code under test swallowed the rejection', async () => {
    await fetch('https://exp.host/--/api/v2/push/send', { method: 'POST' }).catch(() => {})

    expect(() => network.verify()).toThrow(
      'Unstubbed fetch: POST https://exp.host/--/api/v2/push/send',
    )
  })

  it('answers a stubbed call and records it', async () => {
    network.stub('POST', 'https://api.example.test/things', () =>
      Response.json({ ok: true }, { status: 201 }),
    )

    const response = await fetch('https://api.example.test/things', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'one' }),
    })

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ ok: true })
    expect(network.calls()).toEqual([
      {
        method: 'POST',
        url: 'https://api.example.test/things',
        headers: { 'content-type': 'application/json' },
        body: '{"name":"one"}',
        at: expect.any(Number),
      },
    ])
    expect(() => network.verify()).not.toThrow()
  })

  it('does not answer a stub registered for another method', async () => {
    network.stub('GET', 'https://api.example.test/things', () => new Response('listed'))

    await expect(fetch('https://api.example.test/things', { method: 'DELETE' })).rejects.toThrow(
      'Unstubbed fetch: DELETE https://api.example.test/things',
    )
  })

  it('answers a path stub for a call to that path with any query', async () => {
    network.stubPath('GET', 'https://api.example.test/pages', (request) =>
      Response.json({ url: request.url }),
    )

    const first = await fetch('https://api.example.test/pages?per_page=2&offset=0')
    const second = await fetch('https://api.example.test/pages?per_page=2&offset=2')

    expect(await first.json()).toEqual({
      url: 'https://api.example.test/pages?per_page=2&offset=0',
    })
    expect(await second.json()).toEqual({
      url: 'https://api.example.test/pages?per_page=2&offset=2',
    })
    expect(() => network.verify()).not.toThrow()
  })

  it('lets an exact stub win over a path stub', async () => {
    network.stubPath('GET', 'https://api.example.test/pages', () => new Response('by path'))
    network.stub('GET', 'https://api.example.test/pages?offset=4', () => new Response('exact'))

    const exact = await fetch('https://api.example.test/pages?offset=4')
    const byPath = await fetch('https://api.example.test/pages?offset=6')

    expect(await exact.text()).toBe('exact')
    expect(await byPath.text()).toBe('by path')
  })

  it('still refuses a call to another path or method than a path stub names', async () => {
    network.stubPath('GET', 'https://api.example.test/pages', () => new Response('by path'))

    await expect(fetch('https://api.example.test/pages/1?offset=0')).rejects.toThrow(
      'Unstubbed fetch: GET https://api.example.test/pages/1?offset=0',
    )
    await expect(fetch('https://api.example.test/pages', { method: 'POST' })).rejects.toThrow(
      'Unstubbed fetch: POST https://api.example.test/pages',
    )
    expect(() => network.verify()).toThrow()
  })

  it('records a call made inside a Durable Object, which shares the test isolate', async () => {
    const stub = env.CHANNEL.getByName('network-recorder-check')

    const status = await runInDurableObject(stub, async () => {
      network.stub('GET', 'https://api.example.test/inside', () => new Response('from the stub'))
      const response = await fetch('https://api.example.test/inside')
      return response.status
    })

    expect(status).toBe(200)
    expect(network.calls().map((call) => call.url)).toEqual(['https://api.example.test/inside'])
  })
})
