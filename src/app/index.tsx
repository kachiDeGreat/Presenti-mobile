import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  Platform,
  Image,
  RefreshControl,
  AppState,
  Vibration,
  Alert,
  Linking,
} from "react-native";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { LoadingIndicator } from "../components/LoadingIndicator";
import {
  recordAttendance,
  recordSignOut,
  flushPendingAttendanceQueue,
  getTodayPunchRecord,
  saveTodayPunchRecord,
  fetchTodayMemberAttendance,
} from "../services/organizationService";
import {
  evaluateAttendanceWindow,
  format12Hour,
  DAY_NAMES,
  type WindowEvaluationResult,
} from "../utils/timePolicy";
import { verifyPresenceAnchors } from "../services/presenceVerificationService";
import { verifyIdentityForClockIn } from "../services/biometricAuthService";
import type { TodayPunchRecord } from "../types";
import { AdminCalibrationModal } from "../components/AdminCalibrationModal";
import { AdminHub } from "../components/AdminHub";
import { FaceScannerModal } from "../components/FaceScannerModal";

export default function DashboardScreen() {
  const {
    user,
    organization,
    member,
    cachedAnchors,
    deviceId,
    isLoading,
    isAdmin,
    signOut,
    refreshOrganization,
    enrollFace,
  } = useAuth();
  const toast = useToast();

  // Calibration Modal State
  const [showCalibrationModal, setShowCalibrationModal] = useState(false);

  // AI Face Verification Modal State
  const [faceModal, setFaceModal] = useState<{
    visible: boolean;
    mode: "enroll" | "verify";
    action: "clockIn" | "signOut";
  }>({ visible: false, mode: "verify", action: "clockIn" });

  // Real-time clock ticking every second
  const [currentTime, setCurrentTime] = useState(new Date());

  // Today's trapped punch record (local or cloud)
  const [todayPunch, setTodayPunch] = useState<TodayPunchRecord | null>(null);
  const [isSyncingToCloud, setIsSyncingToCloud] = useState(false);
  const [isSyncingSignOut, setIsSyncingSignOut] = useState(false);
  const [hasCheckedToday, setHasCheckedToday] = useState(false);

  // Ticking interval
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Today's date string YYYY-MM-DD
  const todayServiceDate = useMemo(() => {
    return currentTime.toISOString().split("T")[0];
  }, [currentTime]);

  // Evaluate policy window in real-time
  const windowEval: WindowEvaluationResult = useMemo(() => {
    return evaluateAttendanceWindow(
      organization?.policySettings,
      currentTime,
      todayPunch,
    );
  }, [organization?.policySettings, currentTime, todayPunch]);

  // Load existing punch on mount
  useEffect(() => {
    if (!member || !organization) return;

    let isMounted = true;
    const loadTodayRecord = async () => {
      try {
        // 1. Check local storage
        const local = await getTodayPunchRecord(member.id, todayServiceDate);
        if (local && isMounted) {
          setTodayPunch(local);
        }

        // Auto-flush any pending offline punches to cloud before session progresses
        if (organization.id) {
          flushPendingAttendanceQueue(organization.id).catch(() => {});
        }

        // 2. Check cloud firestore if not found or to confirm sync
        const cloudDoc = await fetchTodayMemberAttendance(
          organization.id,
          member.id,
          todayServiceDate,
        );
        if (cloudDoc && isMounted) {
          const cloudRecord: TodayPunchRecord = {
            memberId: member.id,
            punchedAt: cloudDoc.punchedAt || cloudDoc.timestamp,
            displayTime: new Date(
              cloudDoc.punchedAt || cloudDoc.timestamp,
            ).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            }),
            serviceDate: todayServiceDate,
            status: "SYNCED",
            attendanceStatus:
              cloudDoc.status || (local?.attendanceStatus ?? "ON_TIME"),
            verificationMethod: cloudDoc.verificationMethod || "WIFI_BSSID",
            bssidDetected: cloudDoc.bssidDetected,
            attendanceDocId: cloudDoc.id,
            signedOutAt: cloudDoc.signedOutAt,
            signOutDisplayTime: cloudDoc.signOutDisplayTime,
            signOutStatus: cloudDoc.signedOutAt ? "SYNCED" : undefined,
          };
          setTodayPunch(cloudRecord);
          await saveTodayPunchRecord(cloudRecord);
        }
      } catch (err) {
        console.warn("Error loading today attendance record:", err);
      } finally {
        if (isMounted) setHasCheckedToday(true);
      }
    };

    loadTodayRecord();
    return () => {
      isMounted = false;
    };
  }, [member, organization, todayServiceDate]);

  const [refreshing, setRefreshing] = useState(false);

  // Sync fresh organization policy on mount
  useEffect(() => {
    refreshOrganization().catch(() => {});
  }, [refreshOrganization]);

  // Sync when app returns to foreground from background & flush queue
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextAppState) => {
      if (nextAppState === "active") {
        refreshOrganization().catch(() => {});
        if (organization?.id) {
          flushPendingAttendanceQueue(organization.id).catch(() => {});
        }
      }
    });
    return () => subscription.remove();
  }, [refreshOrganization, organization?.id]);

  // Pull-to-refresh handler
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshOrganization();
      if (organization?.id) {
        await flushPendingAttendanceQueue(organization.id);
      }
      if (member && organization) {
        const cloudDoc = await fetchTodayMemberAttendance(
          organization.id,
          member.id,
          todayServiceDate,
        );
        if (cloudDoc) {
          const cloudRecord: TodayPunchRecord = {
            memberId: member.id,
            punchedAt: cloudDoc.punchedAt || cloudDoc.timestamp,
            displayTime: new Date(
              cloudDoc.punchedAt || cloudDoc.timestamp,
            ).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            }),
            serviceDate: todayServiceDate,
            status: "SYNCED",
            attendanceStatus: cloudDoc.status || "ON_TIME",
            verificationMethod: cloudDoc.verificationMethod || "WIFI_BSSID",
            bssidDetected: cloudDoc.bssidDetected,
            attendanceDocId: cloudDoc.id,
            signedOutAt: cloudDoc.signedOutAt,
            signOutDisplayTime: cloudDoc.signOutDisplayTime,
            signOutStatus: cloudDoc.signedOutAt ? "SYNCED" : undefined,
          };
          setTodayPunch(cloudRecord);
          await saveTodayPunchRecord(cloudRecord);
        }
      }
      toast.success("Attendance policy & status synchronized.", {
        duration: 2500,
      });
    } catch (err) {
      console.warn("Pull-to-refresh error:", err);
    } finally {
      setRefreshing(false);
    }
  }, [refreshOrganization, member, organization, todayServiceDate, toast]);

  // Guard routing: redirect unauthenticated or unenrolled users cleanly after mount
  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      router.replace("/login");
    } else if (user.isAdmin || isAdmin) {
      // Administrator stays right here and AdminHub renders!
    } else if (!organization || !member) {
      router.replace("/onboarding");
    }
  }, [isLoading, user, isAdmin, organization, member]);

  if (isLoading || !user) {
    return (
      <LoadingIndicator fullScreen message="Loading attendance dashboard..." />
    );
  }

  // Administrator Experience: Mobile Admin Command Center
  if (user.isAdmin || isAdmin) {
    return <AdminHub />;
  }

  // Workforce Member Experience: Guard enrollment
  if (!organization || !member) {
    return (
      <LoadingIndicator fullScreen message="Loading workforce profile..." />
    );
  }

  // Clock-in execution with presence verification and native device biometrics
  const handleClockIn = async () => {
    // 1. Safety check: prevent double punch if already recorded
    if (todayPunch) {
      toast.info(`Already signed in today at ${todayPunch.displayTime}.`);
      return;
    }

    // 2. Strict Window Enforcement (Reject late / early / off-schedule attempts)
    if (!windowEval.isAllowed) {
      toast.error(
        windowEval.rejectionReason ||
          "Sign-in window is currently closed. Attendance blocked.",
        { title: "Sign-In Restricted", duration: 4500 },
      );
      return;
    }

    // 3. MANDATORY AI FACE VERIFICATION (OPay-style Circular Scanner)
    setFaceModal({
      visible: true,
      mode: member?.isFaceEnrolled && member?.facePhotoURL ? "verify" : "enroll",
      action: "clockIn",
    });
  };

  const verifyDeviceBiometricFallback = async (): Promise<{
    method: "BIOMETRIC" | "DEVICE_PASSCODE";
    biometricType?: string;
  } | null> => {
    const biometricAuth = await verifyIdentityForClockIn();
    if (biometricAuth.success) {
      return {
        method: biometricAuth.method,
        biometricType: biometricAuth.biometricType,
      };
    }

    if (biometricAuth.needsSetup) {
      Alert.alert(
        biometricAuth.errorTitle || "Security Setup Required",
        `${biometricAuth.error}\n\nWhat to do:\n${biometricAuth.instruction}`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Go to Settings",
            style: "default",
            onPress: () => {
              if (Platform.OS === "android") {
                Linking.sendIntent("android.settings.SECURITY_SETTINGS").catch(() => {
                  Linking.openSettings().catch(() => {});
                });
              } else {
                Linking.openSettings().catch(() => {});
              }
            },
          },
        ],
      );
    } else {
      const fullMessage = biometricAuth.instruction
        ? `${biometricAuth.error} ${biometricAuth.instruction}`
        : biometricAuth.error ||
          "Please scan your registered finger or face to confirm.";
      toast.warn(fullMessage, {
        title: biometricAuth.errorTitle || "Biometric Verification Required",
        duration: 6500,
      });
    }
    return null;
  };

  const executeClockInAfterVerification = async (
    biometricAuth: { method: "BIOMETRIC" | "DEVICE_PASSCODE"; biometricType?: string } = {
      method: "BIOMETRIC",
      biometricType: "AI Face Recognition",
    }
  ) => {
    // 4. INSTANT TIME TRAPPING: Lock exact timestamp right at verification completion
    const punchedDate = new Date();
    const punchedAtISO = punchedDate.toISOString();
    const timeDisplay = punchedDate.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    // 4b. Check if Admin has calibrated this account's presence anchors
    const isCalibrated = Boolean(
      organization.isCalibrated ||
      organization.geoFallback?.isCalibrated ||
      (organization.geoFallback?.latitude &&
        organization.geoFallback?.longitude &&
        organization.geoFallback?.latitude !== 0) ||
      (organization.beaconConfig?.targetBssid &&
        organization.beaconConfig.targetBssid.trim().length > 0),
    );

    if (!isCalibrated) {
      setIsSyncingToCloud(false);
      toast.warn(
        "Admin has not calibrated this account. Contact admin to calibrate it.",
        {
          title: "Account Not Calibrated",
          duration: 7000,
        },
      );
      return;
    }

    setIsSyncingToCloud(true);

    const effectiveMode =
      organization.beaconConfig?.verificationMode ||
      cachedAnchors?.verificationMode ||
      (organization.beaconConfig?.targetBssid || cachedAnchors?.targetBssid
        ? "HYBRID"
        : "GEOFENCE_ONLY");

    // Drop down animated toast while checking physical presence anchors
    toast.syncing(
      effectiveMode === "GEOFENCE_ONLY"
        ? `Trapped at ${timeDisplay}. Verifying GPS Satellite Geofence...`
        : `Trapped at ${timeDisplay}. Scanning Wi-Fi & verifying GPS presence...`,
      {
        title: "Verifying Presence",
      },
    );

    // 5. Physical Presence Verification (Wi-Fi Anchor or Geofence fallback)
    const effectiveAnchors = {
      verificationMode: effectiveMode,
      targetBssid:
        organization.beaconConfig?.targetBssid ||
        cachedAnchors?.targetBssid ||
        "",
      ssidHint:
        organization.beaconConfig?.ssidHint || cachedAnchors?.ssidHint || "",
      latitude: Number(
        organization.geoFallback?.latitude ?? cachedAnchors?.latitude ?? 0,
      ),
      longitude: Number(
        organization.geoFallback?.longitude ?? cachedAnchors?.longitude ?? 0,
      ),
      radiusMeters: Number(
        organization.geoFallback?.radiusMeters ??
          cachedAnchors?.radiusMeters ??
          30,
      ),
    };

    let presence;
    try {
      presence = await verifyPresenceAnchors(effectiveAnchors);
    } catch (presenceErr: any) {
      console.warn("Presence check error:", presenceErr);
      presence = {
        isVerified: false,
        method: "GEO_FALLBACK" as const,
        failureReason:
          presenceErr?.message || "Failed to verify presence on device.",
        details: "Verification error",
      };
    }

    // If neither Wi-Fi anchor nor GPS geofence confirmed worker is on premises
    if (!presence.isVerified) {
      toast.error(
        presence.failureReason ||
          "Physical presence verification failed. You must be on-premise to clock in.",
        { title: "Not On-Premise", duration: 6000 },
      );
      setIsSyncingToCloud(false);
      return;
    }

    // 6. Confirmed on-premise! Set local state with trapped time & verified biometric method
    const initialRecord: TodayPunchRecord = {
      memberId: member.id,
      punchedAt: punchedAtISO,
      displayTime: timeDisplay,
      serviceDate: todayServiceDate,
      status: "SYNCING",
      attendanceStatus: windowEval.attendanceStatus,
      verificationMethod: presence.method,
      bssidDetected: presence.bssidDetected,
      biometricVerification: {
        verified: true,
        method: biometricAuth.method,
        biometricType: biometricAuth.biometricType,
      },
    };

    setTodayPunch(initialRecord);
    await saveTodayPunchRecord(initialRecord);

    toast.syncing(
      `Biometrics verified & on-premise confirmed (${presence.method === "GEO_FALLBACK" ? "GPS Geofence" : "Wi-Fi Anchor"})! Syncing to dashboard...`,
      {
        title: "Syncing to Cloud",
      },
    );

    // 7. Asynchronous Cloud Persistence
    try {
      const docId = await recordAttendance(organization.id, {
        memberId: member.id,
        memberName: member.fullName,
        department: member.department,
        serviceDate: todayServiceDate,
        timestamp: punchedAtISO,
        punchedAt: punchedAtISO,
        syncedAt: new Date().toISOString(),
        verificationMethod: presence.method,
        status: windowEval.attendanceStatus,
        deviceId,
        biometricVerification: {
          verified: true,
          method: biometricAuth.method,
          biometricType: biometricAuth.biometricType,
        },
        ...(presence.bssidDetected
          ? { bssidDetected: presence.bssidDetected }
          : {}),
        ...(presence.coordinates &&
        typeof presence.coordinates.latitude === "number" &&
        !isNaN(presence.coordinates.latitude) &&
        typeof presence.coordinates.longitude === "number" &&
        !isNaN(presence.coordinates.longitude)
          ? {
              coordinatesDetected: {
                latitude: presence.coordinates.latitude,
                longitude: presence.coordinates.longitude,
                ...(typeof presence.coordinates.accuracy === "number" &&
                !isNaN(presence.coordinates.accuracy)
                  ? { accuracy: presence.coordinates.accuracy }
                  : {}),
              },
            }
          : {}),
      });

      const syncedRecord: TodayPunchRecord = {
        ...initialRecord,
        status: "SYNCED",
        attendanceDocId: docId,
      };
      setTodayPunch(syncedRecord);
      await saveTodayPunchRecord(syncedRecord);

      const statusTag =
        windowEval.attendanceStatus === "LATE"
          ? " (Marked Late)"
          : " (On Time)";
      toast.success(
        `Biometric & on-premise confirmed! Attendance synced at ${timeDisplay}${statusTag}.`,
        {
          title:
            windowEval.attendanceStatus === "LATE"
              ? "Late Check-In Confirmed"
              : "Check-In Confirmed",
          duration: 4500,
        },
      );
    } catch (err: any) {
      console.warn("Cloud sync error, kept in local queue:", err);
      const offlineRecord: TodayPunchRecord = {
        ...initialRecord,
        status: "OFFLINE_CACHED",
      };
      setTodayPunch(offlineRecord);
      await saveTodayPunchRecord(offlineRecord);

      toast.warn(
        `Biometric verified & trapped at ${timeDisplay}. Will sync to dashboard once connection is stable.`,
        { title: "Punch Trapped Locally", duration: 4500 },
      );
    } finally {
      setIsSyncingToCloud(false);
    }
  };

  // Sign-out execution with biometric check
  const handleSignOut = async () => {
    if (!todayPunch) {
      toast.error("You must sign in for today first before signing out.", {
        title: "Sign-In Required",
      });
      return;
    }

    if (todayPunch.signedOutAt) {
      toast.info(
        `Already signed out today at ${todayPunch.signOutDisplayTime || "earlier"}.`,
      );
      return;
    }

    if (!windowEval.canSignOut) {
      toast.warn(
        `Sign-out opens at ${windowEval.signOutTimeFormatted || "the scheduled departure time"}. You cannot sign out yet.`,
        { title: "Sign-Out Not Open", duration: 4500 },
      );
      return;
    }

    // MANDATORY AI FACE VERIFICATION (OPay-style Circular Scanner)
    setFaceModal({
      visible: true,
      mode: member?.isFaceEnrolled && member?.facePhotoURL ? "verify" : "enroll",
      action: "signOut",
    });
  };

  const executeSignOutAfterVerification = async () => {
    if (!todayPunch) return;
    // INSTANT TIME TRAPPING
    const signDate = new Date();
    const signOutAtISO = signDate.toISOString();
    const signOutTimeDisplay = signDate.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    setIsSyncingSignOut(true);

    const updatedPunch: TodayPunchRecord = {
      ...todayPunch,
      signedOutAt: signOutAtISO,
      signOutDisplayTime: signOutTimeDisplay,
      signOutStatus: "SYNCING",
    };

    setTodayPunch(updatedPunch);
    await saveTodayPunchRecord(updatedPunch);

    try {
      await recordSignOut(
        organization.id,
        member.id,
        todayServiceDate,
        {
          signedOutAt: signOutAtISO,
          signOutDisplayTime: signOutTimeDisplay,
        },
        todayPunch.attendanceDocId,
      );

      const finalRecord: TodayPunchRecord = {
        ...updatedPunch,
        signOutStatus: "SYNCED",
      };
      setTodayPunch(finalRecord);
      await saveTodayPunchRecord(finalRecord);

      toast.success(
        `Sign-out confirmed at ${signOutTimeDisplay}. Have a great rest of your day!`,
        {
          title: "Signed Out Successfully",
          duration: 4000,
        },
      );
    } catch (err) {
      console.warn("Could not sync sign-out immediately, stored locally:", err);
      const offlineRecord: TodayPunchRecord = {
        ...updatedPunch,
        signOutStatus: "OFFLINE_CACHED",
      };
      setTodayPunch(offlineRecord);
      await saveTodayPunchRecord(offlineRecord);

      toast.warn(
        `Sign-out recorded at ${signOutTimeDisplay}. Will sync to cloud once connection is stable.`,
        { title: "Sign-Out Trapped Locally", duration: 4500 },
      );
    } finally {
      setIsSyncingSignOut(false);
    }
  };

  const avatarUrl = member.facePhotoURL || member.photoURL || user.photoURL;

  // Format digital clock time strings
  const hoursString = currentTime.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const dateString = currentTime.toLocaleDateString([], {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            colors={["#2563EB"]}
            tintColor="#2563EB"
          />
        }
      >
        {/* Modern Header Bar */}
        <View style={styles.topBar}>
          <TouchableOpacity
            style={styles.brandRow}
            activeOpacity={0.85}
            delayLongPress={3000}
            onLongPress={() => {
              Vibration.vibrate([0, 100, 60, 100]);
              toast.info("Entering Administrator Calibration Mode...");
              router.push("/calibrate" as any);
            }}
          >
            <Image
              source={require("../image/app-icon.png")}
              style={styles.brandLogo}
              resizeMode="contain"
            />
            <View style={{ flex: 1, gap: 2 }}>
              <View style={styles.brandBadgeRow}>
                <View style={styles.livePulseDot} />
                <Text style={styles.brandTag}>WORKFORCE PRESENCE</Text>
                <TouchableOpacity
                  onPress={async () => {
                    if (organization.churchCode) {
                      await Clipboard.setStringAsync(organization.churchCode);
                      toast.success("Organization code copied!");
                    }
                  }}
                  style={styles.orgCodePill}
                  activeOpacity={0.7}
                >
                  <Text style={styles.orgCodeText}>{organization.churchCode || "ORG"}</Text>
                  <Ionicons name="copy-outline" size={10} color="#142748" />
                </TouchableOpacity>
              </View>
              <Text style={styles.orgName} numberOfLines={1}>
                {organization.churchName}
              </Text>
            </View>
          </TouchableOpacity>

          <View style={styles.topBarRight}>
            {avatarUrl ? (
              <Image source={{ uri: avatarUrl }} style={styles.topAvatar} />
            ) : (
              <View style={styles.topAvatarFallback}>
                <Text style={styles.topAvatarLetter}>
                  {(member.fullName?.[0] || "W").toUpperCase()}
                </Text>
              </View>
            )}
          </View>
        </View>

        {/* Worker Profile Quick Card */}
        <View style={styles.profileChipCard}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.profileName} numberOfLines={1}>
              {member.fullName}
            </Text>
            <Text style={styles.profileDept} numberOfLines={1}>
              {member.department || "General Workforce"} • Bound Device
            </Text>
          </View>

          <View style={styles.biometricBadge}>
            <Ionicons name="finger-print" size={12} color="#10b981" />
            <Text style={styles.biometricBadgeText}>Device Biometrics</Text>
          </View>
        </View>

        {/* Hero Digital Shift Clock Card (ArtCraft Brutalist Surface) */}
        <View style={styles.clockSurface}>
          <Text style={styles.clockDateText}>{dateString}</Text>
          <Text style={styles.clockTimeText}>{hoursString}</Text>

          <View style={styles.shiftBadgeRow}>
            <View
              style={[
                styles.statusBadge,
                windowEval.badgeType === "active" && styles.badgeActive,
                windowEval.badgeType === "warning" && styles.badgeWarning,
                windowEval.badgeType === "error" && styles.badgeError,
                windowEval.badgeType === "neutral" && styles.badgeNeutral,
              ]}
            >
              <View
                style={[
                  styles.badgeDot,
                  windowEval.badgeType === "active" && styles.dotActive,
                  windowEval.badgeType === "warning" && styles.dotWarning,
                  windowEval.badgeType === "error" && styles.dotError,
                  windowEval.badgeType === "neutral" && styles.dotNeutral,
                ]}
              />
              <Text
                style={[
                  styles.badgeText,
                  windowEval.badgeType === "active" && styles.textActive,
                  windowEval.badgeType === "warning" && styles.textWarning,
                  windowEval.badgeType === "error" && styles.textError,
                  windowEval.badgeType === "neutral" && styles.textNeutral,
                ]}
              >
                {windowEval.badgeLabel}
              </Text>
            </View>

            {windowEval.openTimeFormatted &&
              windowEval.openTimeFormatted !== "--" && (
                <Text style={styles.shiftHoursText}>
                  {windowEval.openTimeFormatted} – {windowEval.closeTimeFormatted}
                </Text>
              )}
          </View>
        </View>

        {/* Primary Action / Attendance Status Section (Bolt / InDrive Style) */}
        {todayPunch ? (
          /* STATE A: SIGNED IN TODAY */
          <View style={styles.punchedCard}>
            <View style={styles.punchedHeaderRow}>
              <View
                style={[
                  styles.checkCircle,
                  todayPunch.attendanceStatus === "LATE" && styles.checkCircleLate,
                ]}
              >
                <Ionicons
                  name={todayPunch.attendanceStatus === "LATE" ? "alert" : "checkmark"}
                  size={20}
                  color="#ffffff"
                />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.punchedTitle}>
                  {todayPunch.attendanceStatus === "LATE"
                    ? "Signed In (Late)"
                    : "Verified On-Site"}
                </Text>
                <Text style={styles.punchedSubtitle}>
                  Arrival trapped at {todayPunch.displayTime}
                </Text>
              </View>
              <View
                style={[
                  styles.pillGeneric,
                  todayPunch.attendanceStatus === "LATE" ? styles.pillLate : styles.pillOnTime,
                ]}
              >
                <Text
                  style={[
                    styles.pillTextGeneric,
                    todayPunch.attendanceStatus === "LATE"
                      ? styles.pillTextLate
                      : styles.pillTextOnTime,
                  ]}
                >
                  {todayPunch.attendanceStatus === "LATE" ? "LATE" : "ON TIME"}
                </Text>
              </View>
            </View>

            <View style={styles.punchedMetaRow}>
              <View style={styles.metaItem}>
                <Ionicons
                  name={
                    todayPunch.verificationMethod === "GEO_FALLBACK"
                      ? "navigate"
                      : "wifi"
                  }
                  size={14}
                  color="#2d81ff"
                />
                <Text style={styles.metaText}>
                  {todayPunch.verificationMethod === "GEO_FALLBACK"
                    ? "GPS Satellite Geofence"
                    : "Office Wi-Fi Anchor"}
                </Text>
              </View>

              <View style={styles.metaItem}>
                <Ionicons
                  name={todayPunch.status === "SYNCED" ? "cloud-done" : "cloud-upload"}
                  size={14}
                  color={todayPunch.status === "SYNCED" ? "#10b981" : "#142748"}
                />
                <Text style={styles.metaText}>
                  {todayPunch.status === "SYNCED" ? "Cloud Synced" : "Syncing..."}
                </Text>
              </View>
            </View>

            {/* Departure / Sign-Out Action */}
            {windowEval.enableSignOut && (
              <View style={styles.signOutBox}>
                {todayPunch.signedOutAt ? (
                  <View style={styles.signOutCompletedRow}>
                    <Ionicons name="log-out" size={16} color="#10b981" />
                    <Text style={styles.signOutCompletedText}>
                      Signed out at {todayPunch.signOutDisplayTime}
                    </Text>
                  </View>
                ) : windowEval.canSignOut ? (
                  <TouchableOpacity
                    style={styles.signOutActionBtn}
                    onPress={handleSignOut}
                    disabled={isSyncingSignOut}
                    activeOpacity={0.85}
                  >
                    {isSyncingSignOut ? (
                      <ActivityIndicator size="small" color="#f2f1ee" />
                    ) : (
                      <>
                        <Ionicons name="log-out-outline" size={18} color="#f2f1ee" />
                        <Text style={styles.signOutActionText}>CLOCK OUT / END SHIFT</Text>
                      </>
                    )}
                  </TouchableOpacity>
                ) : (
                  <View style={styles.signOutWaitingRow}>
                    <Ionicons name="time-outline" size={14} color="#64748b" />
                    <Text style={styles.signOutWaitingText}>
                      Sign-out opens at {windowEval.signOutTimeFormatted}
                    </Text>
                  </View>
                )}
              </View>
            )}
          </View>
        ) : !windowEval.isAllowed ? (
          /* STATE B: ATTENDANCE WINDOW CLOSED */
          <View style={styles.blockedCard}>
            <Ionicons name="lock-closed-outline" size={32} color="#d92d20" />
            <Text style={styles.blockedTitle}>
              {windowEval.status === "PAST_WINDOW"
                ? "Sign-In Window Closed"
                : windowEval.status === "BEFORE_WINDOW"
                  ? "Sign-In Not Started"
                  : "No Scheduled Session"}
            </Text>
            <Text style={styles.blockedSubtitle}>
              {windowEval.rejectionReason || "Attendance is not available outside policy hours."}
            </Text>
          </View>
        ) : (
          /* STATE C: WINDOW OPEN - TAP TO CLOCK IN (Bolt Style Hero Action) */
          <TouchableOpacity
            style={[
              styles.primaryPunchBtn,
              windowEval.status === "WINDOW_OPEN_LATE" && styles.punchBtnLate,
              isSyncingToCloud && styles.punchBtnDisabled,
            ]}
            onPress={handleClockIn}
            disabled={isSyncingToCloud}
            activeOpacity={0.88}
          >
            {isSyncingToCloud ? (
              <View style={styles.punchBtnLoadingRow}>
                <ActivityIndicator size="small" color="#f2f1ee" />
                <Text style={styles.punchBtnTitle}>VERIFYING ON-PREMISE...</Text>
              </View>
            ) : (
              <>
                <View style={styles.punchIconCircle}>
                  <Ionicons name="finger-print" size={24} color="#f2f1ee" />
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.punchBtnTitle}>
                    {windowEval.status === "WINDOW_OPEN_LATE"
                      ? "CLOCK IN FOR SHIFT (LATE)"
                      : "CLOCK IN FOR SHIFT"}
                  </Text>
                  <Text style={styles.punchBtnSubtitle}>
                    Facial Biometrics & Hardware Isolation
                  </Text>
                </View>
                <Ionicons name="arrow-forward" size={18} color="rgba(242, 241, 238, 0.7)" />
              </>
            )}
          </TouchableOpacity>
        )}

        {/* Quick Info Grid (ArtCraft Brutalist Tiles) */}
        <View style={styles.gridRow}>
          <View style={styles.gridTile}>
            <View style={styles.gridIconWrap}>
              <Ionicons name="compass-outline" size={18} color="#142748" />
            </View>
            <Text style={styles.gridTitle}>Premises Anchor</Text>
            <Text style={styles.gridDesc}>
              {organization.geoFallback?.radiusMeters || 20}m Geofence Perimeter
            </Text>
          </View>

          <View style={styles.gridTile}>
            <View style={styles.gridIconWrap}>
              <Ionicons name="shield-checkmark-outline" size={18} color="#10b981" />
            </View>
            <Text style={styles.gridTitle}>Security Isolation</Text>
            <Text style={styles.gridDesc}>Bound to Smartphone Hardware</Text>
          </View>
        </View>

        {/* Minimal Sign Out Footer */}
        <View style={styles.bottomFooter}>
          <TouchableOpacity
            style={styles.minimalSignOut}
            onPress={async () => {
              Alert.alert("Sign Out", "Sign out of your workforce session?", [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Sign Out",
                  style: "destructive",
                  onPress: async () => {
                    await signOut();
                    toast.info("Signed out of workforce session.");
                    router.replace("/login");
                  },
                },
              ]);
            }}
            activeOpacity={0.7}
          >
            <Ionicons name="log-out-outline" size={16} color="#64748b" />
            <Text style={styles.minimalSignOutText}>Sign Out ({member.fullName})</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      {/* Admin QR & Premises Hardware Calibration Modal */}
      <AdminCalibrationModal
        visible={showCalibrationModal}
        onClose={() => setShowCalibrationModal(false)}
        onSuccess={() => {
          refreshOrganization();
        }}
      />

      {/* OPay-style AI Face Enrollment & Verification Scanner */}
      <FaceScannerModal
        visible={faceModal.visible}
        mode={faceModal.mode}
        referencePhotoUrl={member?.facePhotoURL}
        onCancel={() => setFaceModal((prev) => ({ ...prev, visible: false }))}
        onSuccess={async (capturedDataUri) => {
          const currentAction = faceModal.action;
          const currentMode = faceModal.mode;
          setFaceModal((prev) => ({ ...prev, visible: false }));

          if (currentMode === "enroll") {
            try {
              await enrollFace([1], capturedDataUri);
              toast.success("Face biometric profile enrolled!");
            } catch (err: any) {
              toast.warn("Face captured, continuing verification...");
            }
          }

          if (currentAction === "clockIn") {
            await executeClockInAfterVerification();
          } else {
            await executeSignOutAfterVerification();
          }
        }}
        onFallbackBiometric={async () => {
          const currentAction = faceModal.action;
          setFaceModal((prev) => ({ ...prev, visible: false }));
          const fallbackAuth = await verifyDeviceBiometricFallback();
          if (!fallbackAuth) return;
          if (currentAction === "clockIn") {
            await executeClockInAfterVerification(fallbackAuth);
          } else {
            await executeSignOutAfterVerification();
          }
        }}
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
    paddingHorizontal: 18,
    paddingTop: 12,
    paddingBottom: 40,
    gap: 14,
    maxWidth: 540,
    width: "100%",
    alignSelf: "center",
  },

  // 1. Top Bar / App Branding
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 4,
  },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flex: 1,
    marginRight: 10,
  },
  brandLogo: {
    height: 38,
    width: 38,
    borderRadius: 0,
  },
  brandBadgeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  livePulseDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#10b981",
  },
  brandTag: {
    fontSize: 9,
    fontWeight: "800",
    color: "#142748",
    letterSpacing: 0.8,
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
  },
  orgCodePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e5e7eb",
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  orgCodeText: {
    fontSize: 9,
    fontWeight: "700",
    color: "#142748",
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
  },
  orgName: {
    fontSize: 15,
    fontWeight: "800",
    color: "#142748",
    letterSpacing: -0.3,
  },
  topBarRight: {
    flexDirection: "row",
    alignItems: "center",
  },
  topAvatar: {
    width: 38,
    height: 38,
    borderRadius: 0,
    borderWidth: 1.5,
    borderColor: "#142748",
  },
  topAvatarFallback: {
    width: 38,
    height: 38,
    borderRadius: 0,
    backgroundColor: "#142748",
    alignItems: "center",
    justifyContent: "center",
  },
  topAvatarLetter: {
    color: "#f2f1ee",
    fontSize: 14,
    fontWeight: "800",
  },

  // 2. Profile Quick Chip Card
  profileChipCard: {
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e5e7eb",
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  profileName: {
    fontSize: 14,
    fontWeight: "800",
    color: "#142748",
  },
  profileDept: {
    fontSize: 11,
    color: "#64748b",
  },
  biometricBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "#ecfdf5",
    borderWidth: 1,
    borderColor: "#a7f3d0",
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  biometricBadgeText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#10b981",
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
  },

  // 3. Hero Clock & Shift Surface (Material Brutalist Surface)
  clockSurface: {
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e5e7eb",
    paddingVertical: 20,
    paddingHorizontal: 16,
    alignItems: "center",
  },
  clockDateText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#64748b",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
  },
  clockTimeText: {
    fontSize: 42,
    fontWeight: "800",
    color: "#142748",
    letterSpacing: -1,
    marginVertical: 4,
    fontVariant: ["tabular-nums"],
  },
  shiftBadgeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 4,
  },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderWidth: 1,
  },
  badgeActive: {
    backgroundColor: "#ecfdf5",
    borderColor: "#a7f3d0",
  },
  badgeWarning: {
    backgroundColor: "#fffbeb",
    borderColor: "#fde68a",
  },
  badgeError: {
    backgroundColor: "#fef2f2",
    borderColor: "#fecaca",
  },
  badgeNeutral: {
    backgroundColor: "#f1f5f9",
    borderColor: "#e2e8f0",
  },
  badgeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  dotActive: {
    backgroundColor: "#10b981",
  },
  dotWarning: {
    backgroundColor: "#f59e0b",
  },
  dotError: {
    backgroundColor: "#d92d20",
  },
  dotNeutral: {
    backgroundColor: "#64748b",
  },
  badgeText: {
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.4,
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
  },
  textActive: {
    color: "#10b981",
  },
  textWarning: {
    color: "#f59e0b",
  },
  textError: {
    color: "#d92d20",
  },
  textNeutral: {
    color: "#64748b",
  },
  shiftHoursText: {
    fontSize: 11,
    fontWeight: "600",
    color: "#64748b",
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
  },

  // 4. Primary Punch Button (Bolt Style Hero Action)
  primaryPunchBtn: {
    backgroundColor: "#142748",
    borderWidth: 1,
    borderColor: "#142748",
    paddingVertical: 18,
    paddingHorizontal: 18,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  punchBtnLate: {
    backgroundColor: "#d97706",
    borderColor: "#b45309",
  },
  punchBtnDisabled: {
    opacity: 0.7,
  },
  punchBtnLoadingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    width: "100%",
  },
  punchIconCircle: {
    width: 44,
    height: 44,
    backgroundColor: "rgba(255, 255, 255, 0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  punchBtnTitle: {
    fontSize: 13,
    fontWeight: "800",
    color: "#f2f1ee",
    letterSpacing: 0.6,
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
  },
  punchBtnSubtitle: {
    fontSize: 11,
    color: "rgba(242, 241, 238, 0.8)",
    fontWeight: "500",
  },

  // 5. Signed-In Status Card
  punchedCard: {
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e5e7eb",
    padding: 16,
    gap: 12,
  },
  punchedHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  checkCircle: {
    width: 38,
    height: 38,
    backgroundColor: "#10b981",
    alignItems: "center",
    justifyContent: "center",
  },
  checkCircleLate: {
    backgroundColor: "#f59e0b",
  },
  punchedTitle: {
    fontSize: 14,
    fontWeight: "800",
    color: "#142748",
  },
  punchedSubtitle: {
    fontSize: 11,
    color: "#64748b",
  },
  pillGeneric: {
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  pillOnTime: {
    backgroundColor: "#ecfdf5",
    borderWidth: 1,
    borderColor: "#a7f3d0",
  },
  pillLate: {
    backgroundColor: "#fffbeb",
    borderWidth: 1,
    borderColor: "#fde68a",
  },
  pillTextGeneric: {
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 0.6,
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
  },
  pillTextOnTime: {
    color: "#10b981",
  },
  pillTextLate: {
    color: "#d97706",
  },
  punchedMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#f8fafc",
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: "#f1f5f9",
  },
  metaItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  metaText: {
    fontSize: 11,
    color: "#475569",
    fontWeight: "600",
  },

  // Sign Out Controls
  signOutBox: {
    marginTop: 2,
  },
  signOutCompletedRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#ecfdf5",
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: "#a7f3d0",
  },
  signOutCompletedText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#10b981",
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
  },
  signOutActionBtn: {
    backgroundColor: "#ffffff",
    borderWidth: 1.5,
    borderColor: "#142748",
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  signOutActionText: {
    fontSize: 11,
    fontWeight: "800",
    color: "#142748",
    letterSpacing: 0.8,
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
  },
  signOutWaitingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 8,
  },
  signOutWaitingText: {
    fontSize: 11,
    color: "#64748b",
    fontWeight: "500",
  },

  // 6. Blocked Window Card
  blockedCard: {
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#fca5a5",
    padding: 22,
    alignItems: "center",
    gap: 8,
  },
  blockedTitle: {
    fontSize: 15,
    fontWeight: "800",
    color: "#d92d20",
    marginTop: 4,
  },
  blockedSubtitle: {
    fontSize: 12,
    color: "#64748b",
    textAlign: "center",
    lineHeight: 18,
  },

  // 7. Minimal Info Grid
  gridRow: {
    flexDirection: "row",
    gap: 10,
  },
  gridTile: {
    flex: 1,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e5e7eb",
    padding: 14,
    gap: 4,
  },
  gridIconWrap: {
    width: 32,
    height: 32,
    backgroundColor: "#f2f1ee",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  gridTitle: {
    fontSize: 11,
    fontWeight: "800",
    color: "#142748",
    letterSpacing: 0.4,
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
  },
  gridDesc: {
    fontSize: 11,
    color: "#64748b",
  },

  // 8. Footer
  bottomFooter: {
    alignItems: "center",
    paddingTop: 8,
  },
  minimalSignOut: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  minimalSignOutText: {
    fontSize: 11,
    color: "#64748b",
    fontWeight: "700",
    letterSpacing: 0.4,
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
  },
});
