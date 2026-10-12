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

export function formatOrgCode(raw: string, prev: string = ""): string {
  // If user deleted (backspace)
  if (prev.length > raw.length) {
    if (prev.endsWith("-") && raw === prev.slice(0, -1)) {
      return raw.slice(0, -1).toUpperCase();
    }
    if (raw.endsWith("-")) {
      return raw.slice(0, -1).toUpperCase();
    }
    return raw.toUpperCase();
  }

  if (Math.abs(raw.length - prev.length) > 1 && raw.includes("-")) {
    return raw
      .toUpperCase()
      .replace(/[^A-Z0-9-]/g, "")
      .replace(/-+/g, "-")
      .slice(0, 20);
  }

  const clean = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 7);
  if (!clean) return "";

  if (clean.length < 2) {
    return clean;
  }
  if (clean.length === 2) {
    return `${clean}-`;
  }
  if (clean.length < 4) {
    return `${clean.slice(0, 2)}-${clean.slice(2)}`;
  }
  if (clean.length === 4) {
    return `${clean.slice(0, 2)}-${clean.slice(2, 4)}-`;
  }
  return `${clean.slice(0, 2)}-${clean.slice(2, 4)}-${clean.slice(4, 7)}`;
}

export default function OnboardingScreen() {
  const { user, organization, member, pairOrganization, completeRegistration } =
    useAuth();
  const toast = useToast();

  const [churchCodeInput, setChurchCodeInput] = useState(
    organization?.churchCode || "",
  );
  const [isVerifyingCode, setIsVerifyingCode] = useState(false);
  const [verifiedOrg, setVerifiedOrg] = useState(organization);

  const [fullName, setFullName] = useState(user?.displayName || "");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [selectedDept, setSelectedDept] = useState("");
  const [isRegistering, setIsRegistering] = useState(false);

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

  useEffect(() => {
    if (verifiedOrg && verifiedOrg.departments.length > 0 && !selectedDept) {
      setSelectedDept(verifiedOrg.departments[0]);
    }
  }, [verifiedOrg, selectedDept]);

  const [permissions, setPermissions] = useState<AppPermissionsStatus | null>(null);

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

  const codeInputRef = React.useRef<TextInput>(null);

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

    // Ensure location permission has been requested before completing setup
    if (!permissions?.locationGranted) {
      const updated = await requestAllAppPermissions(true);
      setPermissions(updated);
    }

    setIsRegistering(true);
    try {
      await completeRegistration(fullName, phoneNumber, selectedDept);
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
                    placeholder="XX-XX-XXX"
                    placeholderTextColor="#94A3B8"
                    value={churchCodeInput}
                    onChangeText={(t) => {
                      const formatted = formatOrgCode(t, churchCodeInput);
                      setChurchCodeInput(formatted);
                    }}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    maxLength={20}
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
                  Standard format: XX-XX-XXX (e.g. CP-88-41A). Auto-inserts
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
    flexGrow: 1,
  },
  header: {
    marginBottom: 24,
  },
  brandIconImage: {
    width: 52,
    height: 52,
    borderRadius: 13,
    marginBottom: 14,
  },
  brandTag: {
    fontSize: 11,
    fontWeight: "700",
    color: "#2563EB",
    letterSpacing: 1,
    marginBottom: 6,
  },
  title: {
    fontSize: 24,
    fontWeight: "800",
    color: "#0F172A",
    letterSpacing: -0.4,
    marginBottom: 6,
  },
  subtitle: {
    fontSize: 13,
    color: "#64748B",
    lineHeight: 18,
  },
  stepContainer: {
    gap: 16,
  },
  fieldGroup: {
    gap: 6,
  },
  label: {
    fontSize: 12,
    fontWeight: "600",
    color: "#334155",
  },
  input: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1.5,
    borderColor: "#CBD5E1",
    borderRadius: 10,
    paddingHorizontal: 15,
    paddingVertical: 13,
    fontSize: 15,
    color: "#0F172A",
  },
  codeInput: {
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 20,
    fontWeight: "700",
    letterSpacing: 2,
    textAlign: "center",
    paddingVertical: 15,
    borderColor: "#93C5FD",
    backgroundColor: "#FFFFFF",
  },
  primaryButton: {
    backgroundColor: "#1D4ED8",
    paddingVertical: 15,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 10,
    shadowColor: "#2563EB",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 3,
  },
  disabledButton: {
    opacity: 0.7,
  },
  primaryButtonText: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: -0.2,
  },
  orgInfoCard: {
    backgroundColor: "#EFF6FF",
    borderWidth: 1.5,
    borderColor: "#BFDBFE",
    borderRadius: 12,
    padding: 16,
  },
  orgNameText: {
    fontSize: 15,
    fontWeight: "700",
    color: "#1E3A8A",
  },
  orgBranchText: {
    fontSize: 12,
    fontWeight: "500",
    color: "#2563EB",
    marginTop: 2,
  },
  orgAnchorText: {
    fontSize: 11,
    color: "#3B82F6",
    marginTop: 6,
    lineHeight: 15,
  },
  deptChipsContainer: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  deptChip: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#CBD5E1",
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  deptChipSelected: {
    backgroundColor: "#0F2042",
    borderColor: "#0F2042",
  },
  deptChipText: {
    fontSize: 13,
    color: "#334155",
    fontWeight: "500",
  },
  deptChipTextSelected: {
    color: "#FFFFFF",
    fontWeight: "600",
  },
  lockNotice: {
    backgroundColor: "#F1F5F9",
    borderRadius: 6,
    padding: 10,
  },
  lockNoticeText: {
    fontSize: 11,
    color: "#64748B",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
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
    backgroundColor: "#EFF6FF",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#BFDBFE",
  },
  pasteButtonText: {
    fontSize: 11,
    fontWeight: "600",
    color: "#2563EB",
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
    color: "#64748B",
    marginTop: 4,
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
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    marginTop: 4,
  },
  permCardGranted: {
    backgroundColor: "#F0FDF4",
    borderColor: "#BBF7D0",
  },
  permCardPending: {
    backgroundColor: "#FFFBEB",
    borderColor: "#FDE68A",
  },
  permIconBadge: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
  },
  permCardTitle: {
    fontSize: 13,
    fontWeight: "700",
  },
  permTitleGranted: {
    color: "#065F46",
  },
  permTitlePending: {
    color: "#92400E",
  },
  permCardSubtitle: {
    fontSize: 11,
    color: "#64748B",
    marginTop: 2,
    lineHeight: 15,
  },
  permGrantBtn: {
    backgroundColor: "#D97706",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  permGrantBtnText: {
    color: "#FFFFFF",
    fontSize: 12,
    fontWeight: "700",
  },
});
