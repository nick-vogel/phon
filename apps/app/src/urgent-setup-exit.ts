import type { ImperativeRouter } from 'expo-router'

/** The router calls that leave the urgent setup screen. */
export type UrgentSetupExitRouter = Pick<ImperativeRouter, 'canGoBack' | 'back' | 'replace'>

/**
 * Leaves the urgent setup screen once the person is done. Opened from Settings, it goes back there.
 * On first run the layout's guards made it the stack's only screen, so the channel list takes its
 * place and becomes the root, with nothing under it for Back to return to. A push of `/` would
 * leave the setup screen under the list, or a second list on top of Settings.
 */
export function leaveUrgentSetup(router: UrgentSetupExitRouter): void {
  if (router.canGoBack()) router.back()
  else router.replace('/')
}
