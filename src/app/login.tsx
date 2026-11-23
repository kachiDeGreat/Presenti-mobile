import React, { useState, useEffect, useRef } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  Image,
  Vibration,
  Animated,
  KeyboardAvoidingView,
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
import { C, MONO, R, S, T, shadow, ui } from "../constants/premium";

// Official Google OAuth Web Client ID for attendance-app-1ab15
const GOOGLE_CLIENT_ID =
  process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ||
  "75234088565-1544l2u164o869tt1ddafo5h2vjijoed.apps.googleusercontent.com";

type AuthMode = "SIGN_IN" | "CREATE_ACCOUNT" | "VERIFY_OTP" | "FORGOT_PASSWORD" | "RESET_PASSWORD";
type AccountRole = "WORKER" | "ADMIN";

export default function LoginScreen() {
  const {
    user,
    organization,
    member,
    isAdmin,
    authStepLabel,
    signInWithGoogle,
    signInWithGoogleCredential,
    loginWithEmailPassword,
    registerWithEmailPassword,
    sendMobileOtp,
    verifyMobileOtpCode,
    resetPasswordWithOtp,
  } = useAuth();
  const toast = useToast();

  // Mode and form states
  const [mode, setMode] = useState<AuthMode>("SIGN_IN");
  const [selectedRole, setSelectedRole] = useState<AccountRole>("WORKER");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const isAnyLoading = isSubmitting || isGoogleLoading;

  // Form Fields
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  // OTP Verification States
  const [otpDigits, setOtpDigits] = useState<string[]>(["", "", "", "", "", ""]);
  const [otpPurpose, setOtpPurpose] = useState<"SIGNUP" | "RESET_PASSWORD">("SIGNUP");
  const [resendCountdown, setResendCountdown] = useState(45);
  const [canResend, setCanResend] = useState(false);
  const [isVerifyingOtp, setIsVerifyingOtp] = useState(false);

  // New Password State for Password Reset
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");

  // Animation for OTP shake on failure
  const shakeAnim = useRef(new Animated.Value(0)).current;
  const otpInputRefs = useRef<(TextInput | null)[]>([]);
  const hasNavigatedRef = useRef(false);

  // Auto-redirect only if user session was already restored before interacting with LoginScreen
  useEffect(() => {
    if (isAnyLoading || isVerifyingOtp || hasNavigatedRef.current) return;
    if (user && (isAdmin || user.isAdmin)) {
      hasNavigatedRef.current = true;
      router.replace(organization ? "/" : ("/admin-onboarding" as any));
      return;
    }
    if (user && organization && member) {
      hasNavigatedRef.current = true;
      router.replace("/");
    }
  }, [isAdmin, user, organization, member, isAnyLoading, isVerifyingOtp]);

  // Configure Google Sign-In on Native
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

  // Resend Countdown Timer
  useEffect(() => {
    let timer: any;
    if ((mode === "VERIFY_OTP" || mode === "RESET_PASSWORD") && resendCountdown > 0) {
      setCanResend(false);
      timer = setInterval(() => {
        setResendCountdown((prev) => {
          if (prev <= 1) {
            setCanResend(true);
            clearInterval(timer);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [mode, resendCountdown]);

  // Shake animation trigger
  const triggerShake = () => {
    if (Platform.OS !== "web") {
      try {
        Vibration.vibrate([0, 80, 40, 80]);
      } catch {}
    }
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 12, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -12, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 8, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -8, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 50, useNativeDriver: true }),
    ]).start();
  };

  // Central Navigation Dispatcher after Successful Authentication (Fires exactly once)
  const navigateAfterAuth = (result: AuthResult) => {
    if (hasNavigatedRef.current) return;
    hasNavigatedRef.current = true;

    if (result.user?.isAdmin || isAdmin) {
      if (result.organization) {
        toast.success(
          `Welcome to Presenti Admin, ${result.user.displayName || "Admin"}!`
        );
        router.replace("/");
      } else {
        toast.success("Admin account verified! Let's set up your organization.");
        router.replace("/admin-onboarding" as any);
      }
      return;
    }
    if (result.organization && result.member) {
      toast.success(
        `Welcome back, ${result.member.fullName || result.user.displayName}!`,
      );
      router.replace("/");
    } else {
      toast.success("Authentication confirmed.");
      router.replace("/onboarding");
    }
  };

  // ----------------------------------------------------
  // ACTION: Sign In (Email & Password) — Auto-Detects Role!
  // ----------------------------------------------------
  const handleSignIn = async () => {
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes("@")) {
      toast.error("Please enter a valid official email address.");
      return;
    }
    if (!password) {
      toast.error("Please enter your account password.");
      return;
    }

    setIsSubmitting(true);
    try {
      // Auto-detects whether user is Admin or Worker internally!
      const result = await loginWithEmailPassword(cleanEmail, password);
      navigateAfterAuth(result);
    } catch (err: any) {
      console.error("[Login] Sign-in failed:", err);
      const code = err?.code || "";
      let msg = "Invalid email or password. Please verify and retry.";
      if (code === "auth/user-not-found" || code === "auth/invalid-credential") {
        msg = "Account not found or password incorrect.";
      } else if (code === "auth/wrong-password") {
        msg = "Incorrect password. Tap 'Forgot Password?' to reset.";
      } else if (code === "auth/too-many-requests") {
        msg = "Access temporarily blocked due to multiple failed attempts. Try again later.";
      } else if (err?.message) {
        msg = err.message;
      }
      toast.error(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  // ----------------------------------------------------
  // ACTION: Request Registration OTP (Role-Based Sign Up)
  // ----------------------------------------------------
  const handleRequestSignUpOtp = async () => {
    const cleanEmail = email.trim().toLowerCase();
    const cleanName = fullName.trim();

    if (!cleanName) {
      toast.error("Please enter your full name.");
      return;
    }
    if (!cleanEmail || !cleanEmail.includes("@")) {
      toast.error("Please enter a valid work email address.");
      return;
    }
    if (password.length < 6) {
      toast.error("Password must be at least 6 characters long.");
      return;
    }
    if (password !== confirmPassword) {
      toast.error("Passwords do not match.");
      return;
    }

    setIsSubmitting(true);
    try {
      const otpRes = await sendMobileOtp(cleanEmail, "SIGNUP", selectedRole);
      setOtpPurpose("SIGNUP");
      setOtpDigits(["", "", "", "", "", ""]);
      setResendCountdown(45);
      setCanResend(false);
      setMode("VERIFY_OTP");

      if (otpRes.devCode) {
        toast.info(`DEV DEMO OTP: ${otpRes.devCode}`);
      } else {
        toast.success(`Verification code dispatched to ${cleanEmail}`);
      }
      setTimeout(() => otpInputRefs.current[0]?.focus(), 300);
    } catch (err: any) {
      console.error("[Registration OTP] Dispatch error:", err);
      toast.error(err?.message || "Unable to send verification code. Please retry.");
    } finally {
      setIsSubmitting(false);
    }
  };

  // ----------------------------------------------------
  // ACTION: Request Password Reset OTP
  // ----------------------------------------------------
  const handleRequestPasswordResetOtp = async () => {
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes("@")) {
      toast.error("Please enter your registered email address.");
      return;
    }

    setIsSubmitting(true);
    try {
      const otpRes = await sendMobileOtp(cleanEmail, "RESET_PASSWORD");
      setOtpPurpose("RESET_PASSWORD");
      setOtpDigits(["", "", "", "", "", ""]);
      setResendCountdown(45);
      setCanResend(false);
      setMode("RESET_PASSWORD");

      if (otpRes.devCode) {
        toast.info(`DEV DEMO OTP: ${otpRes.devCode}`);
      } else {
        toast.success(`Password reset code dispatched to ${cleanEmail}`);
      }
      setTimeout(() => otpInputRefs.current[0]?.focus(), 300);
    } catch (err: any) {
      console.error("[Password Reset OTP] Dispatch error:", err);
      toast.error(err?.message || "Unable to send recovery code. Please retry.");
    } finally {
      setIsSubmitting(false);
    }
  };

  // ----------------------------------------------------
  // ACTION: Verify OTP Code (Auto-submits on 6th digit)
  // ----------------------------------------------------
  const handleVerifyOtp = async (codeToVerify?: string) => {
    const fullCode = (codeToVerify || otpDigits.join("")).trim();
    if (fullCode.length !== 6) return;

    const cleanEmail = email.trim().toLowerCase();
    setIsVerifyingOtp(true);

    try {
      if (otpPurpose === "SIGNUP") {
        // 1. Verify 6-digit code
        await verifyMobileOtpCode(cleanEmail, fullCode, "SIGNUP");

        // 2. Create Firebase Account with selected role
        const result = await registerWithEmailPassword(
          cleanEmail,
          password,
          fullName.trim(),
          selectedRole
        );

        toast.success(
          selectedRole === "ADMIN"
            ? "Administrator account verified! Welcome email sent."
            : "Workforce account verified! Welcome email sent."
        );
        navigateAfterAuth(result);
      } else {
        // Password Reset Mode: Validate OTP first
        await verifyMobileOtpCode(cleanEmail, fullCode, "RESET_PASSWORD");
        toast.success("Security code verified. Enter your new password.");
      }
    } catch (err: any) {
      console.error("[OTP Verify] Error:", err);
      triggerShake();
      // On failure: Clear OTP fields and refocus box 0 for immediate retry
      setOtpDigits(["", "", "", "", "", ""]);
      setTimeout(() => otpInputRefs.current[0]?.focus(), 150);
      toast.error(err?.message || "Invalid or expired code. Please retry.");
    } finally {
      setIsVerifyingOtp(false);
    }
  };

  // ----------------------------------------------------
  // ACTION: Submit Final Password Reset
  // ----------------------------------------------------
  const handleSubmitNewPassword = async () => {
    const fullCode = otpDigits.join("").trim();
    if (fullCode.length !== 6) {
      toast.error("Please enter the 6-digit verification code.");
      return;
    }
    if (newPassword.length < 6) {
      toast.error("New password must be at least 6 characters.");
      return;
    }
    if (newPassword !== confirmNewPassword) {
      toast.error("New passwords do not match.");
      return;
    }

    setIsSubmitting(true);
    try {
      await resetPasswordWithOtp(email.trim().toLowerCase(), fullCode, newPassword);
      toast.success("Password reset successfully! Please sign in.");
      setPassword("");
      setNewPassword("");
      setConfirmNewPassword("");
      setMode("SIGN_IN");
    } catch (err: any) {
      console.error("[Password Reset Submit] Error:", err);
      toast.error(err?.message || "Failed to reset password. Please retry.");
    } finally {
      setIsSubmitting(false);
    }
  };

  // ----------------------------------------------------
  // OTP Input Change Handler (Auto jumps & auto submits)
  // ----------------------------------------------------
  const handleOtpDigitChange = (index: number, value: string) => {
    // Handle paste of full 6-digit code
    const cleaned = value.replace(/\D/g, "");
    if (cleaned.length === 6) {
      const newDigits = cleaned.split("");
      setOtpDigits(newDigits);
      otpInputRefs.current[5]?.focus();
      handleVerifyOtp(cleaned);
      return;
    }

    const singleDigit = cleaned.slice(-1);
    const updated = [...otpDigits];
    updated[index] = singleDigit;
    setOtpDigits(updated);

    // Auto-advance cursor
    if (singleDigit && index < 5) {
      otpInputRefs.current[index + 1]?.focus();
    }

    // Auto-submit as soon as the 6th digit is entered
    const isComplete = updated.every((d) => d.length === 1);
    if (isComplete && index === 5 && singleDigit) {
      handleVerifyOtp(updated.join(""));
    }
  };

  const handleOtpKeyPress = (index: number, e: any) => {
    if (e.nativeEvent.key === "Backspace" && !otpDigits[index] && index > 0) {
      otpInputRefs.current[index - 1]?.focus();
    }
  };

  // Resend OTP
  const handleResendOtp = async () => {
    if (!canResend || isSubmitting) return;
    setIsSubmitting(true);
    try {
      const otpRes = await sendMobileOtp(email.trim().toLowerCase(), otpPurpose);
      setResendCountdown(45);
      setCanResend(false);
      setOtpDigits(["", "", "", "", "", ""]);
      otpInputRefs.current[0]?.focus();

      if (otpRes.devCode) {
        toast.info(`NEW DEV OTP: ${otpRes.devCode}`);
      } else {
        toast.success("Fresh verification code sent.");
      }
    } catch (err: any) {
      toast.error(err?.message || "Failed to resend code.");
    } finally {
      setIsSubmitting(false);
    }
  };

  // ----------------------------------------------------
  // ACTION: Native Google Sign-In
  // ----------------------------------------------------
  const handleStartGoogleSignIn = async () => {
    if (isAnyLoading) return;
    setIsGoogleLoading(true);
    const wantsAdminRole = mode === "CREATE_ACCOUNT" && selectedRole === "ADMIN";
    try {
      if (Platform.OS === "web") {
        const res = await signInWithGoogle(
          wantsAdminRole ? { isAdmin: true } : undefined
        );
        navigateAfterAuth(res);
      } else {
        try {
          await GoogleSignin.signOut();
        } catch {}

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
            ...(wantsAdminRole ? { isAdmin: true } : {}),
          };
          const res = await signInWithGoogleCredential(idToken, profileHint);
          navigateAfterAuth(res);
        } else if (isSuccessResponse(response)) {
          toast.error("Unable to retrieve ID token from Google.");
        }
      }
    } catch (err: any) {
      console.warn("[Login] Google Sign-In notice:", err);
      if (isErrorWithCode(err)) {
        if (err.code === statusCodes.SIGN_IN_CANCELLED || err.code === statusCodes.IN_PROGRESS) {
          return;
        }
        if (err.code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
          toast.warn("Google Play Services is not available or outdated.");
          return;
        }
      }

      if (
        err?.message?.includes("RNGoogleSignin") ||
        err?.message?.includes("TurboModuleRegistry")
      ) {
        toast.error("Native Google Sign-In requires an Expo Development Build.");
        return;
      }

      const isDeveloperError =
        Boolean(err?.code) &&
        (err.code === "10" ||
          err.code === 10 ||
          err.code === "DEVELOPER_ERROR" ||
          String(err?.message || "").includes("DEVELOPER_ERROR") ||
          String(err?.message || "").includes("code: 10"));

      if (isDeveloperError) {
        Alert.alert(
          "Firebase SHA-1 Fingerprint Required",
          "Google Play Services returned Error 10 (DEVELOPER_ERROR). Please register your signing SHA-1 in the Firebase Console.",
          [{ text: "Understood" }]
        );
        toast.error("Firebase requires your APK's SHA-1 fingerprint.");
        return;
      }

      if (err?.code !== "auth/popup-closed-by-user") {
        toast.error(err?.message || "Failed to complete Google authentication.");
      }
    } finally {
      setIsGoogleLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.keyboardAvoid}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Header & Logo */}
          <View style={styles.header}>
            <Image
              source={require("../image/app-icon.png")}
              style={styles.brandIconImage}
              resizeMode="contain"
            />

            <View style={styles.brandBadge}>
              <View style={styles.brandBadgeDot} />
              <Text style={styles.brandTag}>PRESENTI • PROOF OF PRESENCE</Text>
            </View>

            <Text style={styles.title}>
              {mode === "SIGN_IN" && "Sign In to Presenti"}
              {mode === "CREATE_ACCOUNT" && "Create Account"}
              {mode === "VERIFY_OTP" && "Verify Email Address"}
              {mode === "FORGOT_PASSWORD" && "Reset Password"}
              {mode === "RESET_PASSWORD" && "Set New Password"}
            </Text>

            <Text style={styles.subtitle}>
              {mode === "SIGN_IN" &&
                "Access your workforce workspace. Enter your credentials to automatically connect to your assigned profile."}
              {mode === "CREATE_ACCOUNT" &&
                "Select your account role and verify your work email address to register on the platform."}
              {mode === "VERIFY_OTP" &&
                `We've dispatched a 6-digit verification code to ${email}. Code auto-submits on the 6th digit.`}
              {mode === "FORGOT_PASSWORD" &&
                "Enter your registered email address to receive an instant 6-digit recovery code."}
              {mode === "RESET_PASSWORD" &&
                `Enter the 6-digit recovery code dispatched to ${email} and set your new password.`}
            </Text>
          </View>

          {/* Segmented Mode Switcher (Visible only on Sign In / Create Account) */}
          {(mode === "SIGN_IN" || mode === "CREATE_ACCOUNT") && (
            <View style={styles.tabContainer}>
              <TouchableOpacity
                style={[styles.tabButton, mode === "SIGN_IN" && styles.tabButtonActive]}
                onPress={() => setMode("SIGN_IN")}
                activeOpacity={0.8}
              >
                <Text
                  style={[
                    styles.tabButtonText,
                    mode === "SIGN_IN" && styles.tabButtonTextActive,
                  ]}
                >
                  SIGN IN
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.tabButton,
                  mode === "CREATE_ACCOUNT" && styles.tabButtonActive,
                ]}
                onPress={() => setMode("CREATE_ACCOUNT")}
                activeOpacity={0.8}
              >
                <Text
                  style={[
                    styles.tabButtonText,
                    mode === "CREATE_ACCOUNT" && styles.tabButtonTextActive,
                  ]}
                >
                  CREATE ACCOUNT
                </Text>
              </TouchableOpacity>
            </View>
          )}

          {/* ---------------------------------------------------- */}
          {/* VIEW 1: SIGN IN (Auto-Detects Admin vs Worker)        */}
          {/* ---------------------------------------------------- */}
          {mode === "SIGN_IN" && (
            <View style={styles.formCard}>
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>OFFICIAL EMAIL ADDRESS</Text>
                <View style={styles.inputWrapper}>
                  <Ionicons name="mail-outline" size={18} color="#64748b" style={styles.inputIcon} />
                  <TextInput
                    style={styles.textInput}
                    placeholder="e.g. worker@organization.org"
                    placeholderTextColor="#94a3b8"
                    value={email}
                    onChangeText={setEmail}
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>
              </View>

              <View style={styles.inputGroup}>
                <View style={styles.labelRow}>
                  <Text style={styles.inputLabel}>PASSWORD</Text>
                  <TouchableOpacity
                    onPress={() => {
                      setMode("FORGOT_PASSWORD");
                    }}
                  >
                    <Text style={styles.forgotPasswordText}>Forgot Password?</Text>
                  </TouchableOpacity>
                </View>
                <View style={styles.inputWrapper}>
                  <Ionicons name="lock-closed-outline" size={18} color="#64748b" style={styles.inputIcon} />
                  <TextInput
                    style={styles.textInput}
                    placeholder="Enter account password"
                    placeholderTextColor="#94a3b8"
                    value={password}
                    onChangeText={setPassword}
                    secureTextEntry={!showPassword}
                    autoCapitalize="none"
                  />
                  <TouchableOpacity
                    style={styles.eyeButton}
                    onPress={() => setShowPassword(!showPassword)}
                  >
                    <Ionicons
                      name={showPassword ? "eye-off-outline" : "eye-outline"}
                      size={18}
                      color="#64748b"
                    />
                  </TouchableOpacity>
                </View>
              </View>

              {/* Sign In Primary Action */}
              <TouchableOpacity
                style={[styles.primaryButton, isAnyLoading && styles.disabledButton]}
                onPress={handleSignIn}
                disabled={isAnyLoading}
                activeOpacity={0.85}
              >
                {isSubmitting ? (
                  <View style={styles.buttonLoaderRow}>
                    <ActivityIndicator color="#f2f1ee" size="small" />
                    <Text style={styles.primaryButtonText} numberOfLines={1}>
                      {(authStepLabel || "SIGNING IN...").toUpperCase()}
                    </Text>
                  </View>
                ) : (
                  <Text style={styles.primaryButtonText}>SIGN IN</Text>
                )}
              </TouchableOpacity>

              {/* Divider OR */}
              <View style={styles.dividerRow}>
                <View style={styles.dividerLine} />
                <Text style={styles.dividerText}>OR</Text>
                <View style={styles.dividerLine} />
              </View>

              {/* Google Sign In Alternative */}
              <TouchableOpacity
                style={[styles.googleButton, isAnyLoading && styles.disabledButton]}
                onPress={handleStartGoogleSignIn}
                disabled={isAnyLoading}
                activeOpacity={0.85}
              >
                {isGoogleLoading ? (
                  <View style={styles.buttonLoaderRow}>
                    <ActivityIndicator color={C.ink} size="small" />
                    <Text style={styles.googleButtonText} numberOfLines={1}>
                      {(authStepLabel || "CONNECTING GOOGLE...").toUpperCase()}
                    </Text>
                  </View>
                ) : (
                  <>
                    <Ionicons name="logo-google" size={18} color={C.ink} />
                    <Text style={styles.googleButtonText}>CONTINUE WITH GOOGLE</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          )}

          {/* ---------------------------------------------------- */}
          {/* VIEW 2: CREATE ACCOUNT (Role-Based Selection)         */}
          {/* ---------------------------------------------------- */}
          {mode === "CREATE_ACCOUNT" && (
            <View style={styles.formCard}>
              {/* Role Picker */}
              <Text style={styles.inputLabel}>CHOOSE YOUR ACCOUNT TYPE</Text>
              <View style={styles.rolePickerRow}>
                {/* Option 1: Worker */}
                <TouchableOpacity
                  style={[
                    styles.roleCard,
                    selectedRole === "WORKER" && styles.roleCardActive,
                  ]}
                  onPress={() => setSelectedRole("WORKER")}
                  activeOpacity={0.85}
                >
                  <View style={styles.roleCardHeader}>
                    <Ionicons
                      name="briefcase-outline"
                      size={20}
                      color={selectedRole === "WORKER" ? "#142748" : "#64748b"}
                    />
                    {selectedRole === "WORKER" && (
                      <Ionicons name="checkmark-circle" size={18} color="#2d81ff" />
                    )}
                  </View>
                  <Text
                    style={[
                      styles.roleCardTitle,
                      selectedRole === "WORKER" && styles.roleCardTitleActive,
                    ]}
                  >
                    Workforce Member
                  </Text>
                  <Text style={styles.roleCardDesc}>
                    Clock in on-site, facial recognition & attendance verification
                  </Text>
                </TouchableOpacity>

                {/* Option 2: Field Admin */}
                <TouchableOpacity
                  style={[
                    styles.roleCard,
                    selectedRole === "ADMIN" && styles.roleCardActive,
                  ]}
                  onPress={() => setSelectedRole("ADMIN")}
                  activeOpacity={0.85}
                >
                  <View style={styles.roleCardHeader}>
                    <Ionicons
                      name="shield-checkmark-outline"
                      size={20}
                      color={selectedRole === "ADMIN" ? "#142748" : "#64748b"}
                    />
                    {selectedRole === "ADMIN" && (
                      <Ionicons name="checkmark-circle" size={18} color="#2d81ff" />
                    )}
                  </View>
                  <Text
                    style={[
                      styles.roleCardTitle,
                      selectedRole === "ADMIN" && styles.roleCardTitleActive,
                    ]}
                  >
                    Field Administrator
                  </Text>
                  <Text style={styles.roleCardDesc}>
                    Calibrate presence anchors, oversee workforce & premises
                  </Text>
                </TouchableOpacity>
              </View>

              {/* Full Name */}
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>FULL NAME</Text>
                <View style={styles.inputWrapper}>
                  <Ionicons name="person-outline" size={18} color="#64748b" style={styles.inputIcon} />
                  <TextInput
                    style={styles.textInput}
                    placeholder="e.g. Jane Doe"
                    placeholderTextColor="#94a3b8"
                    value={fullName}
                    onChangeText={setFullName}
                    autoCapitalize="words"
                  />
                </View>
              </View>

              {/* Work Email */}
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>WORK EMAIL ADDRESS</Text>
                <View style={styles.inputWrapper}>
                  <Ionicons name="mail-outline" size={18} color="#64748b" style={styles.inputIcon} />
                  <TextInput
                    style={styles.textInput}
                    placeholder="e.g. worker@organization.org"
                    placeholderTextColor="#94a3b8"
                    value={email}
                    onChangeText={setEmail}
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>
              </View>

              {/* Password */}
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>CREATE PASSWORD (MIN 6 CHARACTERS)</Text>
                <View style={styles.inputWrapper}>
                  <Ionicons name="lock-closed-outline" size={18} color="#64748b" style={styles.inputIcon} />
                  <TextInput
                    style={styles.textInput}
                    placeholder="Minimum 6 characters"
                    placeholderTextColor="#94a3b8"
                    value={password}
                    onChangeText={setPassword}
                    secureTextEntry={!showPassword}
                    autoCapitalize="none"
                  />
                  <TouchableOpacity
                    style={styles.eyeButton}
                    onPress={() => setShowPassword(!showPassword)}
                  >
                    <Ionicons
                      name={showPassword ? "eye-off-outline" : "eye-outline"}
                      size={18}
                      color="#64748b"
                    />
                  </TouchableOpacity>
                </View>
              </View>

              {/* Confirm Password */}
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>CONFIRM PASSWORD</Text>
                <View style={styles.inputWrapper}>
                  <Ionicons name="lock-closed-outline" size={18} color="#64748b" style={styles.inputIcon} />
                  <TextInput
                    style={styles.textInput}
                    placeholder="Re-enter password"
                    placeholderTextColor="#94a3b8"
                    value={confirmPassword}
                    onChangeText={setConfirmPassword}
                    secureTextEntry={!showConfirmPassword}
                    autoCapitalize="none"
                  />
                  <TouchableOpacity
                    style={styles.eyeButton}
                    onPress={() => setShowConfirmPassword(!showConfirmPassword)}
                  >
                    <Ionicons
                      name={showConfirmPassword ? "eye-off-outline" : "eye-outline"}
                      size={18}
                      color="#64748b"
                    />
                  </TouchableOpacity>
                </View>
              </View>

              {/* Submit Code Request */}
              <TouchableOpacity
                style={[styles.primaryButton, isAnyLoading && styles.disabledButton]}
                onPress={handleRequestSignUpOtp}
                disabled={isAnyLoading}
                activeOpacity={0.85}
              >
                {isSubmitting ? (
                  <View style={styles.buttonLoaderRow}>
                    <ActivityIndicator color="#f2f1ee" size="small" />
                    <Text style={styles.primaryButtonText}>SENDING CODE...</Text>
                  </View>
                ) : (
                  <Text style={styles.primaryButtonText}>SEND VERIFICATION CODE</Text>
                )}
              </TouchableOpacity>

              {/* Divider OR */}
              <View style={styles.dividerRow}>
                <View style={styles.dividerLine} />
                <Text style={styles.dividerText}>OR</Text>
                <View style={styles.dividerLine} />
              </View>

              {/* Google Sign In Alternative */}
              <TouchableOpacity
                style={[styles.googleButton, isAnyLoading && styles.disabledButton]}
                onPress={handleStartGoogleSignIn}
                disabled={isAnyLoading}
                activeOpacity={0.85}
              >
                {isGoogleLoading ? (
                  <View style={styles.buttonLoaderRow}>
                    <ActivityIndicator color={C.ink} size="small" />
                    <Text style={styles.googleButtonText} numberOfLines={1}>
                      {(authStepLabel || "CONNECTING GOOGLE...").toUpperCase()}
                    </Text>
                  </View>
                ) : (
                  <>
                    <Ionicons name="logo-google" size={18} color={C.ink} />
                    <Text style={styles.googleButtonText}>CONTINUE WITH GOOGLE</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          )}

          {/* ---------------------------------------------------- */}
          {/* VIEW 3: VERIFY OTP CODE (Auto-Submits on 6th digit)    */}
          {/* ---------------------------------------------------- */}
          {mode === "VERIFY_OTP" && (
            <View style={styles.formCard}>
              <View style={styles.otpHeaderBox}>
                <View style={styles.otpBadge}>
                  <Ionicons name="mail-unread-outline" size={24} color="#142748" />
                </View>
                <Text style={styles.otpDestination}>{email}</Text>
                <TouchableOpacity onPress={() => setMode("CREATE_ACCOUNT")}>
                  <Text style={styles.changeEmailLink}>Change Email Address</Text>
                </TouchableOpacity>
              </View>

              <Text style={styles.inputLabelCenter}>ENTER 6-DIGIT VERIFICATION CODE</Text>

              {/* Animated 6-Digit Boxes */}
              <Animated.View
                style={[
                  styles.otpBoxesRow,
                  { transform: [{ translateX: shakeAnim }] },
                ]}
              >
                {otpDigits.map((digit, idx) => (
                  <TextInput
                    key={idx}
                    ref={(ref) => {
                      otpInputRefs.current[idx] = ref;
                    }}
                    style={[
                      styles.otpBox,
                      digit ? styles.otpBoxFilled : null,
                    ]}
                    value={digit}
                    onChangeText={(val) => handleOtpDigitChange(idx, val)}
                    onKeyPress={(e) => handleOtpKeyPress(idx, e)}
                    keyboardType="number-pad"
                    maxLength={1}
                    selectTextOnFocus
                    editable={!isVerifyingOtp}
                  />
                ))}
              </Animated.View>

              {/* Auto submit status / indicator */}
              {isVerifyingOtp && (
                <View style={styles.autoSubmitRow}>
                  <ActivityIndicator size="small" color="#2d81ff" />
                  <Text style={styles.autoSubmitText}>
                    {authStepLabel || "Verifying code & preparing account..."}
                  </Text>
                </View>
              )}

              {/* Manual Verify Button as fallback */}
              <TouchableOpacity
                style={[
                  styles.primaryButton,
                  (isVerifyingOtp || otpDigits.join("").length < 6) && styles.disabledButton,
                ]}
                onPress={() => handleVerifyOtp()}
                disabled={isVerifyingOtp || otpDigits.join("").length < 6}
                activeOpacity={0.85}
              >
                {isVerifyingOtp ? (
                  <View style={styles.buttonLoaderRow}>
                    <ActivityIndicator color="#f2f1ee" size="small" />
                    <Text style={styles.primaryButtonText} numberOfLines={1}>
                      {(authStepLabel || "VERIFYING CODE...").toUpperCase()}
                    </Text>
                  </View>
                ) : (
                  <Text style={styles.primaryButtonText}>VERIFY & FINISH</Text>
                )}
              </TouchableOpacity>

              {/* Resend Code Section */}
              <View style={styles.resendSection}>
                {canResend ? (
                  <TouchableOpacity onPress={handleResendOtp} disabled={isSubmitting}>
                    <Text style={styles.resendLink}>Resend Verification Code</Text>
                  </TouchableOpacity>
                ) : (
                  <Text style={styles.resendCountdownText}>
                    Resend available in {resendCountdown}s
                  </Text>
                )}
              </View>
            </View>
          )}

          {/* ---------------------------------------------------- */}
          {/* VIEW 4: FORGOT PASSWORD REQUEST                       */}
          {/* ---------------------------------------------------- */}
          {mode === "FORGOT_PASSWORD" && (
            <View style={styles.formCard}>
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>REGISTERED WORK EMAIL</Text>
                <View style={styles.inputWrapper}>
                  <Ionicons name="mail-outline" size={18} color="#64748b" style={styles.inputIcon} />
                  <TextInput
                    style={styles.textInput}
                    placeholder="e.g. worker@organization.org"
                    placeholderTextColor="#94a3b8"
                    value={email}
                    onChangeText={setEmail}
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>
              </View>

              <TouchableOpacity
                style={[styles.primaryButton, isSubmitting && styles.disabledButton]}
                onPress={handleRequestPasswordResetOtp}
                disabled={isSubmitting}
                activeOpacity={0.85}
              >
                {isSubmitting ? (
                  <View style={styles.buttonLoaderRow}>
                    <ActivityIndicator color="#f2f1ee" size="small" />
                    <Text style={styles.primaryButtonText}>SENDING CODE...</Text>
                  </View>
                ) : (
                  <Text style={styles.primaryButtonText}>SEND RECOVERY CODE</Text>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.backButton}
                onPress={() => setMode("SIGN_IN")}
              >
                <Ionicons name="arrow-back" size={16} color="#142748" />
                <Text style={styles.backButtonText}>BACK TO SIGN IN</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* ---------------------------------------------------- */}
          {/* VIEW 5: RESET PASSWORD WITH OTP                      */}
          {/* ---------------------------------------------------- */}
          {mode === "RESET_PASSWORD" && (
            <View style={styles.formCard}>
              <Text style={styles.inputLabelCenter}>6-DIGIT RECOVERY CODE</Text>
              <Animated.View
                style={[
                  styles.otpBoxesRow,
                  { transform: [{ translateX: shakeAnim }] },
                ]}
              >
                {otpDigits.map((digit, idx) => (
                  <TextInput
                    key={idx}
                    ref={(ref) => {
                      otpInputRefs.current[idx] = ref;
                    }}
                    style={[styles.otpBox, digit ? styles.otpBoxFilled : null]}
                    value={digit}
                    onChangeText={(val) => handleOtpDigitChange(idx, val)}
                    onKeyPress={(e) => handleOtpKeyPress(idx, e)}
                    keyboardType="number-pad"
                    maxLength={1}
                    selectTextOnFocus
                  />
                ))}
              </Animated.View>

              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>NEW PASSWORD (MIN 6 CHARACTERS)</Text>
                <View style={styles.inputWrapper}>
                  <Ionicons name="lock-closed-outline" size={18} color="#64748b" style={styles.inputIcon} />
                  <TextInput
                    style={styles.textInput}
                    placeholder="Enter new password"
                    placeholderTextColor="#94a3b8"
                    value={newPassword}
                    onChangeText={setNewPassword}
                    secureTextEntry={!showPassword}
                    autoCapitalize="none"
                  />
                  <TouchableOpacity
                    style={styles.eyeButton}
                    onPress={() => setShowPassword(!showPassword)}
                  >
                    <Ionicons
                      name={showPassword ? "eye-off-outline" : "eye-outline"}
                      size={18}
                      color="#64748b"
                    />
                  </TouchableOpacity>
                </View>
              </View>

              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>CONFIRM NEW PASSWORD</Text>
                <View style={styles.inputWrapper}>
                  <Ionicons name="lock-closed-outline" size={18} color="#64748b" style={styles.inputIcon} />
                  <TextInput
                    style={styles.textInput}
                    placeholder="Re-enter new password"
                    placeholderTextColor="#94a3b8"
                    value={confirmNewPassword}
                    onChangeText={setConfirmNewPassword}
                    secureTextEntry={!showConfirmPassword}
                    autoCapitalize="none"
                  />
                  <TouchableOpacity
                    style={styles.eyeButton}
                    onPress={() => setShowConfirmPassword(!showConfirmPassword)}
                  >
                    <Ionicons
                      name={showConfirmPassword ? "eye-off-outline" : "eye-outline"}
                      size={18}
                      color="#64748b"
                    />
                  </TouchableOpacity>
                </View>
              </View>

              <TouchableOpacity
                style={[styles.primaryButton, isSubmitting && styles.disabledButton]}
                onPress={handleSubmitNewPassword}
                disabled={isSubmitting}
                activeOpacity={0.85}
              >
                {isSubmitting ? (
                  <View style={styles.buttonLoaderRow}>
                    <ActivityIndicator color="#f2f1ee" size="small" />
                    <Text style={styles.primaryButtonText}>RESETTING PASSWORD...</Text>
                  </View>
                ) : (
                  <Text style={styles.primaryButtonText}>UPDATE PASSWORD & SIGN IN</Text>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.backButton}
                onPress={() => setMode("SIGN_IN")}
              >
                <Ionicons name="arrow-back" size={16} color="#142748" />
                <Text style={styles.backButtonText}>BACK TO SIGN IN</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Footer Branding */}
          <View style={styles.footer}>
            <Text style={styles.footerText}>
              Presenti • Proof of Presence, Made Simple
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: C.canvas,
  },
  keyboardAvoid: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: S.screenX,
    paddingVertical: S.lg,
    justifyContent: "center",
    flexGrow: 1,
    maxWidth: 520,
    width: "100%",
    alignSelf: "center",
  },
  header: {
    marginBottom: S.lg,
  },
  brandIconImage: {
    width: 56,
    height: 56,
    borderRadius: R.md,
    marginBottom: S.md,
  },
  brandBadge: {
    ...ui.pill,
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.lineCard,
    alignSelf: "flex-start",
    marginBottom: 12,
  },
  brandBadgeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: C.accent,
  },
  brandTag: {
    ...T.labelSm,
    color: C.ink,
  },
  title: {
    ...T.display,
    fontSize: 30,
    lineHeight: 36,
    marginBottom: 8,
  },
  subtitle: {
    ...T.body,
    color: C.ink2,
  },
  tabContainer: {
    flexDirection: "row",
    backgroundColor: C.line,
    padding: 4,
    borderRadius: R.md,
    marginBottom: S.lg,
  },
  tabButton: {
    flex: 1,
    paddingVertical: 11,
    borderRadius: R.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  tabButtonActive: {
    backgroundColor: C.card,
    ...shadow.card,
  },
  tabButtonText: {
    ...T.labelSm,
    color: C.muted,
  },
  tabButtonTextActive: {
    color: C.ink,
  },
  formCard: {
    ...ui.card,
    padding: S.lg,
    marginBottom: S.lg,
    gap: S.md,
  },
  rolePickerRow: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 4,
  },
  roleCard: {
    flex: 1,
    padding: 14,
    borderRadius: R.md,
    borderWidth: 1.5,
    borderColor: C.lineCard,
    backgroundColor: C.cardAlt,
    gap: 6,
  },
  roleCardActive: {
    borderColor: C.ink,
    backgroundColor: C.card,
  },
  roleCardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  roleCardTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: C.muted,
  },
  roleCardTitleActive: {
    color: C.ink,
  },
  roleCardDesc: {
    ...T.caption,
    fontSize: 11,
    lineHeight: 15,
  },
  inputGroup: {
    gap: 8,
  },
  labelRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  inputLabel: {
    ...T.labelSm,
    color: C.ink,
  },
  inputLabelCenter: {
    ...T.labelSm,
    color: C.ink,
    textAlign: "center",
  },
  forgotPasswordText: {
    fontSize: 12,
    color: C.accent,
    fontWeight: "600",
  },
  inputWrapper: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: R.md,
    backgroundColor: C.cardAlt,
    height: 54,
    paddingHorizontal: 14,
  },
  inputIcon: {
    marginRight: 10,
  },
  textInput: {
    flex: 1,
    fontSize: 15,
    color: C.ink,
    paddingVertical: 10,
  },
  eyeButton: {
    padding: 6,
  },
  primaryButton: {
    ...ui.btnPrimary,
    ...shadow.raised,
  },
  primaryButtonText: {
    ...ui.btnPrimaryText,
  },
  disabledButton: {
    opacity: 0.6,
  },
  buttonLoaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginVertical: 4,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: C.lineCard,
  },
  dividerText: {
    ...T.labelSm,
    color: C.muted,
  },
  googleButton: {
    ...ui.btnSecondary,
    height: 52,
  },
  googleButtonText: {
    ...ui.btnSecondaryText,
  },
  otpHeaderBox: {
    alignItems: "center",
    gap: 6,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: C.lineCard,
  },
  otpBadge: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: C.accentSoft,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  otpDestination: {
    ...T.heading,
    fontSize: 15,
  },
  changeEmailLink: {
    fontSize: 12.5,
    color: C.accent,
    fontWeight: "600",
  },
  otpBoxesRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 8,
    marginVertical: 10,
  },
  otpBox: {
    width: 46,
    height: 54,
    borderRadius: R.sm,
    borderWidth: 1.5,
    borderColor: C.line,
    backgroundColor: C.cardAlt,
    fontSize: 22,
    fontWeight: "800",
    textAlign: "center",
    color: C.ink,
    fontFamily: MONO,
  },
  otpBoxFilled: {
    borderColor: C.ink,
    backgroundColor: C.card,
  },
  autoSubmitRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 4,
  },
  autoSubmitText: {
    fontSize: 12.5,
    color: C.accent,
    fontWeight: "600",
  },
  resendSection: {
    alignItems: "center",
    paddingTop: 8,
  },
  resendLink: {
    fontSize: 13,
    color: C.accent,
    fontWeight: "700",
  },
  resendCountdownText: {
    ...T.caption,
    fontSize: 12.5,
  },
  backButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 8,
  },
  backButtonText: {
    ...T.labelSm,
    color: C.ink,
  },
  footer: {
    alignItems: "center",
    marginTop: 8,
  },
  footerText: {
    ...T.labelSm,
    color: C.muted,
  },
});
