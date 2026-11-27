import type { IMessage, SendProps } from '@kesha-antonov/react-native-chat'

type SendButtonProps = NonNullable<SendProps<IMessage>['sendButtonProps']>

/** Labelled "Send", since the library fixes the label at "send" otherwise. */
const SHOWN: SendButtonProps = { accessibilityLabel: 'Send' }

/**
 * With nothing to send, the library shrinks the circle away but keeps its button mounted, still
 * a screen-reader stop. These take it out of VoiceOver's and TalkBack's order with the circle.
 */
const HIDDEN: SendButtonProps = {
  accessible: false,
  accessibilityElementsHidden: true,
  importantForAccessibility: 'no-hide-descendants',
}

/**
 * The send button's props for what the field holds: hidden exactly when the library hides its
 * circle (`Send`'s `canSend`, with no optional text), so a screen reader never lands on a blank
 * spot. The same object each time for each state, so the library keeps its memoised button.
 */
export function sendButtonProps(text: string | undefined): SendButtonProps {
  return text?.trim().length ? SHOWN : HIDDEN
}
