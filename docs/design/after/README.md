# After screenshots for phon#189

Every screen of Phon after the redesign, in light mode and dark mode, for phon#269. Taken on 2026-11-25 in the iPhone 18 Pro Max Simulator (iOS 27.2), from the integration branch at `cd6db2a`, signed in as an admin. The status bar is set to 9:41 with a full battery, as in the before shots in `../before/`, so each pair compares cleanly.

Each screen has two files, `<screen>-light.png` and `<screen>-dark.png`. The app's Appearance choice is System, so each file follows the Simulator's mode. Text size is the Simulator's default.

| Screen                     | File                 | How it was opened                                                                                  | Before file               |
| -------------------------- | -------------------- | -------------------------------------------------------------------------------------------------- | ------------------------- |
| Channels                   | `channels`           | at launch                                                                                          | `channel-drawer`, `home`  |
| Settings                   | `settings`           | Settings in the Channels header                                                                    | none (the drawer held it) |
| Channel, no messages       | `channel-empty`      | # off-topic, which has no posts                                                                    | `channel-empty`           |
| Channel, with messages     | `channel`            | # general, with the short message, the long message and the GIF from the before shots              | `channel`                 |
| Channel alerts             | `channel-alerts`     | the bell in the channel header                                                                     | `channel-alerts`          |
| New channel                | `new-channel`        | `phon://new-channel`                                                                               | `new-channel`             |
| Roles                      | `roles`              | `phon://roles`                                                                                     | `roles`                   |
| Group sync                 | `group-sync`         | `phon://group-sync`                                                                                | `group-sync`              |
| Oversight log              | `oversight`          | `phon://oversight`                                                                                 | `oversight`               |
| Reports                    | `reports`            | `phon://reports`                                                                                   | `reports`                 |
| Birthdate requests         | `birthdate-requests` | `phon://birthdate-requests`                                                                        | `birthdate-requests`      |
| No birthdate               | `missing-birthdates` | `phon://missing-birthdates`                                                                        | `missing-birthdates`      |
| Birthdate                  | `birthdate`          | `phon://birthdate`                                                                                 | `birthdate`               |
| Quiet hours                | `quiet-hours`        | `phon://quiet-hours`                                                                               | `quiet-hours`             |
| Urgent alerts setup        | `urgent-setup`       | `phon://urgent-setup`                                                                              | `urgent-setup`            |
| Oversight notice           | `oversight-notice`   | at launch, with the app told the notice was not yet seen (a temporary local change, not committed) | `oversight-notice`        |
| Sign in                    | `sign-in`            | signed out                                                                                         | `sign-in`                 |
| Sign in with an email code | `email-sign-in`      | `phon://email-sign-in`, signed out                                                                 | `email-sign-in`           |
| Connect the sync account   | `connect`            | `phon://connect`, signed out                                                                       | `connect`                 |

Each deep-linked screen was opened from Channels, so its Back button reads Channels.

What the shots record:

- Every screen follows dark mode, headers included.
- Actions use the church's accent: filled buttons for a screen's main action, accent text for an action inside a group.
- The Expo developer tools button is turned off for these shots (the dev client opened with `__expo_disable_fab=1`). It is part of the development build, not of the app.
- The dark files show the header's glass buttons drawn light, with accent glyphs that read poorly (Channels, the chat screen, and the Back chevron on Connect). phon#322 fixed this after the shots: the header now takes the dark interface style, so its glass draws dark and the glyphs read at about 5.8:1.
