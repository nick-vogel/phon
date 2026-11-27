import type { Report } from '@phon/api-types'

/** What one report says, as the two read-only rows of its group on the Reports screen. */
export interface ReportRows {
  /** The reported message: its author and text, and a mark when it is gone. */
  message: { title: string; subtitle: string | null }
  /** Who reported it and when. */
  reported: { title: string; subtitle: string }
}

/**
 * The rows for one open report. An admin receives a message removed since, and sees whether its
 * author deleted it or a moderator removed it; a chat admin receives no message, and is told it
 * has since been deleted. `formatTime` tells the report's time, in the phone's locale by default.
 */
export function reportRows(
  report: Report,
  formatTime: (iso: string) => string = (iso) => new Date(iso).toLocaleString(),
): ReportRows {
  const { message, authorId, authorName } = report
  let subtitle: string | null = null
  if (message === null) subtitle = 'This message has since been deleted.'
  else if (message.deleted !== undefined) {
    subtitle =
      message.deleted.by === authorId
        ? 'Deleted by its author'
        : 'Removed by an admin or chat admin'
  }
  return {
    message: {
      title: message === null ? authorName : `${authorName}: ${message.body}`,
      subtitle,
    },
    reported: {
      title: `Reported by ${report.reporterName}`,
      subtitle: formatTime(report.reportedAt),
    },
  }
}
