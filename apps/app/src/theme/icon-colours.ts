/**
 * Android reads only the alpha of a monochrome adaptive icon and of a notification icon, and Expo
 * asks for both in white, so this is the one icon colour that does not come from a theme's tokens.
 * `scripts/render-icons.ts` draws both icons in it.
 */
export const SILHOUETTE = '#ffffff'
