import type { ChannelSummary } from '@phon/api-types'

/** The channel screen's route params, all strings because expo-router passes params as strings. */
export type ChannelRouteParams = {
  channelId: string
  name: string
  canPost: string
  oversight: string
  leads: string
}

/**
 * The params that open the channel screen on a channel the server summarised. Every entry into the
 * screen builds them here, so each of the server's flags reaches the screen whichever way it was
 * opened: an admin who creates a private channel without picking themselves gets the oversight
 * screen, as the channel list would open it.
 */
export function channelRouteParams(channel: ChannelSummary): ChannelRouteParams {
  return {
    channelId: channel.id,
    name: channel.name,
    canPost: String(channel.canPost),
    oversight: String(channel.oversight === true),
    leads: String(channel.leads === true),
  }
}
