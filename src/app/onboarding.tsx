import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Image,
} from "react-native";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import {
  getAppPermissionsStatus,
  requestAllAppPermissions,
  AppPermissionsStatus,
} from "../services/permissionService";
import { checkIfUserIsAdmin } from "../services/organizationService";
import { FaceScanModal } from "../components/FaceScanModal";

export function formatOrgCode(raw: string, prev: string = ""): string {
  // If user deleted (backspace) and hit a hyphen
  if (prev.length > raw.length) {
    if (prev.endsWith("-") && raw === prev.slice(0, -1)) {
      return raw.slice(0, -1).toUpperCase();
    }
    return raw.toUpperCase();
  }

  // Strip all non-alphanumeric characters, up to 8 core alphanumeric characters
  const clean = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
  if (!clean) return "";

  if (clean.length < 2) {
    return clean;
  }
  if (clean.length === 2) {
    return `${clean}-`;
  }
  if (clean.length < 5) {
    return `${clean.slice(0, 2)}-${clean.slice(2)}`;
  }
  if (clean.length === 5) {
    return `${clean.slice(0, 2)}-${clean.slice(2, 5)}-`;
  }
  return `${clean.slice(0, 2)}-${clean.slice(2, 5)}-${clean.slice(5, 8)}`;
}

