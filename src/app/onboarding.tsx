import React, { useState, useEffect, useRef } from "react";
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
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import {
  getAppPermissionsStatus,
  requestAllAppPermissions,
  AppPermissionsStatus,
} from "../services/permissionService";
import {
  checkIfUserIsAdmin,
  saveFaceToLocalVault,
  loadFaceFromLocalVault,
} from "../services/organizationService";
import { FaceScannerModal } from "../components/FaceScannerModal";
import { C, MONO, R, S, T, shadow, ui } from "../constants/premium";

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
    authStepLabel,
    pairOrganization,
    completeRegistration,
    signOut,
  } = useAuth();
  const toast = useToast();

  const [churchCodeInput, setChurchCodeInput] = useState("");
  const [isVerifyingCode, setIsVerifyingCode] = useState(false);
  const [verifiedOrg, setVerifiedOrg] = useState<any>(null);

  const [fullName, setFullName] = useState(user?.displayName || "");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [selectedDept, setSelectedDept] = useState("");
  const [selectedShiftId, setSelectedShiftId] = useState("");
  const [capturedFaceUri, setCapturedFaceUri] = useState<string | null>(null);
  const [showFaceEnrollModal, setShowFaceEnrollModal] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false);
  const [permissions, setPermissions] = useState<AppPermissionsStatus | null>(null);
  const codeInputRef = React.useRef<TextInput>(null);
  const draftLoadedRef = React.useRef(false);
  const draftKey = user?.uid ? `@presenti_onboarding_draft_${user.uid}` : null;

  // Restore saved onboarding draft (paired org, typed fields & face) if user closed/minimized app
  useEffect(() => {
    if (!draftKey || draftLoadedRef.current) return;
    let active = true;
    AsyncStorage.getItem(draftKey)
      .then((raw) => {
        if (!active) return;
        draftLoadedRef.current = true;
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            if (parsed.churchCodeInput) setChurchCodeInput(parsed.churchCodeInput);
            if (parsed.verifiedOrg) setVerifiedOrg(parsed.verifiedOrg);
            if (parsed.fullName) setFullName(parsed.fullName);
            if (parsed.phoneNumber) setPhoneNumber(parsed.phoneNumber);
            if (parsed.selectedDept) setSelectedDept(parsed.selectedDept);
            if (parsed.capturedFaceUri) setCapturedFaceUri(parsed.capturedFaceUri);
            return;
          } catch {}
        }
        // Fallback: if org was already paired in AuthContext, resume directly at Step 2
        if (organization && !member) {
          setVerifiedOrg(organization);
          if (organization.churchCode) setChurchCodeInput(organization.churchCode);
        }
        if (user?.email) {
          loadFaceFromLocalVault(user.email, member?.id)
            .then((vault) => {
              if (active && vault?.facePhotoURL) {
                setCapturedFaceUri((prev) => prev || vault.facePhotoURL);
              }
            })
            .catch(() => {});
        }
      })
      .catch(() => {
        draftLoadedRef.current = true;
      });
    return () => {
      active = false;
    };
  }, [draftKey, organization, member]);

  // Persist onboarding progress on every change so minimizing/closing never loses work
  useEffect(() => {
    if (!draftKey || !draftLoadedRef.current) return;
    const payload = {
      churchCodeInput,
      verifiedOrg,
      fullName,
      phoneNumber,
      selectedDept,
      capturedFaceUri,
    };
    AsyncStorage.setItem(draftKey, JSON.stringify(payload)).catch(() => {});
  }, [
    draftKey,
    churchCodeInput,
    verifiedOrg,
    fullName,
    phoneNumber,
    selectedDept,
    capturedFaceUri,
  ]);

  const hasNavigatedRef = useRef(false);

  // Administrators are strictly blocked from workforce onboarding on mobile
  useEffect(() => {
    if (hasNavigatedRef.current) return;
    if (isAdmin || user?.isAdmin) {
      hasNavigatedRef.current = true;
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
        if (isAdm && !hasNavigatedRef.current) {
          hasNavigatedRef.current = true;
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
    if (hasNavigatedRef.current) return;
    if (user && organization && member) {
      hasNavigatedRef.current = true;
      router.replace("/");
    }
  }, [user, organization, member]);

  // If not authenticated with Google, send back to login
  useEffect(() => {
    if (hasNavigatedRef.current) return;
    if (!user) {
      hasNavigatedRef.current = true;
      router.replace("/login");
    }
  }, [user]);

  // Auto-select first department & shift when org is verified
  useEffect(() => {
    if (verifiedOrg && verifiedOrg.departments.length > 0 && !selectedDept) {
      setSelectedDept(verifiedOrg.departments[0]);
    }
    const shifts = verifiedOrg?.policySettings?.shifts;
    if (
      verifiedOrg?.policySettings?.scheduleMode === "MULTI_SHIFT" &&
      Array.isArray(shifts) &&
      shifts.length > 0 &&
      !selectedShiftId
    ) {
      const firstEnabled = shifts.find((s: any) => s.enabled !== false) || shifts[0];
      setSelectedShiftId(firstEnabled.id);
    }
  }, [verifiedOrg, selectedDept, selectedShiftId]);

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

    if (!capturedFaceUri) {
      toast.warn("Please scan your face to complete your biometric profile.");
      setShowFaceEnrollModal(true);
      return;
    }

    // Ensure location permission has been requested before completing setup
    if (!permissions?.locationGranted) {
      const updated = await requestAllAppPermissions(true);
      setPermissions(updated);
    }

    setIsRegistering(true);
    try {
      const activeShifts = verifiedOrg?.policySettings?.shifts || [];
      const chosenShift = activeShifts.find((s: any) => s.id === selectedShiftId);
      await completeRegistration(
        fullName,
        phoneNumber,
        selectedDept,
        [1],
        capturedFaceUri,
        chosenShift?.id,
        chosenShift?.name
      );
      if (draftKey) {
        AsyncStorage.removeItem(draftKey).catch(() => {});
      }
      toast.success(
        "Welcome to " + (verifiedOrg?.churchName || "the organization") + "!",
      );
      if (!hasNavigatedRef.current) {
        hasNavigatedRef.current = true;
        router.replace("/");
      }
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
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView
          contentContainerStyle={[styles.scrollContent, { paddingBottom: 36 }]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          automaticallyAdjustKeyboardInsets
          showsVerticalScrollIndicator={false}
        >
          {/* Header */}
          <View style={styles.header}>
            <Image
              source={require("../image/app-icon.png")}
              style={styles.brandIconImage}
              resizeMode="contain"
            />
            <View style={styles.stepProgressRow}>
              <View style={[styles.stepSegment, styles.stepSegmentActive]} />
              <View style={[styles.stepSegment, verifiedOrg && styles.stepSegmentActive]} />
            </View>
            <Text style={styles.brandTag}>
              STEP {verifiedOrg ? "2 OF 2" : "1 OF 2"}
            </Text>
            <Text style={styles.title}>
              {verifiedOrg ? "Department Enrollment" : "Organization Pairing"}
            </Text>
            <Text style={styles.subtitle}>
              {verifiedOrg
                ? `Link your profile to ${verifiedOrg.churchName}.`
                : "Enter your organization pairing code to continue."}
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
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <Text style={styles.orgNameText}>{verifiedOrg.churchName}</Text>
                  <TouchableOpacity
                    onPress={() => {
                      setVerifiedOrg(null);
                      setChurchCodeInput("");
                    }}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: "700", color: "#2563EB" }}>Change</Text>
                  </TouchableOpacity>
                </View>
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
                  {verifiedOrg.departments.map((dept: string) => {
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

              {/* Assigned Shift Selector (if organization runs Morning/Afternoon/Night shifts) */}
              {verifiedOrg?.policySettings?.scheduleMode === "MULTI_SHIFT" &&
                Array.isArray(verifiedOrg?.policySettings?.shifts) &&
                verifiedOrg.policySettings.shifts.length > 0 && (
                  <View style={styles.fieldGroup}>
                    <Text style={styles.label}>Assigned Shift *</Text>
                    <View style={styles.deptChipsContainer}>
                      {verifiedOrg.policySettings.shifts
                        .filter((s: any) => s.enabled !== false)
                        .map((sh: any) => {
                          const isSelected = selectedShiftId === sh.id;
                          return (
                            <TouchableOpacity
                              key={sh.id}
                              style={[
                                styles.deptChip,
                                isSelected && styles.deptChipSelected,
                              ]}
                              onPress={() => setSelectedShiftId(sh.id)}
                              activeOpacity={0.7}
                            >
                              <Text
                                style={[
                                  styles.deptChipText,
                                  isSelected && styles.deptChipTextSelected,
                                ]}
                              >
                                {sh.name} ({sh.arrivalCutoff}–{sh.signOutTime})
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                    </View>
                  </View>
                )}

              {/* Mandatory AI Biometric Face Registration */}
              <View style={styles.fieldGroup}>
                <View style={styles.labelRow}>
                  <Text style={styles.label}>Face Biometrics *</Text>
                  <View style={styles.requiredBadge}>
                    <Text style={styles.requiredBadgeText}>REQUIRED</Text>
                  </View>
                </View>

                {!capturedFaceUri ? (
                  <View style={styles.faceEnrollCard}>
                    <View style={styles.faceEnrollHeader}>
                      <View style={styles.faceIconBox}>
                        <Ionicons name="scan-circle" size={26} color="#2d81ff" />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.faceEnrollTitle}>Register Face Profile</Text>
                        <Text style={styles.faceEnrollSub}>
                          Take a selfie to register your official biometric profile. Presenti AI will match your face against this whenever you clock in.
                        </Text>
                      </View>
                    </View>
                    <TouchableOpacity
                      style={styles.scanFaceBtn}
                      onPress={() => setShowFaceEnrollModal(true)}
                      activeOpacity={0.85}
                    >
                      <Ionicons name="camera" size={16} color="#ffffff" />
                      <Text style={styles.scanFaceBtnText}>SCAN & ENROLL FACE</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <View style={[styles.faceEnrollCard, styles.faceEnrollCardSuccess]}>
                    <View style={styles.faceEnrollHeader}>
                      <Image source={{ uri: capturedFaceUri }} style={styles.faceThumb} />
                      <View style={{ flex: 1 }}>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                          <Ionicons name="checkmark-circle" size={17} color="#10b981" />
                          <Text style={styles.faceSuccessTitle}>Face Biometrics Enrolled</Text>
                        </View>
                        <Text style={styles.faceSuccessSub}>
                          Official biometric reference photo enrolled & validated by AI for daily presence verification.
                        </Text>
                      </View>
                    </View>
                    <TouchableOpacity
                      style={styles.retakeBtn}
                      onPress={() => setShowFaceEnrollModal(true)}
                      activeOpacity={0.8}
                    >
                      <Ionicons name="refresh" size={13} color="#2d81ff" />
                      <Text style={styles.retakeBtnText}>RETAKE PHOTO</Text>
                    </TouchableOpacity>
                  </View>
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
                    <Text style={styles.primaryButtonText} numberOfLines={1}>
                      {authStepLabel || "Setting up profile..."}
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

      {/* OPay-Style Face Biometric Enrollment Modal */}
      <FaceScannerModal
        visible={showFaceEnrollModal}
        mode="enroll"
        onCancel={() => setShowFaceEnrollModal(false)}
        onSuccess={(dataUri) => {
          setCapturedFaceUri(dataUri);
          setShowFaceEnrollModal(false);
          saveFaceToLocalVault({
            facePhotoURL: dataUri,
            email: user?.email,
            orgId: verifiedOrg?.id || organization?.id,
          }).catch(() => {});
          toast.success("Face biometric profile saved on device & validated!");
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: C.canvas,
  },
  scrollContent: {
    paddingHorizontal: S.screenX,
    paddingVertical: S.lg,
    flexGrow: 1,
    maxWidth: 520,
    width: "100%",
    alignSelf: "center",
  },
  header: {
    marginBottom: S.lg,
  },
  brandIconImage: {
    width: 52,
    height: 52,
    borderRadius: R.md,
    marginBottom: S.md,
  },
  stepProgressRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 10,
  },
  stepSegment: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    backgroundColor: C.line,
  },
  stepSegmentActive: {
    backgroundColor: C.accent,
  },
  brandTag: {
    ...T.labelSm,
    color: C.accent,
    marginBottom: 6,
  },
  title: {
    ...T.display,
    fontSize: 24,
    marginBottom: 4,
  },
  subtitle: {
    ...T.body,
    fontSize: 13.5,
    lineHeight: 19,
    color: C.ink2,
  },
  stepContainer: {
    gap: S.lg,
  },
  fieldGroup: {
    gap: 8,
  },
  label: {
    ...T.label,
    color: C.ink,
  },
  input: {
    ...ui.input,
  },
  codeInput: {
    ...ui.input,
    height: 60,
    fontFamily: MONO,
    fontSize: 22,
    fontWeight: "800",
    letterSpacing: 3,
    textAlign: "center",
    borderColor: "rgba(20, 39, 72, 0.25)",
  },
  primaryButton: {
    ...ui.btnPrimary,
    marginTop: 10,
    ...shadow.raised,
  },
  disabledButton: {
    opacity: 0.65,
  },
  primaryButtonText: {
    ...ui.btnPrimaryText,
  },
  orgInfoCard: {
    ...ui.card,
    gap: 4,
  },
  orgNameText: {
    ...T.heading,
  },
  orgBranchText: {
    ...T.caption,
  },
  orgAnchorText: {
    ...T.labelSm,
    color: C.accent,
    marginTop: 6,
    lineHeight: 16,
  },
  deptChipsContainer: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  deptChip: {
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.lineCard,
    borderRadius: R.pill,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  deptChipSelected: {
    backgroundColor: C.ink,
    borderColor: C.ink,
  },
  deptChipText: {
    fontSize: 13,
    color: C.ink,
    fontWeight: "600",
  },
  deptChipTextSelected: {
    color: C.white,
    fontWeight: "700",
  },
  lockNotice: {
    ...ui.cardFlat,
    padding: 12,
  },
  lockNoticeText: {
    ...T.labelSm,
    color: C.ink2,
  },
  labelRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 2,
  },
  pasteButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: C.card,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: R.pill,
    borderWidth: 1,
    borderColor: C.lineCard,
  },
  pasteButtonText: {
    ...T.labelSm,
    color: C.ink,
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
    ...T.caption,
    fontSize: 12,
    marginTop: 2,
  },
  buttonLoaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  permCard: {
    ...ui.card,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginTop: 2,
  },
  permCardGranted: {
    borderWidth: 1,
    borderColor: C.successSoft,
  },
  permCardPending: {},
  permIconBadge: {
    ...ui.iconBubble,
    backgroundColor: C.cardAlt,
  },
  permCardTitle: {
    ...T.label,
    color: C.ink,
  },
  permTitleGranted: {
    color: C.success,
  },
  permTitlePending: {
    color: C.ink,
  },
  permCardSubtitle: {
    ...T.caption,
    fontSize: 12,
    marginTop: 2,
  },
  permGrantBtn: {
    backgroundColor: C.ink,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: R.pill,
  },
  permGrantBtnText: {
    ...T.labelSm,
    color: C.white,
  },
  requiredBadge: {
    backgroundColor: C.dangerSoft,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: R.pill,
  },
  requiredBadgeText: {
    ...T.labelSm,
    fontSize: 9,
    color: C.danger,
  },
  faceEnrollCard: {
    ...ui.card,
    gap: 14,
  },
  faceEnrollCardSuccess: {
    borderWidth: 1.5,
    borderColor: C.success,
  },
  faceEnrollHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  faceIconBox: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: C.accentSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  faceEnrollTitle: {
    ...T.heading,
    fontSize: 15,
  },
  faceEnrollSub: {
    ...T.caption,
    fontSize: 12,
    marginTop: 2,
  },
  scanFaceBtn: {
    ...ui.btnPrimary,
    height: 50,
    backgroundColor: C.accent,
  },
  scanFaceBtnText: {
    ...ui.btnPrimaryText,
    fontSize: 12,
  },
  faceThumb: {
    width: 50,
    height: 50,
    borderRadius: 25,
    borderWidth: 2,
    borderColor: C.success,
  },
  faceSuccessTitle: {
    ...T.heading,
    fontSize: 15,
    color: C.success,
  },
  faceSuccessSub: {
    ...T.caption,
    fontSize: 12,
    marginTop: 2,
  },
  retakeBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: R.sm,
    borderWidth: 1,
    borderColor: C.accentSoft2,
    paddingVertical: 10,
    backgroundColor: C.accentSoft,
  },
  retakeBtnText: {
    ...T.labelSm,
    color: C.accent,
  },
});
