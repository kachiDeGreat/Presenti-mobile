import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import React, { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '../context/AuthContext';
import { ToastProvider } from '../context/ToastContext';
import { LoadingIndicator } from '../components/LoadingIndicator';
import { requestAllAppPermissions } from '../services/permissionService';

SplashScreen.preventAutoHideAsync();

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
    <Stack
      screenOptions={{
        headerShown: false,
        animation: 'fade',
        contentStyle: { backgroundColor: '#F8FAFC' },
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen name="login" options={{ gestureEnabled: false }} />
      <Stack.Screen name="onboarding" options={{ gestureEnabled: false }} />
      <Stack.Screen name="calibrate" />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ToastProvider>
        <AuthProvider>
          <RootNavigator />
        </AuthProvider>
      </ToastProvider>
    </SafeAreaProvider>
  );
}