export default function OnboardingScreen() {
  const {
    user,
    organization,
    member,
    isAdmin,
    pairOrganization,
    completeRegistration,
    signOut,
  } = useAuth();
  const toast = useToast();

  const [churchCodeInput, setChurchCodeInput] = useState(
    organization?.churchCode || "",
  );
  const [isVerifyingCode, setIsVerifyingCode] = useState(false);
  const [verifiedOrg, setVerifiedOrg] = useState(organization);

  const [fullName, setFullName] = useState(user?.displayName || "");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [selectedDept, setSelectedDept] = useState("");
  const [faceEmbedding, setFaceEmbedding] = useState<number[] | null>(null);
  const [facePhotoURL, setFacePhotoURL] = useState<string | null>(null);
  const [showFaceModal, setShowFaceModal] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false);
  const [permissions, setPermissions] = useState<AppPermissionsStatus | null>(null);
  const codeInputRef = React.useRef<TextInput>(null);

  // Administrators are strictly blocked from workforce onboarding on mobile
  useEffect(() => {
    if (isAdmin || user?.isAdmin) {
      toast.error(
        "Administrator accounts cannot be registered as workforce members on mobile."
      );
      signOut();
      router.replace("/login");
      return;
    }

    if (user?.email) {
      const cleanEmail = user.email.trim().toLowerCase();
      checkIfUserIsAdmin(cleanEmail, user.uid).then((isAdm) => {
        if (isAdm) {
          toast.error(
            "Administrator accounts cannot be registered as workforce members on mobile."
          );
          signOut();
          router.replace("/login");
        }
      });
    }
  }, [isAdmin, user]);

  // If user is already registered with an active organization, forward to dashboard
  useEffect(() => {
    if (user && organization && member) {
      router.replace("/");
    }
  }, [user, organization, member]);

  // If not authenticated with Google, send back to login
  useEffect(() => {
    if (!user) {
      router.replace("/login");
    }
  }, [user]);

  // Auto-select first department when org is verified
  useEffect(() => {
    if (verifiedOrg && verifiedOrg.departments.length > 0 && !selectedDept) {
      setSelectedDept(verifiedOrg.departments[0]);
    }
  }, [verifiedOrg, selectedDept]);

  // Check initial permissions
  useEffect(() => {
    getAppPermissionsStatus().then(setPermissions).catch(() => {});
  }, []);

  const handleRequestPermissions = async () => {
    const updated = await requestAllAppPermissions(true);
    setPermissions(updated);
    if (updated.locationGranted) {
      toast.success("Location access granted! Presence verification active.");
    } else {
      toast.warn("Location permission required for attendance verification.");
    }
  };

  const handlePasteCode = async () => {
    try {
      const text = await Clipboard.getStringAsync();
      if (text && text.trim()) {
        const formatted = formatOrgCode(text.trim(), churchCodeInput);
        setChurchCodeInput(formatted);
        toast.info(`Pasted: ${formatted}`);
        return;
      }
      toast.warn("Clipboard is empty.");
    } catch {
      codeInputRef.current?.focus();
      toast.info("Long-press the input box and tap 'Paste'.");
    }
  };

  const handleVerifyCode = async () => {
    if (!churchCodeInput.trim()) {
      toast.warn("Please enter your organization code.");
      return;
    }

    setIsVerifyingCode(true);
    try {
      const org = await pairOrganization(churchCodeInput);
      setVerifiedOrg(org);
      if (org.departments.length > 0) {
        setSelectedDept(org.departments[0]);
      }
      toast.success(
        "Paired with " + org.churchName + ". Anchors cached on device.",
      );
      // Also request permissions when organization code is successfully paired
      requestAllAppPermissions().then(setPermissions).catch(() => {});
    } catch (err: any) {
      toast.error(err?.message || "Could not find organization.");
    } finally {
      setIsVerifyingCode(false);
    }
  };

  const handleCompleteRegistration = async () => {
    if (!fullName.trim()) {
      toast.warn("Please enter your full name.");
      return;
    }
    if (!phoneNumber.trim()) {
      toast.warn("Please enter your phone number.");
      return;
    }
    if (!selectedDept) {
      toast.warn("Please select your department.");
      return;
    }

    if (!faceEmbedding) {
      toast.info("Facial biometrics binding is required to protect your attendance account.");
      setShowFaceModal(true);
      return;
    }

    // Ensure location permission has been requested before completing setup
    if (!permissions?.locationGranted) {
      const updated = await requestAllAppPermissions(true);
      setPermissions(updated);
    }

    setIsRegistering(true);
    try {
      await completeRegistration(
        fullName,
        phoneNumber,
        selectedDept,
        faceEmbedding,
        facePhotoURL || undefined
      );
      toast.success(
        "Welcome to " + (verifiedOrg?.churchName || "the organization") + "!",
      );
      router.replace("/");
    } catch (err: any) {
      toast.error(err?.message || "Failed to complete enrollment.");
    } finally {
      setIsRegistering(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView contentContainerStyle={styles.scrollContent}>
          {/* Header */}
          <View style={styles.header}>
            <Image
              source={require("../image/app-icon.png")}
              style={styles.brandIconImage}
              resizeMode="contain"
            />
            <Text style={styles.brandTag}>
              STEP {verifiedOrg ? "2 OF 2" : "1 OF 2"}
            </Text>
            <Text style={styles.title}>
              {verifiedOrg ? "Department Enrollment" : "Organization Pairing"}
            </Text>
            <Text style={styles.subtitle}>
              {verifiedOrg
                ? "Select your assigned unit to link your profile to " +
                  verifiedOrg.churchName +
                  "."
                : "Enter the organization code provided by your administrator to pull settings and presence anchors."}
            </Text>
          </View>

          {/* Step 1: Code Verification */}
          {!verifiedOrg ? (
            <View style={styles.stepContainer}>
              <View style={styles.fieldGroup}>
                <View style={styles.labelRow}>
                  <Text style={styles.label}>Organization Code *</Text>
                  <TouchableOpacity
                    style={styles.pasteButton}
                    onPress={handlePasteCode}
                    activeOpacity={0.7}
                  >
                    <Ionicons
                      name="clipboard-outline"
                      size={13}
                      color="#2563EB"
                    />
                    <Text style={styles.pasteButtonText}>Paste</Text>
                  </TouchableOpacity>
                </View>

                <View style={styles.inputWrapper}>
                  <TextInput
                    ref={codeInputRef}
                    style={[styles.input, styles.codeInput]}
                    placeholder="XX-XXX-XXX"
                    placeholderTextColor="#94A3B8"
                    value={churchCodeInput}
                    onChangeText={(t) => {
                      const formatted = formatOrgCode(t, churchCodeInput);
                      setChurchCodeInput(formatted);
                    }}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    maxLength={10}
                  />
                  {churchCodeInput.length > 0 && (
                    <TouchableOpacity
                      style={styles.clearButton}
                      onPress={() => setChurchCodeInput("")}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    >
                      <Ionicons name="close-circle" size={18} color="#94A3B8" />
                    </TouchableOpacity>
                  )}
                </View>
                <Text style={styles.helperText}>
                  Standard format: XX-XXX-XXX (e.g. TO-CRR-656). Auto-inserts
                  dashes as you type.
                </Text>
              </View>

              <TouchableOpacity
                style={[
                  styles.primaryButton,
                  isVerifyingCode && styles.disabledButton,
                ]}
                onPress={handleVerifyCode}
                disabled={isVerifyingCode}
                activeOpacity={0.8}
              >
                {isVerifyingCode ? (
                  <View style={styles.buttonLoaderRow}>
                    <ActivityIndicator color="#FFFFFF" size="small" />
                    <Text style={styles.primaryButtonText}>
                      Verifying Organization...
                    </Text>
                  </View>
                ) : (
                  <Text style={styles.primaryButtonText}>
                    Verify & Cache Anchors
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.stepContainer}>
              {/* Paired Org Confirmation Banner */}
              <View style={styles.orgInfoCard}>
                <Text style={styles.orgNameText}>{verifiedOrg.churchName}</Text>
                <Text style={styles.orgBranchText}>
                  {verifiedOrg.branchName} • Code: {verifiedOrg.churchCode}
                </Text>
                <Text style={styles.orgAnchorText}>
                  Presence anchors (Wi-Fi:{" "}
                  {verifiedOrg.beaconConfig.ssidHint || "Configured"} &
                  Geofence: {verifiedOrg.geoFallback.radiusMeters}m) cached
                  locally.
                </Text>
              </View>

              <View style={styles.fieldGroup}>
                <Text style={styles.label}>Full Name *</Text>
                <TextInput
                  style={styles.input}
                  placeholder="e.g. Brother Samuel"
                  placeholderTextColor="#94A3B8"
                  value={fullName}
                  onChangeText={setFullName}
                />
              </View>

              <View style={styles.fieldGroup}>
                <Text style={styles.label}>Phone Number *</Text>
                <TextInput
                  style={styles.input}
                  placeholder="e.g. +234 803 123 4567"
                  placeholderTextColor="#94A3B8"
                  value={phoneNumber}
                  onChangeText={setPhoneNumber}
                  keyboardType="phone-pad"
                />
              </View>

              <View style={styles.fieldGroup}>
                <Text style={styles.label}>Department Unit *</Text>
                <View style={styles.deptChipsContainer}>
                  {verifiedOrg.departments.map((dept) => {
                    const isSelected = selectedDept === dept;
                    return (
                      <TouchableOpacity
                        key={dept}
                        style={[
                          styles.deptChip,
                          isSelected && styles.deptChipSelected,
                        ]}
                        onPress={() => setSelectedDept(dept)}
                        activeOpacity={0.7}
                      >
                        <Text
                          style={[
                            styles.deptChipText,
                            isSelected && styles.deptChipTextSelected,
                          ]}
                        >
                          {dept}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              {/* Facial Biometrics Identity Binding Card */}
              <View style={styles.fieldGroup}>
                <Text style={styles.label}>Facial Biometrics Binding *</Text>
                {faceEmbedding ? (
                  <View style={styles.faceEnrolledCard}>
                    {facePhotoURL ? (
                      <Image source={{ uri: facePhotoURL }} style={styles.faceThumbnail} />
                    ) : (
                      <View style={styles.faceThumbnailPlaceholder}>
                        <Ionicons name="person" size={22} color="#059669" />
                      </View>
                    )}
                    <View style={{ flex: 1, gap: 2 }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                        <Ionicons name="shield-checkmark" size={15} color="#059669" />
                        <Text style={styles.faceEnrolledTitle}>Face Biometric Bound</Text>
                      </View>
                      <Text style={styles.faceEnrolledDesc}>
                        128D mathematical vector enrolled. Anti-spoofing active.
                      </Text>
                    </View>
                    <TouchableOpacity
                      style={styles.faceRescanBtn}
                      onPress={() => setShowFaceModal(true)}
                    >
                      <Text style={styles.faceRescanText}>Re-scan</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <TouchableOpacity
                    style={styles.faceEnrollPromptCard}
                    onPress={() => setShowFaceModal(true)}
                    activeOpacity={0.8}
                  >
                    <View style={styles.faceScanIconCircle}>
                      <Ionicons name="scan-outline" size={24} color="#142748" />
                    </View>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={styles.faceEnrollPromptTitle}>Scan & Bind Face ID</Text>
                      <Text style={styles.faceEnrollPromptDesc}>
                        Binds your facial geometry to your account to prevent buddy punching.
                      </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color="#94A3B8" />
                  </TouchableOpacity>
                )}
              </View>

              {/* Permission Status Banner */}
              <View
                style={[
                  styles.permCard,
                  permissions?.locationGranted
                    ? styles.permCardGranted
                    : styles.permCardPending,
                ]}
              >
                <View style={styles.permIconBadge}>
                  <Ionicons
                    name={
                      permissions?.locationGranted
                        ? "shield-checkmark"
                        : "location"
                    }
                    size={18}
                    color={permissions?.locationGranted ? "#059669" : "#D97706"}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text
                    style={[
                      styles.permCardTitle,
                      permissions?.locationGranted
                        ? styles.permTitleGranted
                        : styles.permTitlePending,
                    ]}
                  >
                    {permissions?.locationGranted
                      ? "Location Permission Active"
                      : "Location Access Required"}
                  </Text>
                  <Text style={styles.permCardSubtitle}>
                    {permissions?.locationGranted
                      ? "Device presence verification is fully operational."
                      : "Needed to verify on-premise attendance when off beacon Wi-Fi."}
                  </Text>
                </View>
                {!permissions?.locationGranted && (
                  <TouchableOpacity
                    style={styles.permGrantBtn}
                    onPress={handleRequestPermissions}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.permGrantBtnText}>Allow</Text>
                  </TouchableOpacity>
                )}
              </View>

              <TouchableOpacity
                style={[
                  styles.primaryButton,
                  isRegistering && styles.disabledButton,
                ]}
                onPress={handleCompleteRegistration}
                disabled={isRegistering}
                activeOpacity={0.8}
              >
                {isRegistering ? (
                  <View style={styles.buttonLoaderRow}>
                    <ActivityIndicator color="#FFFFFF" size="small" />
                    <Text style={styles.primaryButtonText}>
                      Setting up profile...
                    </Text>
                  </View>
                ) : (
                  <Text style={styles.primaryButtonText}>
                    Complete Profile Setup
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Face Scan Modal */}
      <FaceScanModal
        visible={showFaceModal}
        mode="ENROLL"
        memberName={fullName || user?.displayName || "Workforce Member"}
        onSuccess={(result) => {
          setFaceEmbedding(result.embedding);
          if (result.thumbnailBase64) {
            setFacePhotoURL(result.thumbnailBase64);
          }
          setShowFaceModal(false);
          toast.success("Facial identity bound to your account!");
        }}
        onFailure={(reason) => {
          toast.error(reason || "Face scan failed.");
        }}
        onClose={() => setShowFaceModal(false)}
      />
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
    flexGrow: 1,
    maxWidth: 520,
    width: "100%",
    alignSelf: "center",
  },
  header: {
    marginBottom: 28,
  },
  brandIconImage: {
    width: 56,
    height: 56,
    borderRadius: 0,
    marginBottom: 16,
  },
  brandTag: {
    fontSize: 10,
    fontWeight: "700",
    color: "#142748",
    letterSpacing: 0.8,
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
    marginBottom: 6,
  },
  title: {
    fontSize: 28,
    fontWeight: "800",
    color: "#142748",
    letterSpacing: -0.6,
    marginBottom: 8,
    lineHeight: 34,
  },
  subtitle: {
    fontSize: 14,
    color: "#52525b",
    lineHeight: 22,
  },
  stepContainer: {
    gap: 16,
  },
  fieldGroup: {
    gap: 6,
  },
  label: {
    fontSize: 11,
    fontWeight: "700",
    color: "#142748",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
  },
  input: {
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 0,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 14,
    color: "#142748",
  },
  codeInput: {
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
    fontSize: 20,
    fontWeight: "700",
    letterSpacing: 2,
    textAlign: "center",
    paddingVertical: 14,
    borderColor: "rgba(20, 39, 72, 0.4)",
    backgroundColor: "#ffffff",
    borderRadius: 0,
  },
  primaryButton: {
    backgroundColor: "#142748",
    paddingVertical: 14,
    borderRadius: 0,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 10,
    minHeight: 48,
    elevation: 0,
    shadowOpacity: 0,
  },
  disabledButton: {
    opacity: 0.65,
  },
  primaryButtonText: {
    color: "#f2f1ee",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
    textTransform: "uppercase",
  },
  orgInfoCard: {
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 0,
    padding: 16,
    gap: 4,
  },
  orgNameText: {
    fontSize: 15,
    fontWeight: "700",
    color: "#142748",
  },
  orgBranchText: {
    fontSize: 12,
    fontWeight: "500",
    color: "#52525b",
    marginTop: 2,
  },
  orgAnchorText: {
    fontSize: 11,
    color: "#2d81ff",
    marginTop: 6,
    lineHeight: 16,
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
  },
  deptChipsContainer: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  deptChip: {
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 0,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  deptChipSelected: {
    backgroundColor: "#142748",
    borderColor: "#142748",
  },
  deptChipText: {
    fontSize: 12,
    color: "#142748",
    fontWeight: "600",
  },
  deptChipTextSelected: {
    color: "#f2f1ee",
    fontWeight: "700",
  },
  lockNotice: {
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 0,
    padding: 10,
  },
  lockNoticeText: {
    fontSize: 11,
    color: "#52525b",
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
  },
  labelRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  pasteButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#ffffff",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 0,
    borderWidth: 1,
    borderColor: "rgba(20, 39, 72, 0.3)",
  },
  pasteButtonText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#142748",
    letterSpacing: 0.5,
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
  },
  inputWrapper: {
    position: "relative",
    justifyContent: "center",
  },
  clearButton: {
    position: "absolute",
    right: 14,
    height: "100%",
    justifyContent: "center",
  },
  helperText: {
    fontSize: 11,
    color: "#52525b",
    marginTop: 4,
    lineHeight: 16,
  },
  buttonLoaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  permCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: 0,
    padding: 14,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    backgroundColor: "#ffffff",
    marginTop: 4,
  },
  permCardGranted: {
    borderColor: "#142748",
  },
  permCardPending: {
    borderColor: "#e5e7eb",
  },
  permIconBadge: {
    width: 32,
    height: 32,
    borderRadius: 0,
    backgroundColor: "#f2f1ee",
    alignItems: "center",
    justifyContent: "center",
  },
  permCardTitle: {
    fontSize: 12,
    fontWeight: "700",
    color: "#142748",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
  },
  permTitleGranted: {
    color: "#142748",
  },
  permTitlePending: {
    color: "#142748",
  },
  permCardSubtitle: {
    fontSize: 11,
    color: "#52525b",
    marginTop: 2,
    lineHeight: 16,
  },
  permGrantBtn: {
    backgroundColor: "#142748",
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 0,
  },
  permGrantBtnText: {
    color: "#f2f1ee",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.6,
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
    textTransform: "uppercase",
  },
  faceEnrolledCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: 0,
    padding: 12,
    borderWidth: 1,
    borderColor: "#059669",
    backgroundColor: "#ffffff",
  },
  faceThumbnail: {
    width: 44,
    height: 44,
    borderRadius: 0,
    borderWidth: 1,
    borderColor: "#059669",
  },
  faceThumbnailPlaceholder: {
    width: 44,
    height: 44,
    borderRadius: 0,
    backgroundColor: "#f2f1ee",
    alignItems: "center",
    justifyContent: "center",
  },
  faceEnrolledTitle: {
    fontSize: 12,
    fontWeight: "700",
    color: "#059669",
    letterSpacing: 0.3,
  },
  faceEnrolledDesc: {
    fontSize: 11,
    color: "#52525b",
    lineHeight: 15,
  },
  faceRescanBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: "#f2f1ee",
    borderWidth: 1,
    borderColor: "#e5e7eb",
  },
  faceRescanText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#142748",
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
    textTransform: "uppercase",
  },
  faceEnrollPromptCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: 0,
    padding: 14,
    borderWidth: 1,
    borderColor: "rgba(20, 39, 72, 0.3)",
    backgroundColor: "#ffffff",
  },
  faceScanIconCircle: {
    width: 38,
    height: 38,
    borderRadius: 0,
    backgroundColor: "#f2f1ee",
    alignItems: "center",
    justifyContent: "center",
  },
  faceEnrollPromptTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#142748",
  },
  faceEnrollPromptDesc: {
    fontSize: 11,
    color: "#52525b",
    lineHeight: 16,
  },
});
