# Design references for phon#189

The samples teach patterns. Phon copies no single app's look: the colours come from the theme module (mist base, the default teal accent), and the shapes come from the spec in phon#189.

The images are not in the repo. They show other companies' apps and real conversations, so they live in Nick's iCloud Drive:

`~/Library/Mobile Documents/com~apple~CloudDocs/knowsmore-assets/phon-189-design-references/`

Nick took them on his iPhone on 2026-11-24. The before screenshots of Phon itself are in the repo, in `docs/design/before/`.

## Coverage

14 samples, not the 30 the spec planned. Nick chose to run with these on 2026-11-24.

| Surface          | Slack                                   | iMessage    | Discord |
| ---------------- | --------------------------------------- | ----------- | ------- |
| Message list     | light, dark                             | light, dark | dark    |
| Composer         | light                                   | light       | dark    |
| Channel list     | light                                   | light       | dark    |
| Notice or banner | in the message list and the empty state | light       | none    |
| Empty state      | light                                   | light       | none    |

Discord shows only dark mode on Nick's phone. Every surface has a sample from at least one of the three apps, so no sample from a public source was needed (phon#245, criterion 2).

## Message list

### imessage-message-list-light.png, imessage-message-list-dark.png

Teaches: other people's bubbles on the left in a grey surface, with the sender's name in small grey text above the first bubble of a run and the avatar beside the last. A centred day and time line ("Yesterday 7:30 AM") separates the days. A reaction sits on the bubble's top corner and does not push the layout. The dark sample shows the same layout with only the surfaces changed.

Phon does not copy: the bubble tails, the blue and green own-message colours, or the large rounded radius. Phon uses a 10 pt radius with no tail and the accent fill for the member's own messages.

### slack-message-list-light.png, slack-message-list-dark.png

Teaches: the author's name in bold with the time beside it, once per run of messages. A link preview, a thread reply count ("3 replies"), and the "(edited)" mark sit under the message text in the same column. Two notices sit on top of the list without covering a message: a "20+ unread" pill at the top, and an "external people" banner just above the composer.

Phon does not copy: the flat, bubble-less list with a square avatar on every run. Phon uses bubbles. Phon has no threads or external people.

### discord-message-list-dark.png

Teaches: a coloured author name with a role tag beside it, and the time in muted text on the same line. Reaction pills with a count sit under the message, and a reply shows a small quoted line above the reply.

Phon does not copy: the per-role name colours, the flat list, or the dense type. Phon's names use the foreground token, so every name meets AA contrast in both modes.

## Composer

### imessage-composer-light.png

Teaches: one rounded field with a plus button to its left for attachments, and a round send button inside the field that shows only when the field holds text. The send button is the one strong colour on the screen.

Phon does not copy: the microphone button or the system blue. Phon keeps its GIF and Urgent controls (phon#15 keeps the "Search KLIPY" placeholder), and its send button uses the accent fill with the text colour on the fill, never white (phon#276).

### slack-composer-light.png

Teaches: the text field above a row of small formatting icons (Aa, emoji, @ mention, slash command), with the send button at the right end of that row.

Phon does not copy: the formatting row or the slash commands. The @ mention control is a pattern to note, because Phon already has mention suggestions.

### discord-composer-dark.png

Teaches: a compact composer that keeps the plus, emoji and send controls inside one rounded field, so the keyboard leaves more room for the list.

Phon does not copy: the Nitro gift button, or the blue send button.

## Channel list

### slack-channel-list-light.png

Teaches: sections with a heading and a disclosure chevron (Channels, Direct Messages, Apps), a "#" icon before each channel name, and an "Add channel" row at the end of the section. A floating compose button sits over the bottom right.

Phon does not copy: the bottom tab bar (out of scope in phon#189), the direct messages, or the purple brand colour. Phon puts compose in the channel list header (phon#189, user story 10).

### imessage-channel-list-light.png

Teaches: each row shows the name in bold, the last message as two lines of muted preview text, and the time at the right with a chevron. The search field sits at the bottom, within reach of the thumb. Pinned conversations show as large avatars at the top.

Phon does not copy: the pinned avatar grid, or the bottom search field. The row shape (name, author and last message, time) is the pattern for phon#259, with the data from phon#242.

### discord-channel-list-dark.png

Teaches: the channels grouped under collapsible category headings, a "#" or a type icon before each name, the open channel on a highlighted row, and an unread count at the right of a row.

Phon does not copy: the server rail on the left, the member's profile footer, or the dark-only palette.

## Notice or banner

### imessage-notice-light.png

Teaches: a notice as a floating rounded card at the top of the conversation, with an icon, two lines of text, one action button ("Add"), and a close button. It covers the list for a short time and does not move it.

Phon does not copy: the close button on every notice. Phon's drop notices stay until the connection comes back, and they keep their Reconnect button (phon#258).

### Slack notices, in slack-message-list-light.png and slack-empty-state-light.png

Teaches: three kinds of notice. A small pill ("20+ unread") with a close button floats over the top of the list. A full-width tinted banner sits just above the composer ("20 external people are from another company"). An inline card in the list carries a tag ("PRO"), a sentence, and a link ("Start a free trial").

Phon does not copy: the upsell card. The banner above the composer is the closest pattern for "Disconnected from live messages", because it stays near the place where the member posts.

## Empty state

### slack-empty-state-light.png

Teaches: an empty channel opens on a "Welcome!" heading, one plain sentence that says what the place is for, and two large action buttons with an icon above each label.

Phon does not copy: the generic welcome text. Phon's empty channel says what the channel is for and who sees it. Phon's empty channel list says why it is empty and what to do (phon#189, user story 8).

### imessage-empty-state-light.png

Teaches: a new conversation with only the "To:" field, the composer, and the keyboard open. The screen asks for the one thing the member must do next.

Phon does not copy: the To field. Phon has no direct messages. The lesson is to show only the next action.
