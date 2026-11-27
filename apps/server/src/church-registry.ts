import { DurableObject } from 'cloudflare:workers'

/**
 * A Durable Object's SQLite takes at most 100 bound parameters in one query, so `ownedBy` asks
 * about this many tokens at a time, with the church ID as the hundredth.
 */
const TOKENS_PER_QUERY = 99

/**
 * The churches with a connected sync account, which the roster sync walks on every tick, each
 * with its Planning Center name once one is read, and for each device's push token the churches
 * it is registered in. A church pushes only to tokens listed
 * here for it. One object, named `all`: a Cron Trigger cannot list Durable Objects, so the churches
 * list themselves here when their sync account connects.
 */
export class ChurchRegistry extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS churches (church_id TEXT PRIMARY KEY)')
    // A table of its own rather than a column on `churches`: creating it is additive, so a registry
    // made before names existed gains it on its next construction with no migration.
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS church_names (
         church_id TEXT PRIMARY KEY,
         name TEXT NOT NULL
       )`,
    )
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS device_churches (
         token TEXT NOT NULL,
         church_id TEXT NOT NULL,
         PRIMARY KEY (token, church_id)
       )`,
    )
  }

  /**
   * Lists a church, once, and stores its name when one is given, replacing any earlier one: a
   * connect reads the name fresh. A null name leaves any stored one alone.
   */
  register(churchId: string, name: string | null): void {
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO churches (church_id) VALUES (?)', churchId)
    if (name === null) return
    this.ctx.storage.sql.exec(
      `INSERT INTO church_names (church_id, name) VALUES (?, ?)
       ON CONFLICT (church_id) DO UPDATE SET name = excluded.name`,
      churchId,
      name,
    )
  }

  /**
   * Stores a listed church's name only when it has none: the roster sync's backfill, which never
   * replaces a stored name.
   */
  nameChurch(churchId: string, name: string): void {
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO church_names (church_id, name)
       SELECT church_id, ? FROM churches WHERE church_id = ?`,
      name,
      churchId,
    )
  }

  /** Every listed church, in ID order, with its stored name or null for none yet. */
  churches(): Array<{ churchId: string; name: string | null }> {
    return this.ctx.storage.sql
      .exec<{ church_id: string; name: string | null }>(
        `SELECT churches.church_id, church_names.name FROM churches
         LEFT JOIN church_names ON church_names.church_id = churches.church_id
         ORDER BY churches.church_id`,
      )
      .toArray()
      .map((row) => ({ churchId: row.church_id, name: row.name }))
  }

  /**
   * Lists a device's push token for a church. The route calls it only once the church holds the
   * token's row, so every church listed for a token holds a row for it.
   *
   * The app signs in to one church at a time, so the claim replaces the token's churches with this
   * one, and the last claim decides. This is the one place that rule lives: signing in to several
   * churches on one phone (phon#128) makes it an add.
   */
  claimDevice(token: string, churchId: string): void {
    this.ctx.storage.sql.exec('DELETE FROM device_churches WHERE token = ?', token)
    this.ctx.storage.sql.exec(
      'INSERT INTO device_churches (token, church_id) VALUES (?, ?)',
      token,
      churchId,
    )
  }

  /** The tokens of `tokens` listed for a church, in the order given. */
  ownedBy(churchId: string, tokens: string[]): string[] {
    const owned = new Set<string>()
    for (let start = 0; start < tokens.length; start += TOKENS_PER_QUERY) {
      const chunk = tokens.slice(start, start + TOKENS_PER_QUERY)
      const rows = this.ctx.storage.sql.exec<{ token: string }>(
        `SELECT token FROM device_churches
         WHERE church_id = ? AND token IN (${chunk.map(() => '?').join(', ')})`,
        churchId,
        ...chunk,
      )
      for (const row of rows) owned.add(row.token)
    }
    return tokens.filter((token) => owned.has(token))
  }
}

export { REGISTRY_NAME } from './registry-name.ts'
