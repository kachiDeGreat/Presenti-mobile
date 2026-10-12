import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
} from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import {
  GoogleSignin,
  statusCodes,
  isSuccessResponse,
  isErrorWithCode,
} from '@react-native-google-signin/google-signin';
import { useAuth } from '../context/AuthContext';

// Official Google OAuth Web Client ID for attendance-app-1ab15
const GOOGLE_CLIENT_ID =
  process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ||
  '75234088565-1544l2u164o869tt1ddafo5h2vjijoed.apps.googleusercontent.com';

export default function LoginScreen() {
  const {
    signInWithGoogle,
    signInWithGoogleCredential,
    organization,
    member,
  } = useAuth();

  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (Platform.OS !== 'web') {
      try {
        GoogleSignin.configure({
          webClientId: GOOGLE_CLIENT_ID,
        });
      } catch (e) {
        console.warn('GoogleSignin configure error:', e);
      }
    }
  }, []);

  const navigateAfterAuth = () => {
    if (organization && member) {
      router.replace('/');
    } else {
      router.replace('/onboarding');
    }
  };

  const handleStartGoogleSignIn = async () => {
    setIsSubmitting(true);
    try {
      if (Platform.OS === 'web') {
        // Web: Direct Firebase popup
        await signInWithGoogle();
        navigateAfterAuth();
      } else {
        // Native (Android / iOS): Native bottom sheet account chooser
        await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
        const response = await GoogleSignin.signIn();

        if (isSuccessResponse(response)) {
          const idToken = response.data.idToken;
          if (idToken) {
            await signInWithGoogleCredential(idToken);
            navigateAfterAuth();
          } else {
            Alert.alert('Sign In Alert', 'No ID token received from Google.');
          }
        }
      }
    } catch (err: any) {
      if (isErrorWithCode(err)) {
        if (err.code === statusCodes.SIGN_IN_CANCELLED) {
          // User dismissed or swiped away the native bottom sheet
          return;
        }
        if (err.code === statusCodes.IN_PROGRESS) {
          return;
        }
        if (err.code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
          Alert.alert(
            'Google Play Services',
            'Google Play Services is not available or requires an update on this device.'
          );
          return;
        }
      }

      // Friendly hint if testing inside Expo Go instead of a Dev Build
      if (
        err?.message?.includes('RNGoogleSignin') ||
        err?.message?.includes('TurboModuleRegistry')
      ) {
        Alert.alert(
          'Development Build Required',
          'Native Google Sign-In requires an Expo Development Build (npx expo run:android) and cannot run inside standard Expo Go.'
        );
        return;
      }

      if (err?.code !== 'auth/popup-closed-by-user') {
        Alert.alert('Sign In Alert', err?.message || 'Failed to complete Google authentication.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        {/* Brand Header */}
        <View style={styles.header}>
          <View style={styles.brandBadge}>
            <Ionicons name="shield-checkmark" size={13} color="#2563EB" />
            <Text style={styles.brandTag}>WORKFORCE ATTENDANCE</Text>
          </View>
          <Text style={styles.title}>Sign in to your Account</Text>
          <Text style={styles.subtitle}>
            Authenticate using your Google account to record on-premise attendance and access your organization roster.
          </Text>
        </View>

        {/* Primary Google Sign-In Action */}
        <View style={styles.actionContainer}>
          <TouchableOpacity
            style={[styles.googleButton, isSubmitting && styles.disabledButton]}
            onPress={handleStartGoogleSignIn}
            disabled={isSubmitting}
            activeOpacity={0.85}
          >
            {isSubmitting ? (
              <ActivityIndicator color="#0F2042" size="small" />
            ) : (
              <>
                <View style={styles.googleIconContainer}>
                  <Ionicons name="logo-google" size={20} color="#4285F4" />
                </View>
                <Text style={styles.googleButtonText}>Continue with Google</Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        {/* Verification & Trust Card (matching Admin Web) */}
        <View style={styles.trustCard}>
          <View style={styles.trustHeader}>
            <Ionicons name="checkmark-circle" size={18} color="#059669" />
            <Text style={styles.trustTitle}>Verified Workforce Authentication</Text>
          </View>
          <View style={styles.trustItems}>
            <View style={styles.trustItem}>
              <View style={styles.trustDot} />
              <Text style={styles.trustText}>
                Strict Google account verification eliminates proxy attendance and fake registrations.
              </Text>
            </View>
            <View style={styles.trustItem}>
              <View style={styles.trustDot} />
              <Text style={styles.trustText}>
                Automatic session sync keeps your profile active even after closing or restarting the app.
              </Text>
            </View>
            <View style={styles.trustItem}>
              <View style={styles.trustDot} />
              <Text style={styles.trustText}>
                Presence anchors and organization rosters load automatically for seamless check-in.
              </Text>
            </View>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#F8FAFC',
  },
  scrollContent: {
    padding: 24,
    justifyContent: 'center',
    flexGrow: 1,
  },
  header: {
    marginBottom: 28,
  },
  brandBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#EFF6FF',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    alignSelf: 'flex-start',
    marginBottom: 12,
  },
  brandTag: {
    fontSize: 11,
    fontWeight: '700',
    color: '#2563EB',
    letterSpacing: 0.8,
  },
  title: {
    fontSize: 26,
    fontWeight: '800',
    color: '#0F172A',
    letterSpacing: -0.5,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: '#64748B',
    lineHeight: 20,
  },
  actionContainer: {
    marginBottom: 24,
  },
  googleButton: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1.5,
    borderColor: '#CBD5E1',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 2,
  },
  disabledButton: {
    opacity: 0.7,
  },
  googleIconContainer: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  googleButtonText: {
    color: '#1E293B',
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: -0.2,
  },
  trustCard: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 12,
    padding: 18,
    gap: 12,
  },
  trustHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  trustTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#065F46',
  },
  trustItems: {
    gap: 10,
  },
  trustItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  trustDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#10B981',
    marginTop: 6,
  },
  trustText: {
    fontSize: 12,
    color: '#475569',
    lineHeight: 18,
    flex: 1,
  },
});


