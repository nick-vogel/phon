# Before screenshots for phon#189

Every screen of Phon before the redesign, in light mode and dark mode. Taken on 2026-11-24 in the iPhone 18 Pro Max Simulator (iOS 27.2), from the main checkout at `726b54d`, signed in as an admin. The status bar is set to 9:41 with a full battery, so the shots compare cleanly with the after shots of phon#269.

Each screen has two files, `<screen>-light.png` and `<screen>-dark.png`.

| Screen                         | File                 | How it was opened                                                                                      |
| ------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------ |
| Channel bar (the drawer, open) | `channel-drawer`     | at launch                                                                                              |
| Home placeholder               | `home`               | the drawer closed                                                                                      |
| Channel, no messages           | `channel-empty`      | # general, before any post                                                                             |
| Channel, with messages         | `channel`            | # general, with a short message, a long message and a GIF                                              |
| Channel alerts                 | `channel-alerts`     | Alerts in the channel header                                                                           |
| New channel                    | `new-channel`        | `phon://new-channel`                                                                                   |
| Roles                          | `roles`              | `phon://roles`                                                                                         |
| Group sync                     | `group-sync`         | `phon://group-sync`                                                                                    |
| Oversight log                  | `oversight`          | `phon://oversight`                                                                                     |
| Reports                        | `reports`            | `phon://reports`                                                                                       |
| Birthdate requests             | `birthdate-requests` | `phon://birthdate-requests`                                                                            |
| No birthdate                   | `missing-birthdates` | `phon://missing-birthdates`                                                                            |
| Birthdate                      | `birthdate`          | `phon://birthdate`                                                                                     |
| Quiet hours                    | `quiet-hours`        | `phon://quiet-hours`                                                                                   |
| Urgent alerts setup            | `urgent-setup`       | `phon://urgent-setup`                                                                                  |
| Oversight notice               | `oversight-notice`   | after sign-in, with the app told the notice was not yet seen (a temporary local change, not committed) |
| Sign in                        | `sign-in`            | signed out                                                                                             |
| Sign in with an email code     | `email-sign-in`      | `phon://email-sign-in`, signed out                                                                     |
| Connect the sync account       | `connect`            | signed out                                                                                             |

What the shots record:

- Only the message area of the chat screen follows dark mode. Every header, the drawer, and every other screen stay light, so the dark files of those screens look the same as the light files.
- Every button and link uses the same default blue.
- The Expo developer tools button (the grey gear at the top right) shows on every screen. It is part of the development build, not of the app.
