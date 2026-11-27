import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { StatusBar } from 'expo-status-bar'
import { useEffect, useMemo } from 'react'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { KeyboardProvider } from 'react-native-keyboard-controller'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { loadSession, useSession } from '../src/api/session'
import { loadOversightNotice, useOversightNotice } from '../src/oversight-notice'
import { keepRegisteredForPush } from '../src/push'
import { loadAppearance, useAppearance } from '../src/theme/appearance'
import { headerOptions, navigationColours } from '../src/theme/header-options'
import { useTheme } from '../src/theme/use-theme'
import { loadUrgentSetup, useUrgentSetup } from '../src/urgent-setup'

// The launch screen stays up until the layout below has something to show, so the app opens on it
// and never on a blank frame (phon#251).
void SplashScreen.preventAutoHideAsync()

export default function RootLayout() {
  const session = useSession()
  const signedIn = session.token !== null
  const notice = useOversightNotice()
  // Every channel waits behind the oversight notice until the server says the person has seen it.
  const sawNotice = signedIn && notice.loaded && notice.seen
  const needsNotice = signedIn && notice.loaded && !notice.seen
  // After the notice, the urgent setup screen shows once per device before the channels.
  const urgentSetup = useUrgentSetup()
  const ready = sawNotice && urgentSetup.loaded && urgentSetup.seen
  const appearance = useAppearance()
  const { mode, tokens } = useTheme()
  const navigationTheme = useMemo(
    () => ({
      ...(mode === 'dark' ? DarkTheme : DefaultTheme),
      dark: mode === 'dark',
      colors: navigationColours(tokens),
    }),
    [mode, tokens],
  )
  // Nothing shows until the stored session is read, so a signed-in member never sees sign-in flash,
  // nor until the server says whether they have seen the notice, so no channel flashes before it,
  // nor until the stored appearance is read, so a member who chose Dark never sees a light frame.
  // The launch screen covers the wait, and every one of these loads settles on failure too.
  const launching =
    !session.loaded ||
    !appearance.loaded ||
    (signedIn && !notice.loaded) ||
    (sawNotice && !urgentSetup.loaded)

  useEffect(() => {
    void loadSession()
  }, [])

  useEffect(() => {
    if (session.token !== null) loadOversightNotice()
  }, [session.token])

  useEffect(() => {
    loadUrgentSetup()
  }, [])

  useEffect(() => {
    loadAppearance()
  }, [])

  // Once per session: this device alerts the person signed in, and follows a new push token.
  useEffect(() => {
    if (session.token === null) return
    return keepRegisteredForPush()
  }, [session.token])

  useEffect(() => {
    if (!launching) SplashScreen.hide()
  }, [launching])

  if (launching) return null

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <KeyboardProvider>
          {/* The status bar follows the resolved mode, so it matches the header under a stored choice. */}
          <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />
          {/* The channel list is the stack's root and every other screen pushes onto it. */}
          <ThemeProvider value={navigationTheme}>
            <Stack screenOptions={headerOptions(mode, tokens)}>
              <Stack.Protected guard={ready}>
                <Stack.Screen name="index" options={{ title: 'Channels' }} />
                <Stack.Screen name="settings" options={{ title: 'Settings' }} />
                <Stack.Screen name="channels/[channelId]" options={{ title: '' }} />
                <Stack.Screen name="new-channel" options={{ title: 'New channel' }} />
                <Stack.Screen name="roles" options={{ title: 'Roles' }} />
                <Stack.Screen name="group-sync" options={{ title: 'Group sync' }} />
                <Stack.Screen name="oversight" options={{ title: 'Oversight log' }} />
                <Stack.Screen name="reports" options={{ title: 'Reports' }} />
                <Stack.Screen name="channel-alerts" options={{ title: 'Alerts' }} />
                <Stack.Screen name="quiet-hours" options={{ title: 'Quiet hours' }} />
                <Stack.Screen name="birthdate" options={{ title: 'Birthdate' }} />
                <Stack.Screen name="birthdate-requests" options={{ title: 'Birthdate requests' }} />
                <Stack.Screen name="missing-birthdates" options={{ title: 'No birthdate' }} />
              </Stack.Protected>
              {/* Past the notice: shown first until this device has seen it, then from Settings. */}
              <Stack.Protected guard={sawNotice}>
                <Stack.Screen name="urgent-setup" options={{ title: 'Urgent alerts setup' }} />
              </Stack.Protected>
              <Stack.Protected guard={needsNotice}>
                <Stack.Screen
                  name="oversight-notice"
                  options={{ title: 'Before you start', headerShown: false }}
                />
              </Stack.Protected>
              {/* Sign-in pushes the email code sign-in and the sync connect, so Back returns to it. */}
              <Stack.Protected guard={!signedIn}>
                <Stack.Screen name="sign-in" options={{ title: 'Sign in', headerShown: false }} />
                <Stack.Screen
                  name="email-sign-in"
                  options={{ title: 'Sign in with an email code' }}
                />
                <Stack.Screen name="connect" options={{ title: 'Connect the sync account' }} />
              </Stack.Protected>
            </Stack>
          </ThemeProvider>
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
