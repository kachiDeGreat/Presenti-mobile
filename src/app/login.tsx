import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  Image,
} from "react-native";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import {
  GoogleSignin,
  statusCodes,
  isSuccessResponse,
  isErrorWithCode,
} from "@react-native-google-signin/google-signin";
import { useAuth, type AuthResult } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
// Official Google OAuth Web Client ID for attendance-app-1ab15
const GOOGLE_CLIENT_ID =
  process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ||
  "75234088565-1544l2u164o869tt1ddafo5h2vjijoed.apps.googleusercontent.com";

export default function LoginScreen() {
  const { user, organization, member, isAdmin, signInWithGoogle, signInWithGoogleCredential } =
    useAuth();
  const toast = useToast();

  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (isAdmin || user?.isAdmin) {
      router.replace("/calibrate" as any);
      return;
    }
    if (user && organization && member) {
      router.replace("/");
    }
  }, [isAdmin, user, organization, member]);

  useEffect(() => {
    if (Platform.OS !== "web") {
      try {
        GoogleSignin.configure({
          webClientId: GOOGLE_CLIENT_ID,
        });
      } catch (e) {
        console.warn("GoogleSignin configure error:", e);
      }
    }
  }, []);

  const navigateAfterAuth = (result: AuthResult) => {
    if (result.user?.isAdmin || isAdmin) {
      toast.success(`Welcome Administrator, ${result.user.displayName}!`);
      router.replace("/calibrate" as any);
      return;
    }
    if (result.organization && result.member) {
      toast.success(`Welcome back, ${result.member.fullName || result.user.displayName}!`);
      router.replace("/");
    } else {
      toast.success("Successfully authenticated with Google.");
      router.replace("/onboarding");
    }
  };

  const handleStartGoogleSignIn = async () => {
    setIsSubmitting(true);
    try {
      if (Platform.OS === "web") {
        // Web: Direct Firebase popup
        const res = await signInWithGoogle();
        navigateAfterAuth(res);
      } else {
        // Native (Android / iOS): Native bottom sheet account chooser
        await GoogleSignin.hasPlayServices({
          showPlayServicesUpdateDialog: true,
        });
        const response = await GoogleSignin.signIn();

        if (isSuccessResponse(response)) {
          const idToken = response.data.idToken;
          if (idToken) {
            const profileHint = {
              email: response.data.user.email,
              displayName: response.data.user.name || undefined,
              photoURL: response.data.user.photo || undefined,
            };
            const res = await signInWithGoogleCredential(idToken, profileHint);
            navigateAfterAuth(res);
          } else {
            toast.error("Unable to retrieve ID token from Google.");
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
          toast.warn("Google Play Services is not available or outdated.");
          return;
        }
      }

      // Friendly hint if testing inside Expo Go instead of a Dev Build
      if (
        err?.message?.includes("RNGoogleSignin") ||
        err?.message?.includes("TurboModuleRegistry")
      ) {
        toast.error(
          "Native Google Sign-In requires an Expo Development Build (npx expo run:android).",
        );
        return;
      }

      if (err?.message?.includes("DEVELOPER_ERROR")) {
        toast.error(
          "Please add your EAS SHA-1 fingerprint to Firebase Console (Project Settings -> Android app).",
          { title: "Firebase SHA-1 Required" }
        );
        return;
      }

      if (err?.code !== "auth/popup-closed-by-user") {
        const msg = err?.message || "Failed to complete Google authentication.";
        toast.error(msg);
        if (msg.includes("administrator on the web portal")) {
          Alert.alert(
            "Administrator Account",
            msg,
            [{ text: "Understood" }]
          );
        }
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
          <Image
            source={require("../image/app-icon.png")}
            style={styles.brandIconImage}
            resizeMode="contain"
          />
          <View style={styles.brandBadge}>
            <Ionicons name="shield-checkmark" size={13} color="#2563EB" />
            <Text style={styles.brandTag}>PRESENTI • PROOF OF PRESENCE</Text>
          </View>
          <Text style={styles.title}>Sign in to Presenti</Text>
          <Text style={styles.subtitle}>
            Proof of presence, made simple. Sign in with your Google account to record
            verified on-premise attendance.
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
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <ActivityIndicator color="#0F2042" size="small" />
                <Text style={styles.googleButtonText}>Connecting to Google...</Text>
              </View>
            ) : (
              <>
                <View style={styles.googleIconContainer}>
                  <Ionicons name="logo-google" size={20} color="#4285F4" />
                </View>
                <Text style={styles.googleButtonText}>
                  Continue with Google
                </Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        {/* Divider */}
        <View style={styles.dividerRow}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>OR CALIBRATE PREMISES</Text>
          <View style={styles.dividerLine} />
        </View>

        {/* Administrator Direct Calibration Access (No Login Required) */}
        <TouchableOpacity
          style={styles.adminCard}
          onPress={() => router.push("/calibrate" as any)}
          activeOpacity={0.85}
        >
          <View style={styles.adminIconBadge}>
            <Ionicons name="hardware-chip-outline" size={20} color="#0284C7" />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Text style={styles.adminCardTitle}>Administrator? Calibrate Premises</Text>
              <Ionicons name="qr-code-outline" size={13} color="#0284C7" />
            </View>
            <Text style={styles.adminCardSubtitle}>
              Scan the QR code displayed on the Admin Web Portal to calibrate Wi-Fi & GPS anchors.
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color="#94A3B8" />
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#F8FAFC",
  },
  scrollContent: {
    padding: 24,
    justifyContent: "center",
    flexGrow: 1,
  },
  header: {
    marginBottom: 28,
  },
  brandIconImage: {
    width: 60,
    height: 60,
    borderRadius: 15,
    marginBottom: 16,
  },
  brandBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#EFF6FF",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    alignSelf: "flex-start",
    marginBottom: 12,
  },
  brandTag: {
    fontSize: 11,
    fontWeight: "700",
    color: "#2563EB",
    letterSpacing: 0.8,
  },
  title: {
    fontSize: 26,
    fontWeight: "800",
    color: "#0F172A",
    letterSpacing: -0.5,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: "#64748B",
    lineHeight: 20,
  },
  actionContainer: {
    marginBottom: 24,
  },
  googleButton: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1.5,
    borderColor: "#CBD5E1",
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 20,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    shadowColor: "#0F172A",
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
    alignItems: "center",
    justifyContent: "center",
  },
  googleButtonText: {
    color: "#1E293B",
    fontSize: 15,
    fontWeight: "600",
    letterSpacing: -0.2,
  },
  trustCard: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 12,
    padding: 18,
    gap: 12,
  },
  trustHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  trustTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#065F46",
  },
  trustItems: {
    gap: 10,
  },
  trustItem: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  trustDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#10B981",
    marginTop: 6,
  },
  trustText: {
    fontSize: 12,
    color: "#475569",
    lineHeight: 18,
    flex: 1,
  },
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    marginVertical: 18,
    gap: 12,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: "#E2E8F0",
  },
  dividerText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#94A3B8",
    letterSpacing: 0.8,
  },
  adminCard: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1.5,
    borderColor: "#BAE6FD",
    borderRadius: 14,
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    shadowColor: "#0284C7",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 2,
  },
  adminIconBadge: {
    width: 42,
    height: 42,
    borderRadius: 10,
    backgroundColor: "#F0F9FF",
    borderWidth: 1,
    borderColor: "#E0F2FE",
    alignItems: "center",
    justifyContent: "center",
  },
  adminCardTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: "#0369A1",
    letterSpacing: -0.2,
  },
  adminCardSubtitle: {
    fontSize: 12,
    color: "#64748B",
    lineHeight: 16,
  },
});
