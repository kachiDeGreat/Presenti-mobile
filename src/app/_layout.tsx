import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import React, { useEffect } from 'react';
import { Platform, Text, TextInput, UIManager } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '../context/AuthContext';
import { ToastProvider } from '../context/ToastContext';
import { LoadingIndicator } from '../components/LoadingIndicator';
import { requestAllAppPermissions } from '../services/permissionService';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// Prevent extreme OS accessibility font zoom from breaking cards, tabs, and buttons
(Text as any).defaultProps = {
  ...((Text as any).defaultProps || {}),
  maxFontSizeMultiplier: 1.1,
};
(TextInput as any).defaultProps = {
  ...((TextInput as any).defaultProps || {}),
  maxFontSizeMultiplier: 1.1,
};

SplashScreen.preventAutoHideAsync();

import { StatusBar } from 'expo-status-bar';

function RootNavigator() {
  const { isLoading } = useAuth();

  useEffect(() => {
    if (!isLoading) {
      SplashScreen.hideAsync().catch(() => {});
      // Prompt for required permissions (Location) on first launch
      requestAllAppPermissions().catch((err) => {
        console.warn('Initial permissions request error:', err);
      });
    }
  }, [isLoading]);

  if (isLoading) {
    return <LoadingIndicator fullScreen message="Initializing workforce session..." />;
  }

  return (
    <>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerShown: false,
          animation: 'slide_from_right',
          contentStyle: { backgroundColor: '#f2f1ee' },
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="login" options={{ gestureEnabled: false }} />
        <Stack.Screen name="onboarding" options={{ gestureEnabled: false }} />
        <Stack.Screen name="admin-onboarding" options={{ gestureEnabled: false }} />
        <Stack.Screen name="calibrate" />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ToastProvider>
          <AuthProvider>
            <RootNavigator />
          </AuthProvider>
        </ToastProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
