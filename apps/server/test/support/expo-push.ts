import type { ExpoPushMessage } from '../../src/expo-push.ts'
import { network } from './network.ts'

/**
 * Expo's push endpoint as Expo documents it (docs.expo.dev push-notifications/sending-notifications).
 * Written out rather than imported from `src/`, so a wrong production URL leaves the push unstubbed
 * and fails the test.
 */
export const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send'

/**
 * A fake Expo push service over the network recorder. It stubs `POST EXPO_PUSH_ENDPOINT`, answers an
 * `ok` ticket for every message, and records every message it was sent, in order.
 */
export function fakeExpoPush() {
  const received: ExpoPushMessage[] = []

  network.stub('POST', EXPO_PUSH_ENDPOINT, async (request) => {
    const batch = (await request.json()) as ExpoPushMessage[]
    received.push(...batch)
    return Response.json({
      data: batch.map(() => ({ status: 'ok', id: crypto.randomUUID() })),
    })
  })

  return {
    /** Every message received so far, in the order they arrived. */
    pushes(): ExpoPushMessage[] {
      return [...received]
    },

    /** Every message received so far for one device token. */
    pushesTo(token: string): ExpoPushMessage[] {
      return received.filter((push) => push.to === token)
    },

    /**
     * The pushes for one message, once a later message's push in the same channel has arrived.
     * Pushes leave a channel in message order, so by then every push for the earlier message has
     * too, and an empty answer means it pushed to no one.
     */
    async pushesFor(
      messageId: string,
      { after }: { after: string },
      timeoutMs = 2000,
    ): Promise<ExpoPushMessage[]> {
      const deadline = Date.now() + timeoutMs
      while (!received.some((push) => push.data.messageId === after)) {
        if (Date.now() >= deadline) {
          throw new Error(`No push for the marker message ${after} within ${timeoutMs}ms`)
        }
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      return received.filter((push) => push.data.messageId === messageId)
    },

    /**
     * Resolves with every message received once there are at least `count`. It polls rather than
     * being woken by the stub: the stub runs in the sending channel's context, and a test resumed
     * from there could not touch its own sockets.
     */
    async waitForPushes(count: number, timeoutMs = 2000): Promise<ExpoPushMessage[]> {
      const deadline = Date.now() + timeoutMs
      while (received.length < count) {
        if (Date.now() >= deadline) {
          throw new Error(`Expected ${count} pushes within ${timeoutMs}ms, got ${received.length}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      return [...received]
    },
  }
}

/** The Expo push token a test registers for a person: `ExponentPushToken[<personId>]`. */
export function tokenOf(personId: string): string {
  return `ExponentPushToken[${personId}]`
}
