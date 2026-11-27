import type { BirthdateStatus } from '@phon/api-types'
import type { Refusal } from './church-directory.ts'
import { birthdateRequestPushes, sendPushes } from './expo-push.ts'
import type { Identity } from './identity.ts'
import { updateBirthdate } from './planning-center.ts'
import { closeLostSockets, type Directory } from './roster-sync.ts'

/**
 * A person's own birthdate entry and an admin's approval of one. Planning Center stays the one
 * source of a birthdate: one is stored here only once Planning Center has taken it, written with
 * the sync account's token, never the person's.
 */

/**
 * Why a birthdate could not be written to Planning Center: the church has no sync connection
 * (`unavailable`, 503), or Planning Center refused the write or the token refresh before it
 * (`write-failed`, 502). Nothing changes in either case.
 */
export type WriteRefusal = 'unavailable' | 'write-failed'

/**
 * `PUT /me/birthdate`. Under 18 the birthdate is written to Planning Center and then stored; under
 * 13 that also takes the person out of Phon, live sockets closed. 18 or older it waits for an
 * admin's approval, and the admins and the person's team leaders are alerted.
 */
export async function enterBirthdate(
  env: Env,
  identity: Identity,
  birthdate: unknown,
): Promise<BirthdateStatus | Refusal | WriteRefusal> {
  const directory = env.CHURCH_DIRECTORY.getByName(identity.churchId)
  const entry = await directory.birthdateEntry(identity, birthdate)
  if (typeof entry === 'string') return entry

  if (entry.outcome === 'pending') {
    try {
      await sendPushes(
        env,
        identity.churchId,
        birthdateRequestPushes(entry.name, identity.personId, entry.devices),
      )
    } catch (error) {
      console.error(`Alerting about ${identity.personId}'s birthdate request failed`, error)
    }
    return directory.birthdateStatus(identity)
  }

  const written = await writeBirthdate(directory, identity, identity.personId, entry.birthdate)
  if (written !== 'written') return written
  if (entry.ageGroup === 'under-13') {
    await closeLostSockets(env, directory, identity.churchId)
    return { birthdate: entry.birthdate, pendingBirthdate: null, ageGroup: 'under-13' }
  }
  return directory.birthdateStatus(identity)
}

/**
 * `POST /birthdate-requests/:personId/approval`: an admin approves a pending birthdate, which is
 * written to Planning Center and then stored. A failed write keeps the request.
 */
export async function approveBirthdate(
  env: Env,
  identity: Identity,
  personId: string,
): Promise<'approved' | Refusal | WriteRefusal> {
  const directory = env.CHURCH_DIRECTORY.getByName(identity.churchId)
  const approval = await directory.approvalOf(identity, personId)
  if (typeof approval === 'string') return approval
  const written = await writeBirthdate(directory, identity, personId, approval.birthdate)
  return written === 'written' ? 'approved' : written
}

/** Writes a birthdate to Planning Center with the sync account's token, then stores it. */
async function writeBirthdate(
  directory: Directory,
  identity: Identity,
  personId: string,
  birthdate: string,
): Promise<'written' | WriteRefusal> {
  let accessToken: string | null
  try {
    accessToken = await directory.syncAccessToken(identity.churchId)
  } catch (error) {
    console.error(`Refreshing ${identity.churchId}'s sync token for a birthdate failed`, error)
    return 'write-failed'
  }
  if (accessToken === null) return 'unavailable'
  if (!(await updateBirthdate(personId, birthdate, accessToken))) {
    console.error(`Planning Center refused ${personId}'s birthdate in ${identity.churchId}`)
    return 'write-failed'
  }
  await directory.recordBirthdate(identity.churchId, personId, birthdate)
  return 'written'
}
