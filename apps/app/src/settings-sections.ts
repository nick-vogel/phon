import type { Member } from '@phon/api-types'

/** The screens a Settings row opens. */
export type SettingsPath =
  | '/birthdate'
  | '/quiet-hours'
  | '/urgent-setup'
  | '/roles'
  | '/group-sync'
  | '/oversight'
  | '/reports'
  | '/birthdate-requests'
  | '/missing-birthdates'

/** A row that opens a screen, the row holding the Appearance control, or the one that signs out. */
export type SettingsRow =
  | { label: string; path: SettingsPath }
  | { label: 'Appearance'; control: 'appearance' }
  | { label: string; action: 'sign-out' }

export interface SettingsSection {
  key: 'member' | 'appearance' | 'admin' | 'sign-out'
  title: string | null
  rows: SettingsRow[]
}

/**
 * Settings' rows: everything the drawer's channel bar held but the channels, and the Appearance
 * control. The member rows, Appearance and Sign out show for everyone; each Admin row shows when
 * the server says this member may use its screen, by the same flags the channel bar read, and the
 * Admin section goes when it has no row.
 * New channel is not here: the channel list's compose button opens it.
 */
export function settingsSections(me: Member | null): SettingsSection[] {
  const admin: SettingsRow[] = []
  if (me?.canAssignRoles === true) {
    admin.push({ label: 'Roles', path: '/roles' }, { label: 'Group sync', path: '/group-sync' })
  }
  if (me?.canReadOversight === true) admin.push({ label: 'Oversight log', path: '/oversight' })
  if (me?.canModerate === true) admin.push({ label: 'Reports', path: '/reports' })
  if (me?.canManageBirthdates === true) {
    admin.push(
      { label: 'Birthdate requests', path: '/birthdate-requests' },
      { label: 'No birthdate', path: '/missing-birthdates' },
    )
  }
  return [
    {
      key: 'member',
      title: null,
      rows: [
        { label: 'Birthdate', path: '/birthdate' },
        { label: 'Quiet hours', path: '/quiet-hours' },
        { label: 'Urgent alerts setup', path: '/urgent-setup' },
      ],
    },
    {
      key: 'appearance',
      title: 'Appearance',
      rows: [{ label: 'Appearance', control: 'appearance' }],
    },
    ...(admin.length > 0 ? [{ key: 'admin' as const, title: 'Admin', rows: admin }] : []),
    { key: 'sign-out', title: null, rows: [{ label: 'Sign out', action: 'sign-out' }] },
  ]
}
