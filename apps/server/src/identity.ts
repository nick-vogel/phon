/** Who is making a request: one person in one church. */
export interface Identity {
  churchId: string
  personId: string
}

/**
 * Turns a request into the identity it carries, or null when it carries none.
 *
 * The deployed Worker passes the session authenticator (`src/session.ts`), and the test entry its
 * own. Only the test entry's authenticator accepts the seeded test identities.
 */
export type Authenticate = (
  request: Request,
  env: Env,
) => Identity | null | Promise<Identity | null>
