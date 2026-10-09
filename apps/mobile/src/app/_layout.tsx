import { QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { LiveEventsProvider } from '../api/live';
import { createQueryClient } from '../api/query-client';
import { SessionProvider, useSession } from '../api/session';
import { ThemeProvider, useTheme } from '../ui/theme';
import { ToastHost } from '../ui/toast';

// The splash screen stays until the stored session has been read.
void SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  const [queryClient] = useState(createQueryClient);
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <QueryClientProvider client={queryClient}>
            <SessionProvider>
              <Navigator />
              <ToastHost />
            </SessionProvider>
          </QueryClientProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

/**
 * The screens, gated on the session: signed in, the tabs and what they open; signed out, sign-in and
 * the scanner. A pairing link opens either way (signed in, it says to sign out first).
 */
function Navigator() {
  const { state } = useSession();
  const theme = useTheme();
  useEffect(() => {
    if (state.status !== 'checking') void SplashScreen.hideAsync().catch(() => {});
  }, [state.status]);
  if (state.status === 'checking') return null;
  const signedIn = state.status === 'signed-in';

  return (
    <LiveEventsProvider token={signedIn ? state.session.token : null}>
      <StatusBar style={theme.name === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.colors.background },
          headerTintColor: theme.colors.foreground,
          headerTitleStyle: { fontFamily: 'MonaSans-Medium' },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: theme.colors.background },
        }}
      >
        <Stack.Protected guard={signedIn}>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="tasks/[id]" options={{ title: '' }} />
          <Stack.Screen name="new-task" options={{ title: 'New task', presentation: 'modal' }} />
          <Stack.Screen name="settings" options={{ title: 'Settings' }} />
        </Stack.Protected>
        <Stack.Protected guard={!signedIn}>
          <Stack.Screen name="sign-in" options={{ headerShown: false }} />
          <Stack.Screen name="scan" options={{ headerShown: false, presentation: 'fullScreenModal' }} />
        </Stack.Protected>
        <Stack.Screen name="pair" options={{ title: 'Pair this phone', presentation: 'modal' }} />
      </Stack>
    </LiveEventsProvider>
  );
}
