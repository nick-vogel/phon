import { network } from './network.ts'

/** Planning Center's API origin, the only origin the fake answers for. */
export const PLANNING_CENTER = 'https://api.planningcenteronline.com'

/** The client ID and secret `vitest.config.ts` gives the Worker. */
export const TEST_CLIENT = { id: 'phon-test-client', secret: 'phon-test-secret' } as const

/** The ID token claims the fake signs a person in with. A test may override any of them. */
export interface IdTokenClaims {
  iss: string
  sub: string
  aud: string
  organization_id: number
  organization_name: string
  name: string
  nonce: string
  iat: number
  exp: number
}

interface PendingCode {
  challenge: string
  redirectUri: string
  clientId: string
  scope: string
  claims: IdTokenClaims
  administrator: boolean
  used: boolean
}

/** Who an access or refresh token was issued to, in which organization, and what it may reach. */
interface Grant {
  personId: string
  organizationId: number
  scope: string
  administrator: boolean
}

/** A person signing in at the fake Planning Center. */
export interface FakeSignIn {
  organizationId: number
  personId: string
  /** Claims to put in the ID token in place of the ones the fake would set. */
  claims?: Partial<IdTokenClaims>
  /** Whether the person is an organization administrator (`site_administrator`). */
  administrator?: boolean
}

export interface FakePlanningCenterOptions {
  /** The `expires_in`, in seconds, of the access tokens a code exchange issues. Default 7200. */
  codeTokenLifetime?: number
  /** The `expires_in`, in seconds, of the access tokens a refresh issues. Default 7200. */
  refreshTokenLifetime?: number
  /**
   * How long, in milliseconds, the token endpoint waits before it answers a refresh. Default 0.
   * A stub otherwise answers within one turn of the event loop, where a real refresh is a round
   * trip that lets other calls run while it is out.
   */
  refreshDelayMs?: number
}

/**
 * A fake Planning Center over the network recorder. It plays Planning Center's authorize page
 * (`authorize`) and stubs its token endpoint, checking the form the way Planning Center does. The
 * token endpoint also refreshes, rotating the refresh token, `GET /people/v2/me` answers who an
 * access token belongs to and whether they are an organization administrator, and `GET /people/v2`
 * answers the organization the token's person signed in with, named `Church <organizationId>`
 * unless the test renames it.
 */
