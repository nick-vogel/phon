import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Member } from '@phon/api-types'
import { settingsSections } from '../src/settings-sections.ts'

/** A member with no permissions; each test turns on what it needs. */
function member(overrides: Partial<Member> = {}): Member {
  return {
    personId: 'p1',
    name: 'Sam Rivera',
    role: 'member',
    canCreate: [],
    canAssignRoles: false,
    canReadOversight: false,
    canMarkUrgent: false,
    canManageBirthdates: false,
    canModerate: false,
    ...overrides,
  }
}

/** Each section as its key, its title and its row labels. */
function outline(me: Member | null) {
  return settingsSections(me).map((section) => ({
    key: section.key,
    title: section.title,
    labels: section.rows.map((row) => row.label),
  }))
}

const MEMBER = {
  key: 'member',
  title: null,
  labels: ['Birthdate', 'Quiet hours', 'Urgent alerts setup'],
}
const APPEARANCE = { key: 'appearance', title: 'Appearance', labels: ['Appearance'] }
const SIGN_OUT = { key: 'sign-out', title: null, labels: ['Sign out'] }

describe('Settings for a member with no admin permission', () => {
  it('shows the member rows, Appearance and Sign out before the member has loaded', () => {
    assert.deepEqual(outline(null), [MEMBER, APPEARANCE, SIGN_OUT])
  })

  it('shows the member rows, Appearance and Sign out, and no Admin section', () => {
    assert.deepEqual(outline(member()), [MEMBER, APPEARANCE, SIGN_OUT])
  })

  it('holds the Appearance control as the one row of its own group', () => {
    const appearance = settingsSections(member()).find((section) => section.key === 'appearance')
    assert.deepEqual(appearance?.rows, [{ label: 'Appearance', control: 'appearance' }])
  })

  it('opens each member row on its screen, and signs out from the last', () => {
    const [own, , signOut] = settingsSections(member())
    assert.deepEqual(own?.rows, [
      { label: 'Birthdate', path: '/birthdate' },
      { label: 'Quiet hours', path: '/quiet-hours' },
      { label: 'Urgent alerts setup', path: '/urgent-setup' },
    ])
    assert.deepEqual(signOut?.rows, [{ label: 'Sign out', action: 'sign-out' }])
  })
})

/** The Admin section's rows, or null when Settings has none. */
function adminRows(me: Member) {
  const admin = settingsSections(me).find((section) => section.key === 'admin')
  return admin === undefined ? null : admin.rows
}

describe('the Admin section of Settings', () => {
  it('shows Roles and Group sync to a member who may assign roles', () => {
    assert.deepEqual(adminRows(member({ canAssignRoles: true })), [
      { label: 'Roles', path: '/roles' },
      { label: 'Group sync', path: '/group-sync' },
    ])
  })

  it('shows the oversight log to a member who may read it', () => {
    assert.deepEqual(adminRows(member({ canReadOversight: true })), [
      { label: 'Oversight log', path: '/oversight' },
    ])
  })

  it('shows Reports to a member who moderates', () => {
    assert.deepEqual(adminRows(member({ canModerate: true })), [
      { label: 'Reports', path: '/reports' },
    ])
  })

  it('shows the birthdate lists to a member who manages birthdates', () => {
    assert.deepEqual(adminRows(member({ canManageBirthdates: true })), [
      { label: 'Birthdate requests', path: '/birthdate-requests' },
      { label: 'No birthdate', path: '/missing-birthdates' },
    ])
  })

  it('shows every admin row to an admin, between Appearance and Sign out', () => {
    const admin = member({
      role: 'admin',
      canCreate: ['open', 'private'],
      canAssignRoles: true,
      canReadOversight: true,
      canMarkUrgent: true,
      canManageBirthdates: true,
      canModerate: true,
    })
    assert.deepEqual(outline(admin), [
      MEMBER,
      APPEARANCE,
      {
        key: 'admin',
        title: 'Admin',
        labels: [
          'Roles',
          'Group sync',
          'Oversight log',
          'Reports',
          'Birthdate requests',
          'No birthdate',
        ],
      },
      SIGN_OUT,
    ])
  })

  it('has no row for creating channels or marking urgent, which live elsewhere', () => {
    assert.equal(adminRows(member({ canCreate: ['open', 'private'] })), null)
    assert.equal(adminRows(member({ canMarkUrgent: true })), null)
  })
})
