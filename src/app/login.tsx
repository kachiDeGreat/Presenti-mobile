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
  Vibration,
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
  const {
    user,
    organization,
    member,
    isAdmin,
    signInWithGoogle,
    signInWithGoogleCredential,
    signOut,
  } = useAuth();
  const toast = useToast();

  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (isAdmin || user?.isAdmin) {
      toast.error(
        "Administrator accounts cannot be signed into the mobile app. Please use the Web Admin Portal."
      );
      signOut();
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
      toast.error(
        "Administrator accounts cannot be signed into the mobile app. Please use the Web Admin Portal."
      );
      signOut();
      return;
    }
    if (result.organization && result.member) {
      toast.success(
        `Welcome back, ${result.member.fullName || result.user.displayName}!`,
      );
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

        const idToken =
          (response as any)?.data?.idToken || (response as any)?.idToken;
        const userObj =
          (response as any)?.data?.user || (response as any)?.user;

        if (idToken) {
          const profileHint = {
            email: userObj?.email,
            displayName: userObj?.name || undefined,
            photoURL: userObj?.photo || undefined,
          };
          const res = await signInWithGoogleCredential(idToken, profileHint);
          navigateAfterAuth(res);
        } else if (isSuccessResponse(response)) {
          toast.error("Unable to retrieve ID token from Google.");
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
          { title: "Firebase SHA-1 Required" },
        );
        return;
      }

      if (err?.code !== "auth/popup-closed-by-user") {
        const msg = err?.message || "Failed to complete Google authentication.";
        toast.error(msg);
        if (
          msg.toLowerCase().includes("administrator") ||
          msg.toLowerCase().includes("admin portal")
        ) {
          Alert.alert("Administrator Account Restricted", msg, [{ text: "Understood" }]);
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
          <TouchableOpacity
            activeOpacity={0.9}
            delayLongPress={3000}
            onLongPress={() => {
              Vibration.vibrate([0, 100, 60, 100]);
              toast.info("Entering Administrator Calibration Mode...");
              router.push("/calibrate" as any);
            }}
          >
            <Image
              source={require("../image/app-icon.png")}
              style={styles.brandIconImage}
              resizeMode="contain"
            />
          </TouchableOpacity>
          <View style={styles.brandBadge}>
            <View style={styles.brandBadgeDot} />
            <Text style={styles.brandTag}>PRESENTI • PROOF OF PRESENCE</Text>
          </View>
          <Text style={styles.title}>Sign in to Presenti</Text>
          <Text style={styles.subtitle}>
            Proof of presence, made simple. Sign in with your Google account to
            record verified on-premise attendance.
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
              <View style={styles.buttonLoaderRow}>
                <ActivityIndicator color="#f2f1ee" size="small" />
                <Text style={styles.googleButtonText}>
                  CONNECTING TO GOOGLE...
                </Text>
              </View>
            ) : (
              <>
                <Ionicons name="logo-google" size={18} color="#f2f1ee" />
                <Text style={styles.googleButtonText}>
                  CONTINUE WITH GOOGLE
                </Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        {/* Admin Calibration Quick Note */}
        {/* <View style={styles.adminHintCard}>
          <Text style={styles.adminHintTag}>ADMINISTRATOR ACCESS</Text>
          <Text style={styles.adminHintText}>
            Premises administrators: long-press the app icon above or sign in with an admin Google account to open hardware beacon calibration.
          </Text>
        </View> */}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#f2f1ee",
  },
  scrollContent: {
    padding: 24,
    justifyContent: "center",
    flexGrow: 1,
    maxWidth: 520,
    width: "100%",
    alignSelf: "center",
  },
  header: {
    marginBottom: 32,
  },
  brandIconImage: {
    width: 64,
    height: 64,
    borderRadius: 0,
    marginBottom: 20,
  },
  brandBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e5e7eb",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 0,
    alignSelf: "flex-start",
    marginBottom: 16,
  },
  brandBadgeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#2d81ff",
  },
  brandTag: {
    fontSize: 10,
    fontWeight: "700",
    color: "#142748",
    letterSpacing: 0.8,
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
  },
  title: {
    fontSize: 32,
    fontWeight: "800",
    color: "#142748",
    letterSpacing: -0.8,
    marginBottom: 10,
    lineHeight: 38,
  },
  subtitle: {
    fontSize: 15,
    color: "#52525b",
    lineHeight: 24,
    fontWeight: "400",
  },
  actionContainer: {
    marginBottom: 24,
  },
  googleButton: {
    backgroundColor: "#142748",
    borderWidth: 1,
    borderColor: "#142748",
    borderRadius: 0,
    minHeight: 48,
    paddingVertical: 14,
    paddingHorizontal: 24,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    elevation: 0,
    shadowOpacity: 0,
  },
  disabledButton: {
    opacity: 0.65,
  },
  buttonLoaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  googleButtonText: {
    color: "#f2f1ee",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
  },
  adminHintCard: {
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 0,
    padding: 16,
    gap: 6,
    elevation: 0,
    shadowOpacity: 0,
  },
  adminHintTag: {
    fontSize: 10,
    fontWeight: "700",
    color: "#142748",
    letterSpacing: 0.8,
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
  },
  adminHintText: {
    fontSize: 12,
    color: "#52525b",
    lineHeight: 18,
  },
});