export function fakePlanningCenter(options: FakePlanningCenterOptions = {}) {
  const codes = new Map<string, PendingCode>()
  const issued: string[] = []
  const accessGrants = new Map<string, Grant>()
  const refreshGrants = new Map<string, Grant & { used: boolean }>()
  /** The access token each person was issued last. */
  const currentAccess = new Map<string, string>()
  /** Organization names a test set in place of `Church <organizationId>`. */
  const organizationNames = new Map<number, string>()
  /** How many of the next organization reads answer 500. */
  let failingOrganizationReads = 0
  /** The `Retry-After` of each of the next organization reads that answer 429, null for none. */
  let throttledOrganizationReads: Array<string | null> = []
  /** How many of the next organization reads answer with the rate limit reached. */
  let organizationReadsAtLimit = 0

  function issue(grant: Grant, lifetime: number, idToken?: string) {
    const tokens = {
      access_token: `pco-access-${randomPart()}`,
      refresh_token: `pco-refresh-${randomPart()}`,
      ...(idToken === undefined ? {} : { id_token: idToken }),
    }
    issued.push(...Object.values(tokens))
    accessGrants.set(tokens.access_token, grant)
    refreshGrants.set(tokens.refresh_token, { ...grant, used: false })
    currentAccess.set(grant.personId, tokens.access_token)
    return Response.json({
      ...tokens,
      token_type: 'bearer',
      expires_in: lifetime,
      scope: grant.scope,
      created_at: Math.floor(Date.now() / 1000),
    })
  }

  network.stub('POST', `${PLANNING_CENTER}/oauth/token`, async (request) => {
    // Planning Center may refuse a request with no User-Agent.
    if (!request.headers.get('user-agent')) {
      return Response.json({ error: 'forbidden' }, { status: 403 })
    }
    const form = new URLSearchParams(await request.text())
    const client =
      form.get('client_id') === TEST_CLIENT.id && form.get('client_secret') === TEST_CLIENT.secret

    if (form.get('grant_type') === 'refresh_token') {
      if (options.refreshDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.refreshDelayMs))
      }
      const grant = refreshGrants.get(form.get('refresh_token') ?? '')
      const refused = grant === undefined || grant.used || !client
      if (grant !== undefined) grant.used = true
      if (refused) return Response.json({ error: 'invalid_grant' }, { status: 400 })
      return issue(
        {
          personId: grant.personId,
          organizationId: grant.organizationId,
          scope: grant.scope,
          administrator: grant.administrator,
        },
        options.refreshTokenLifetime ?? 7200,
      )
    }

    const pending = codes.get(form.get('code') ?? '')
    const refused =
      pending === undefined ||
      pending.used ||
      form.get('grant_type') !== 'authorization_code' ||
      !client ||
      form.get('client_id') !== pending.clientId ||
      form.get('redirect_uri') !== pending.redirectUri ||
      (await s256(form.get('code_verifier') ?? '')) !== pending.challenge
    if (pending !== undefined) pending.used = true
    if (refused) return Response.json({ error: 'invalid_grant' }, { status: 400 })

    return issue(
      {
        personId: pending.claims.sub,
        organizationId: pending.claims.organization_id,
        scope: pending.scope,
        administrator: pending.administrator,
      },
      options.codeTokenLifetime ?? 7200,
      unsignedJwt(pending.claims),
    )
  })

  network.stub('GET', `${PLANNING_CENTER}/people/v2/me`, (request) => {
    const grant = grantFor(request)
    if (grant === undefined || !grant.scope.split(' ').includes('people')) {
      return Response.json({ errors: [{ status: '401' }] }, { status: 401 })
    }
    return Response.json({
      data: {
        type: 'Person',
        id: grant.personId,
        attributes: { site_administrator: grant.administrator },
      },
    })
  })

  // A path stub: `planningCenterGet` adds `per_page` to every read.
  network.stubPath('GET', `${PLANNING_CENTER}/people/v2`, (request) => {
    if (!request.headers.get('user-agent')) {
      return Response.json({ error: 'forbidden' }, { status: 403 })
    }
    const grant = grantFor(request)
    if (grant === undefined || !grant.scope.split(' ').includes('people')) {
      return Response.json({ errors: [{ status: '401' }] }, { status: 401 })
    }
    if (failingOrganizationReads > 0) {
      failingOrganizationReads -= 1
      return Response.json({ errors: [{ status: '500' }] }, { status: 500 })
    }
    const throttle = throttledOrganizationReads.shift()
    if (throttle !== undefined) {
      return Response.json(
        { errors: [{ status: '429', title: 'Too Many Requests' }] },
        { status: 429, headers: throttle === null ? {} : { 'retry-after': throttle } },
      )
    }
    const atLimit = organizationReadsAtLimit > 0
    if (atLimit) organizationReadsAtLimit -= 1
    return Response.json(
      {
        data: {
          type: 'Organization',
          id: String(grant.organizationId),
          attributes: { name: organizationNameOf(grant.organizationId) },
        },
      },
      {
        headers: atLimit
          ? {
              'x-pco-api-request-rate-limit': '100',
              'x-pco-api-request-rate-period': '20',
              'x-pco-api-request-rate-count': '100',
            }
          : {},
      },
    )
  })

  function organizationNameOf(organizationId: number): string {
    return organizationNames.get(organizationId) ?? `Church ${organizationId}`
  }

  /** The grant behind a request's `Authorization: Bearer <access token>`, if any. */
  function grantFor(request: Request): Grant | undefined {
    const match = /^Bearer (\S+)$/.exec(request.headers.get('authorization') ?? '')
    return match === null ? undefined : accessGrants.get(match[1] as string)
  }

  return {
    /**
     * Plays the authorize page for one person: reads the `/auth/start` redirect, mints a code bound
     * to its challenge, redirect URI and nonce, and returns the URL Planning Center sends the
     * browser back to.
     */
    authorize(location: string | null, person: FakeSignIn): URL {
      if (location === null) throw new Error('The start route sent no Location')
      const authorize = new URL(location)
      if (`${authorize.origin}${authorize.pathname}` !== `${PLANNING_CENTER}/oauth/authorize`) {
        throw new Error(`Not Planning Center's authorize URL: ${location}`)
      }
      const query = authorize.searchParams
      const redirectUri = query.get('redirect_uri') ?? ''
      const now = Math.floor(Date.now() / 1000)
      const code = `pco-code-${randomPart()}`
      codes.set(code, {
        challenge: query.get('code_challenge') ?? '',
        redirectUri,
        clientId: query.get('client_id') ?? '',
        scope: query.get('scope') ?? '',
        administrator: person.administrator ?? false,
        used: false,
        claims: {
          iss: PLANNING_CENTER,
          sub: person.personId,
          aud: query.get('client_id') ?? '',
          organization_id: person.organizationId,
          organization_name: `Church ${person.organizationId}`,
          name: person.personId,
          nonce: query.get('nonce') ?? '',
          iat: now,
          exp: now + 3600,
          ...person.claims,
        },
      })
      const back = new URL(redirectUri)
      back.searchParams.set('code', code)
      back.searchParams.set('state', query.get('state') ?? '')
      return back
    },

    /** Every token the fake's token endpoint has issued: access, refresh and ID tokens. */
    issuedTokens(): string[] {
      return [...issued]
    },

    /** The access token the fake issued a person last, by code exchange or by refresh. */
    accessTokenOf(personId: string): string | undefined {
      return currentAccess.get(personId)
    },

    /** The grant behind a request's bearer token, for fakes of other Planning Center APIs. */
    grantFor,

    /** Renames an organization in Planning Center People, for every later read. */
    renameOrganization(organizationId: number, name: string): void {
      organizationNames.set(organizationId, name)
    },

    /** Makes the next `count` organization reads (`GET /people/v2`) answer 500. */
    failOrganizationReads(count: number): void {
      failingOrganizationReads = count
    },

    /**
     * Makes the next organization reads answer 429, one for each entry, with the entry as its
     * `Retry-After` (none for null).
     */
    throttleOrganizationReads(retryAfters: Array<string | null>): void {
      throttledOrganizationReads = [...retryAfters]
    },

    /**
     * Makes the next `count` organization reads answer with the rate limit reached: 100 of 100
     * calls used in a 20-second period.
     */
    reachRateLimitOnOrganizationReads(count: number): void {
      organizationReadsAtLimit = count
    },
  }
}

/** A PKCE verifier and its S256 challenge, made the way the app makes them. */
export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
  return { verifier, challenge: await s256(verifier) }
}

/** A random URL-safe value, for a state or a nonce. */
export function randomPart(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(16)))
}

/** A Planning Center organization ID no other test uses. */
export function newOrganizationId(): number {
  return 100_000 + (crypto.getRandomValues(new Uint32Array(1))[0] as number)
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64url(new Uint8Array(digest))
}

/** A JWT with Planning Center's header and a signature no one checks. */
function unsignedJwt(claims: IdTokenClaims): string {
  const encode = (value: object) => base64url(new TextEncoder().encode(JSON.stringify(value)))
  const signature = base64url(crypto.getRandomValues(new Uint8Array(32)))
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}.${signature}`
}

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
