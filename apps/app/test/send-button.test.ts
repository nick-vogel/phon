import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { sendButtonProps } from '../src/send-button.ts'

// These check the props the screen hands the library's send button. Whether VoiceOver and
// TalkBack then skip the hidden button is for the Simulator walk; a Node test cannot see it.
describe('the send button, as screen readers find it', () => {
  it('is out of reach while the field holds nothing to send', () => {
    for (const text of [undefined, '', '   ', '\n\t ']) {
      assert.deepEqual(
        sendButtonProps(text),
        {
          accessible: false,
          accessibilityElementsHidden: true,
          importantForAccessibility: 'no-hide-descendants',
        },
        JSON.stringify(text),
      )
    }
  })

  it('is a button labelled "Send" once the field holds text', () => {
    for (const text of ['hi', '  hi  ']) {
      const props = sendButtonProps(text)
      assert.equal(props.accessibilityLabel, 'Send', JSON.stringify(text))
      assert.notEqual(props.accessible, false, JSON.stringify(text))
      assert.notEqual(props.accessibilityElementsHidden, true, JSON.stringify(text))
      assert.notEqual(props.importantForAccessibility, 'no-hide-descendants', JSON.stringify(text))
    }
  })
})
