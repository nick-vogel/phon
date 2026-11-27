/**
 * The registry's one object name. Its own module, with no `cloudflare:workers` import, so that
 * `expo-push.ts`, which the app's tests import under Node, can name the registry too.
 */
export const REGISTRY_NAME = 'all'
