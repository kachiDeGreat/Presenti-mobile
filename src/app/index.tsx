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
import { FaceScanModal } from "../components/FaceScanModal";

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

  // In-App Facial Recognition & Anti-Spoofing Modal State
  const [showFaceModal, setShowFaceModal] = useState(false);
  const [faceScanMode, setFaceScanMode] = useState<"ENROLL" | "VERIFY">("VERIFY");
  const pendingClockInRef = React.useRef<{
    punchedAtISO: string;
    timeDisplay: string;
    presence: any;
  } | null>(null);

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
    return evaluateAttendanceWindow(organization?.policySettings, currentTime, todayPunch);
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
            attendanceStatus: cloudDoc.status || (local?.attendanceStatus ?? "ON_TIME"),
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

  // --- Clock In Execution (Instant Time Trap + Presence Verification + Cloud Sync) ---
  // --- Clock In Execution (Instant Time Trap + Physical Presence + Face Recognition Binding) ---
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

    // 3. INSTANT TIME TRAPPING: Lock exact timestamp right at button press
    const punchedDate = new Date();
    const punchedAtISO = punchedDate.toISOString();
    const timeDisplay = punchedDate.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

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

    // 4. Physical Presence Verification (Wi-Fi Anchor or Geofence fallback)
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

    // 5. Physical Presence Confirmed! Launch In-App Face Recognition & Liveness Verification
    pendingClockInRef.current = {
      punchedAtISO,
      timeDisplay,
      presence,
    };

    setIsSyncingToCloud(false);

    if (!member.isFaceEnrolled || !member.faceEmbedding || member.faceEmbedding.length === 0) {
      // First-time facial binding
      setFaceScanMode("ENROLL");
      setShowFaceModal(true);
    } else {
      // Identity verification against enrolled biometric vector
      setFaceScanMode("VERIFY");
      setShowFaceModal(true);
    }
  };

  const handleFaceScanSuccess = async (result: {
    embedding: number[];
    confidence: number;
    thumbnailBase64?: string;
  }) => {
    setShowFaceModal(false);
    const pending = pendingClockInRef.current;
    if (!pending) return;

    setIsSyncingToCloud(true);

    // If first-time enrollment during clock in, persist to member profile
    if (faceScanMode === "ENROLL") {
      try {
        await enrollFace(result.embedding, result.thumbnailBase64);
        toast.success("Facial identity enrolled and bound to your account!");
      } catch (enrollErr: any) {
        console.warn("Could not save face enrollment to member:", enrollErr);
      }
    }

    const initialRecord: TodayPunchRecord = {
      memberId: member.id,
      punchedAt: pending.punchedAtISO,
      displayTime: pending.timeDisplay,
      serviceDate: todayServiceDate,
      status: "SYNCING",
      attendanceStatus: windowEval.attendanceStatus,
      verificationMethod: pending.presence.method,
      bssidDetected: pending.presence.bssidDetected,
      faceVerification: {
        verified: true,
        confidence: result.confidence,
        method: "IN_APP_FACE_AI",
      },
    };

    setTodayPunch(initialRecord);
    await saveTodayPunchRecord(initialRecord);

    toast.syncing(
      `Face verified & on-premise confirmed (${pending.presence.method === "GEO_FALLBACK" ? "GPS Geofence" : "Wi-Fi Anchor"})! Syncing to dashboard...`,
      {
        title: "Syncing to Cloud",
      },
    );

    // Asynchronous Cloud Persistence
    try {
      const docId = await recordAttendance(organization.id, {
        memberId: member.id,
        memberName: member.fullName,
        department: member.department,
        serviceDate: todayServiceDate,
        timestamp: pending.punchedAtISO,
        punchedAt: pending.punchedAtISO,
        syncedAt: new Date().toISOString(),
        verificationMethod: pending.presence.method,
        status: windowEval.attendanceStatus,
        deviceId,
        faceVerification: {
          verified: true,
          confidence: result.confidence,
          method: "IN_APP_FACE_AI",
        },
        ...(pending.presence.bssidDetected
          ? { bssidDetected: pending.presence.bssidDetected }
          : {}),
        ...(pending.presence.coordinates &&
        typeof pending.presence.coordinates.latitude === "number" &&
        !isNaN(pending.presence.coordinates.latitude) &&
        typeof pending.presence.coordinates.longitude === "number" &&
        !isNaN(pending.presence.coordinates.longitude)
          ? {
              coordinatesDetected: {
                latitude: pending.presence.coordinates.latitude,
                longitude: pending.presence.coordinates.longitude,
                ...(typeof pending.presence.coordinates.accuracy === "number" &&
                !isNaN(pending.presence.coordinates.accuracy)
                  ? { accuracy: pending.presence.coordinates.accuracy }
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

      const statusTag = windowEval.attendanceStatus === "LATE" ? " (Marked Late)" : " (On Time)";
      toast.success(
        `Face verified (${Math.round(result.confidence * 100)}%) & on-premise confirmed! Attendance synced at ${pending.timeDisplay}${statusTag}.`,
        {
          title: windowEval.attendanceStatus === "LATE" ? "Late Check-In Confirmed" : "Check-In Confirmed",
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
        `Face verified & trapped at ${pending.timeDisplay}. Will sync to dashboard once connection is stable.`,
        { title: "Punch Trapped Locally", duration: 4500 },
      );
    } finally {
      setIsSyncingToCloud(false);
      pendingClockInRef.current = null;
    }
  };

  const handleFaceScanFailure = (reason: string) => {
    setShowFaceModal(false);
    pendingClockInRef.current = null;
    setIsSyncingToCloud(false);
    toast.error(
      reason || "Face verification failed. Attendance blocked.",
      { title: "Proxy Check-In Rejected", duration: 6000 }
    );
  };

  const handleFaceScanClose = () => {
    setShowFaceModal(false);
    pendingClockInRef.current = null;
    setIsSyncingToCloud(false);
  };

  // --- Sign Out Execution (Traps Sign-Out Timestamp + Biometric Check + Updates Cloud) ---
  const handleSignOut = async () => {
    if (!todayPunch) {
      toast.error("You must sign in for today first before signing out.", {
        title: "Sign-In Required",
      });
      return;
    }

    if (todayPunch.signedOutAt) {
      toast.info(`Already signed out today at ${todayPunch.signOutDisplayTime || "earlier"}.`);
      return;
    }

    if (!windowEval.canSignOut) {
      toast.warn(
        `Sign-out opens at ${windowEval.signOutTimeFormatted || "the scheduled departure time"}. You cannot sign out yet.`,
        { title: "Sign-Out Not Open", duration: 4500 }
      );
      return;
    }

    // MANDATORY BIOMETRIC VERIFICATION (Anti-Proxy Identity Check)
    const biometricAuth = await verifyIdentityForClockIn();
    if (!biometricAuth.success) {
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
          : (biometricAuth.error || "Please scan your registered finger or face to confirm sign out.");

        toast.warn(fullMessage, {
          title: biometricAuth.errorTitle || "Biometric Verification Required",
          duration: 6500,
        });
      }
      return;
    }

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
        todayPunch.attendanceDocId
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
        }
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
        { title: "Sign-Out Trapped Locally", duration: 4500 }
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
        {/* Top Hero Card (Clean White Executive Style) */}
        <View style={styles.heroCard}>
          <View style={styles.heroTopRow}>
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
                source={require("../image/logo-dark.png")}
                style={styles.heroBrandLogo}
                resizeMode="contain"
              />
            </TouchableOpacity>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <View style={styles.codeBadge}>
                <Text style={styles.codeBadgeText}>
                  {organization.churchCode}
                </Text>
              </View>
            </View>
          </View>

          <View style={styles.orgTagBadge}>
            <Ionicons name="business" size={12} color="#2563EB" />
            <Text style={styles.orgTagText} numberOfLines={1}>
              {organization.churchName.toUpperCase()}
            </Text>
          </View>

          <Text style={styles.branchTitle}>{organization.branchName}</Text>

          {/* Member Profile Identity */}
          <View style={styles.memberCluster}>
            {avatarUrl ? (
              <Image source={{ uri: avatarUrl }} style={styles.avatarImg} />
            ) : (
              <View style={styles.avatarFallback}>
                <Text style={styles.avatarLetter}>
                  {(member.fullName?.[0] || "U").toUpperCase()}
                </Text>
              </View>
            )}

            <View style={styles.memberInfoCol}>
              <Text style={styles.memberName} numberOfLines={1}>
                {member.fullName}
              </Text>
              <View style={styles.deptBadge}>
                <Ionicons name="briefcase-outline" size={12} color="#64748B" />
                <Text style={styles.deptBadgeText}>{member.department}</Text>
              </View>
            </View>

            <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
              <View style={styles.deviceLockBadge}>
                <Ionicons name="lock-closed" size={11} color="#059669" />
                <Text style={styles.deviceLockText}>Device</Text>
              </View>

              <TouchableOpacity
                style={[
                  styles.deviceLockBadge,
                  !member.isFaceEnrolled && { borderColor: "rgba(217, 119, 6, 0.4)", backgroundColor: "#FEF3C7" },
                ]}
                onPress={() => {
                  setFaceScanMode("ENROLL");
                  setShowFaceModal(true);
                }}
                activeOpacity={0.7}
              >
                <Ionicons
                  name={member.isFaceEnrolled ? "scan" : "scan-outline"}
                  size={11}
                  color={member.isFaceEnrolled ? "#059669" : "#D97706"}
                />
                <Text
                  style={[
                    styles.deviceLockText,
                    !member.isFaceEnrolled && { color: "#B45309" },
                  ]}
                >
                  {member.isFaceEnrolled ? "Face Bound" : "Bind Face"}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>

        {/* Live Digital Clock & Window Status Monitor */}
        <View style={styles.clockCard}>
          <View style={styles.clockHeader}>
            <Text style={styles.clockDateLabel}>{dateString}</Text>
            <View
              style={[
                styles.windowStatusPill,
                windowEval.badgeType === "active" && styles.statusActive,
                windowEval.badgeType === "warning" && styles.statusWarning,
                windowEval.badgeType === "error" && styles.statusError,
                windowEval.badgeType === "neutral" && styles.statusNeutral,
              ]}
            >
              <View
                style={[
                  styles.statusDot,
                  windowEval.badgeType === "active" && styles.dotActive,
                  windowEval.badgeType === "warning" && styles.dotWarning,
                  windowEval.badgeType === "error" && styles.dotError,
                  windowEval.badgeType === "neutral" && styles.dotNeutral,
                ]}
              />
              <Text
                style={[
                  styles.windowStatusText,
                  windowEval.badgeType === "active" && styles.textActive,
                  windowEval.badgeType === "warning" && styles.textWarning,
                  windowEval.badgeType === "error" && styles.textError,
                  windowEval.badgeType === "neutral" && styles.textNeutral,
                ]}
              >
                {windowEval.badgeLabel}
              </Text>
            </View>
          </View>

          {/* Big Monospace Clock */}
          <Text style={styles.digitalClockTime}>{hoursString}</Text>

          {/* Window Information Subtitle */}
          <View style={styles.policyRow}>
            <Ionicons
              name={
                windowEval.badgeType === "active"
                  ? "time-outline"
                  : windowEval.badgeType === "error"
                    ? "alert-circle-outline"
                    : "hourglass-outline"
              }
              size={14}
              color={
                windowEval.badgeType === "active"
                  ? "#059669"
                  : windowEval.badgeType === "error"
                    ? "#DC2626"
                    : "#D97706"
              }
            />
            <Text style={styles.policySummaryText}>
              {windowEval.openTimeFormatted && windowEval.closeTimeFormatted && windowEval.openTimeFormatted !== "--"
                ? `Window: ${windowEval.openTimeFormatted} - ${windowEval.closeTimeFormatted} • ${windowEval.summary}`
                : windowEval.summary}
            </Text>
          </View>
        </View>

        {/* Primary Action / Attendance Status & Sign-Out Section */}
        <View style={styles.actionSection}>
          {todayPunch ? (
            /* --- STATE: ALREADY SIGNED IN TODAY --- */
            <View style={{ gap: 12 }}>
              <View
                style={[
                  styles.signedInCard,
                  todayPunch.attendanceStatus === "LATE" && styles.signedInCardLate,
                ]}
              >
                <View style={styles.signedInTopRow}>
                  <View
                    style={[
                      styles.checkCircle,
                      todayPunch.attendanceStatus === "LATE" && styles.checkCircleLate,
                    ]}
                  >
                    <Ionicons
                      name={
                        todayPunch.attendanceStatus === "LATE"
                          ? "alert-circle"
                          : "checkmark-sharp"
                      }
                      size={24}
                      color="#FFFFFF"
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text
                      style={[
                        styles.signedInHeading,
                        todayPunch.attendanceStatus === "LATE" && styles.signedInHeadingLate,
                      ]}
                    >
                      {todayPunch.attendanceStatus === "LATE"
                        ? "Signed In (Late)"
                        : "Signed In For Today"}
                    </Text>
                    <Text
                      style={[
                        styles.signedInSubheading,
                        todayPunch.attendanceStatus === "LATE" && styles.signedInSubheadingLate,
                      ]}
                    >
                      Arrival trapped at {todayPunch.displayTime}
                    </Text>
                  </View>
                  <View
                    style={
                      todayPunch.attendanceStatus === "LATE"
                        ? styles.latePill
                        : styles.onTimePill
                    }
                  >
                    <Text
                      style={
                        todayPunch.attendanceStatus === "LATE"
                          ? styles.latePillText
                          : styles.onTimePillText
                      }
                    >
                      {todayPunch.attendanceStatus === "LATE" ? "LATE" : "ON TIME"}
                    </Text>
                  </View>
                </View>

                <View
                  style={[
                    styles.signedInDivider,
                    todayPunch.attendanceStatus === "LATE" && styles.signedInDividerLate,
                  ]}
                />

                <View style={styles.syncStatusRow}>
                  {todayPunch.status === "SYNCING" || isSyncingToCloud ? (
                    <View style={styles.syncRowContent}>
                      <ActivityIndicator size="small" color="#2563EB" />
                      <Text style={styles.syncStatusLabel}>
                        Syncing to admin dashboard...
                      </Text>
                    </View>
                  ) : todayPunch.status === "SYNCED" ? (
                    <View style={styles.syncRowContent}>
                      <Ionicons name="cloud-done" size={16} color="#059669" />
                      <Text style={styles.syncDoneLabel}>
                        Verified & synced with admin cloud
                      </Text>
                    </View>
                  ) : (
                    <View style={styles.syncRowContent}>
                      <Ionicons name="cloud-offline" size={16} color="#D97706" />
                      <Text style={styles.syncOfflineLabel}>
                        Cached locally • Will sync automatically
                      </Text>
                    </View>
                  )}
                </View>

                <View
                  style={[
                    styles.anchorDetailRow,
                    todayPunch.attendanceStatus === "LATE" && styles.anchorDetailRowLate,
                  ]}
                >
                  <Ionicons
                    name={
                      todayPunch.verificationMethod === "GEO_FALLBACK"
                        ? "navigate-circle"
                        : "wifi"
                    }
                    size={15}
                    color={todayPunch.attendanceStatus === "LATE" ? "#B45309" : "#059669"}
                  />
                  <Text
                    style={[
                      styles.anchorDetailText,
                      todayPunch.attendanceStatus === "LATE" && styles.anchorDetailTextLate,
                    ]}
                  >
                    {todayPunch.verificationMethod === "GEO_FALLBACK"
                      ? "Verified via GPS Geofence Perimeter"
                      : `Verified via Wi-Fi Anchor (${cachedAnchors?.targetBssid || "Premises Router"})`}
                  </Text>
                </View>
              </View>

              {/* Sign-Out Feature (If enabled by Organization Policy for today) */}
              {windowEval.enableSignOut && (
                <View style={styles.signOutWrapper}>
                  {todayPunch.signedOutAt ? (
                    /* STATE: ALREADY SIGNED OUT */
                    <View style={styles.signedOutDoneCard}>
                      <View style={styles.signedOutDoneTopRow}>
                        <View style={styles.signedOutDoneIcon}>
                          <Ionicons name="log-out" size={18} color="#FFFFFF" />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.signedOutDoneTitle}>
                            Signed Out For Today
                          </Text>
                          <Text style={styles.signedOutDoneSub}>
                            Departure logged at {todayPunch.signOutDisplayTime}
                          </Text>
                        </View>
                        <View style={styles.signedOutPill}>
                          <Text style={styles.signedOutPillText}>COMPLETED</Text>
                        </View>
                      </View>

                      <View style={styles.syncStatusRow}>
                        {todayPunch.signOutStatus === "SYNCING" || isSyncingSignOut ? (
                          <View style={styles.syncRowContent}>
                            <ActivityIndicator size="small" color="#2563EB" />
                            <Text style={styles.syncStatusLabel}>
                              Syncing departure to cloud...
                            </Text>
                          </View>
                        ) : todayPunch.signOutStatus === "SYNCED" ? (
                          <View style={styles.syncRowContent}>
                            <Ionicons name="cloud-done" size={15} color="#059669" />
                            <Text style={styles.syncDoneLabel}>
                              Departure verified & synced with admin cloud
                            </Text>
                          </View>
                        ) : (
                          <View style={styles.syncRowContent}>
                            <Ionicons name="cloud-offline" size={15} color="#D97706" />
                            <Text style={styles.syncOfflineLabel}>
                              Cached locally • Will sync automatically
                            </Text>
                          </View>
                        )}
                      </View>
                    </View>
                  ) : windowEval.canSignOut ? (
                    /* STATE: READY TO SIGN OUT (After Departure Time) */
                    <TouchableOpacity
                      style={[
                        styles.signOutActionButton,
                        isSyncingSignOut && styles.buttonDisabled,
                      ]}
                      onPress={handleSignOut}
                      disabled={isSyncingSignOut}
                      activeOpacity={0.85}
                    >
                      <View style={styles.buttonInnerRow}>
                        <View style={styles.signOutIconCircle}>
                          {isSyncingSignOut ? (
                            <ActivityIndicator size="small" color="#FFFFFF" />
                          ) : (
                            <Ionicons name="log-out-outline" size={24} color="#FFFFFF" />
                          )}
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.signOutActionTitle}>
                            {isSyncingSignOut
                              ? "Verifying Presence & Syncing..."
                              : "Tap to Sign Out"}
                          </Text>
                          <Text style={styles.signOutActionSubtitle}>
                            {isSyncingSignOut
                              ? "Scanning biometric & recording departure"
                              : `Departure open (started ${windowEval.signOutTimeFormatted})`}
                          </Text>
                        </View>
                        {!isSyncingSignOut && (
                          <Ionicons name="arrow-forward" size={20} color="#CBD5E1" />
                        )}
                      </View>
                    </TouchableOpacity>
                  ) : (
                    /* STATE: SIGN-OUT LOCKED (Before Departure Time) */
                    <View style={styles.signOutLockedCard}>
                      <Ionicons name="time-outline" size={18} color="#64748B" />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.signOutLockedTitle}>
                          Sign-Out Opens at {windowEval.signOutTimeFormatted || "Departure Time"}
                        </Text>
                        <Text style={styles.signOutLockedSubtitle}>
                          Sign-out has no closing cutoff. You can sign out any time after {windowEval.signOutTimeFormatted || "this time"}.
                        </Text>
                      </View>
                    </View>
                  )}
                </View>
              )}
            </View>
          ) : !windowEval.isAllowed ? (
            /* --- STATE: WINDOW CLOSED / BLOCKED (LATE OR NOT SESSION DAY) --- */
            <View style={styles.blockedCard}>
              <View style={styles.blockedIconContainer}>
                <Ionicons
                  name={
                    windowEval.status === "PAST_WINDOW" ? "lock-closed" : "time"
                  }
                  size={28}
                  color="#DC2626"
                />
              </View>
              <Text style={styles.blockedTitle}>
                {windowEval.status === "PAST_WINDOW"
                  ? "Sign-In Window Closed"
                  : windowEval.status === "BEFORE_WINDOW"
                    ? "Sign-In Not Started Yet"
                    : "No Session Scheduled"}
              </Text>
              <Text style={styles.blockedReason}>
                {windowEval.rejectionReason ||
                  "Attendance cannot be logged outside configured policy."}
              </Text>

              <TouchableOpacity
                style={styles.disabledActionButton}
                onPress={() => {
                  toast.error(
                    windowEval.rejectionReason ||
                      "Sign-in window is currently closed.",
                    { title: "Sign-In Blocked" },
                  );
                }}
                activeOpacity={0.8}
              >
                <Text style={styles.disabledActionButtonText}>
                  {windowEval.status === "PAST_WINDOW"
                    ? "Attendance Closed (Late)"
                    : windowEval.status === "BEFORE_WINDOW"
                      ? `Opens at ${windowEval.openTimeFormatted}`
                      : "Check-In Locked"}
                </Text>
              </TouchableOpacity>
            </View>
          ) : windowEval.status === "WINDOW_OPEN_LATE" ? (
            /* --- STATE: LATE SIGN-IN WINDOW OPEN (WITH LATE TAG) --- */
            <TouchableOpacity
              style={[
                styles.clockInPrimaryButton,
                styles.clockInLateButton,
                isSyncingToCloud && styles.buttonDisabled,
              ]}
              onPress={handleClockIn}
              disabled={isSyncingToCloud}
              activeOpacity={0.85}
            >
              <View style={styles.buttonInnerRow}>
                <View style={[styles.fingerprintCircle, styles.fingerprintCircleLate]}>
                  {isSyncingToCloud ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : (
                    <Ionicons name="alert-circle" size={26} color="#FFFFFF" />
                  )}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.clockInPrimaryTitle}>
                    {isSyncingToCloud
                      ? "Verifying Presence & Syncing..."
                      : "Tap to Clock In (Late)"}
                  </Text>
                  <Text style={[styles.clockInPrimarySubtitle, styles.clockInSubtitleLate]}>
                    {isSyncingToCloud
                      ? "Scanning Wi-Fi anchor & GPS geofence"
                      : `Closed at ${windowEval.closeTimeFormatted} • Stamped with LATE tag`}
                  </Text>
                </View>
                {!isSyncingToCloud && (
                  <Ionicons name="arrow-forward" size={20} color="#FED7AA" />
                )}
              </View>
            </TouchableOpacity>
          ) : (
            /* --- STATE: WINDOW OPEN (ON-TIME CLOCK IN) --- */
            <TouchableOpacity
              style={[
                styles.clockInPrimaryButton,
                isSyncingToCloud && styles.buttonDisabled,
              ]}
              onPress={handleClockIn}
              disabled={isSyncingToCloud}
              activeOpacity={0.85}
            >
              <View style={styles.buttonInnerRow}>
                <View style={styles.fingerprintCircle}>
                  {isSyncingToCloud ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : (
                    <Ionicons name="finger-print" size={26} color="#FFFFFF" />
                  )}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.clockInPrimaryTitle}>
                    {isSyncingToCloud
                      ? "Verifying Presence & Syncing..."
                      : "Tap to Clock In"}
                  </Text>
                  <Text style={styles.clockInPrimarySubtitle}>
                    {isSyncingToCloud
                      ? "Scanning Wi-Fi anchor & GPS geofence"
                      : "Traps your arrival timestamp instantly"}
                  </Text>
                </View>
                {!isSyncingToCloud && (
                  <Ionicons name="arrow-forward" size={20} color="#BFDBFE" />
                )}
              </View>
            </TouchableOpacity>
          )}
        </View>

        {/* Hardware Presence Anchors Card */}
        {/* <View style={styles.anchorsCard}>
          <View style={styles.anchorsHeaderRow}>
            <View style={styles.anchorsIconBadge}>
              <Ionicons name="radio" size={15} color="#2563EB" />
            </View>
            <Text style={styles.anchorsTitle}>ON-PREMISE PRESENCE ANCHORS</Text>
          </View>

          <View style={styles.anchorItem}>
            <View style={styles.anchorItemLeft}>
              <Ionicons name="wifi" size={16} color="#64748B" />
              <Text style={styles.anchorItemLabel}>Target Wi-Fi Anchor</Text>
            </View>
            <View style={styles.anchorItemValueRow}>
              <View style={styles.anchorDot} />
              <Text style={styles.anchorItemValue}>
                {cachedAnchors?.ssidHint || 'Configured Wi-Fi'}
              </Text>
            </View>
          </View>

          <View style={styles.anchorItem}>
            <View style={styles.anchorItemLeft}>
              <Ionicons name="navigate-outline" size={16} color="#64748B" />
              <Text style={styles.anchorItemLabel}>Perimeter Calibrated</Text>
            </View>
            <Text style={styles.anchorItemValue}>
              {cachedAnchors?.radiusMeters || 10}m Geofence
            </Text>
          </View>

          <View style={styles.anchorItem}>
            <View style={styles.anchorItemLeft}>
              <Ionicons name="hardware-chip-outline" size={16} color="#64748B" />
              <Text style={styles.anchorItemLabel}>Bound Hardware</Text>
            </View>
            <Text style={styles.anchorHardwareCode}>
              {deviceId ? `ID • ${deviceId.slice(-8).toUpperCase()}` : 'Registered Device'}
            </Text>
          </View>
        </View> */}

        {/* Footer / Account Management */}
        <View style={styles.footerSection}>
          <Text style={styles.footerSyncNotice}>
            Organization: {organization.churchName} ({organization.churchCode})
          </Text>
          <TouchableOpacity
            style={styles.signOutButton}
            onPress={async () => {
              await signOut();
              toast.info("Signed out of workforce session.");
              router.replace("/login");
            }}
            activeOpacity={0.7}
          >
            <Ionicons name="log-out-outline" size={15} color="#EF4444" />
            <Text style={styles.signOutText}>Sign Out</Text>
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

      {/* In-App Facial Recognition & Anti-Spoofing Modal */}
      <FaceScanModal
        visible={showFaceModal}
        mode={faceScanMode}
        memberName={member?.fullName || "Workforce Member"}
        enrolledEmbedding={member?.faceEmbedding}
        onSuccess={handleFaceScanSuccess}
        onFailure={handleFaceScanFailure}
        onClose={handleFaceScanClose}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#F8FAFC",
  },
  scrollContent: {
    padding: 16,
    gap: 14,
    flexGrow: 1,
    maxWidth: 540,
    width: "100%",
    alignSelf: "center",
  },

  // Hero Card
  heroCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    padding: 18,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.04,
        shadowRadius: 3,
      },
      android: {
        elevation: 1,
      },
    }),
  },
  heroTopRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  heroBrandLogo: {
    height: 26,
    width: 100,
  },
  orgTagBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#EFF6FF",
    borderWidth: 1,
    borderColor: "#BFDBFE",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    alignSelf: "flex-start",
    marginBottom: 8,
  },
  orgTagText: {
    color: "#2563EB",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  codeBadge: {
    backgroundColor: "#F1F5F9",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#E2E8F0",
  },
  codeBadgeText: {
    color: "#0F172A",
    fontSize: 11,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontWeight: "700",
  },
  branchTitle: {
    color: "#0F172A",
    fontSize: 18,
    fontWeight: "800",
    letterSpacing: -0.3,
    marginBottom: 14,
    lineHeight: 24,
  },
  memberCluster: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#F8FAFC",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    padding: 12,
    gap: 12,
  },
  avatarImg: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: "#E2E8F0",
  },
  avatarFallback: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#EFF6FF",
    borderWidth: 1,
    borderColor: "#BFDBFE",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarLetter: {
    color: "#2563EB",
    fontSize: 16,
    fontWeight: "800",
  },
  memberInfoCol: {
    flex: 1,
    gap: 3,
  },
  memberName: {
    color: "#0F172A",
    fontSize: 14,
    fontWeight: "700",
  },
  deptBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-start",
  },
  deptBadgeText: {
    color: "#64748B",
    fontSize: 11,
    fontWeight: "500",
  },
  deviceLockBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#ECFDF5",
    borderWidth: 1,
    borderColor: "#A7F3D0",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  deviceLockText: {
    color: "#059669",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.3,
  },

  // Live Digital Clock Card
  clockCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    padding: 18,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    gap: 8,
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.04,
        shadowRadius: 3,
      },
      android: {
        elevation: 1,
      },
    }),
  },
  clockHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  clockDateLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: "#64748B",
    letterSpacing: 0.4,
  },
  windowStatusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    backgroundColor: "#F8FAFC",
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  windowStatusText: {
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.4,
  },
  statusActive: {
    borderColor: "#A7F3D0",
    backgroundColor: "#ECFDF5",
  },
  dotActive: {
    backgroundColor: "#059669",
  },
  textActive: {
    color: "#059669",
  },
  statusWarning: {
    borderColor: "#FDE68A",
    backgroundColor: "#FFFBEB",
  },
  dotWarning: {
    backgroundColor: "#D97706",
  },
  textWarning: {
    color: "#D97706",
  },
  statusError: {
    borderColor: "#FECACA",
    backgroundColor: "#FEF2F2",
  },
  dotError: {
    backgroundColor: "#DC2626",
  },
  textError: {
    color: "#DC2626",
  },
  statusNeutral: {
    borderColor: "#E2E8F0",
    backgroundColor: "#F1F5F9",
  },
  dotNeutral: {
    backgroundColor: "#64748B",
  },
  textNeutral: {
    color: "#64748B",
  },
  digitalClockTime: {
    fontSize: 34,
    fontWeight: "800",
    color: "#0F172A",
    letterSpacing: -0.5,
    marginVertical: 4,
  },
  policyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#F8FAFC",
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#E2E8F0",
  },
  policySummaryText: {
    fontSize: 11,
    color: "#475569",
    fontWeight: "500",
    flex: 1,
    lineHeight: 16,
  },

  // Action Section
  actionSection: {
    marginTop: 2,
  },
  clockInPrimaryButton: {
    backgroundColor: "#2563EB",
    borderRadius: 14,
    minHeight: 56,
    padding: 16,
    justifyContent: "center",
    ...Platform.select({
      ios: {
        shadowColor: "#2563EB",
        shadowOffset: { width: 0, height: 3 },
        shadowOpacity: 0.25,
        shadowRadius: 5,
      },
      android: {
        elevation: 3,
      },
    }),
  },
  buttonInnerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  fingerprintCircle: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    alignItems: "center",
    justifyContent: "center",
  },
  clockInPrimaryTitle: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "800",
  },
  clockInPrimarySubtitle: {
    color: "rgba(255, 255, 255, 0.8)",
    fontSize: 11,
    fontWeight: "500",
    marginTop: 2,
  },
  clockInLateButton: {
    backgroundColor: "#D97706",
  },
  fingerprintCircleLate: {
    backgroundColor: "rgba(255, 255, 255, 0.25)",
  },
  clockInSubtitleLate: {
    color: "rgba(255, 255, 255, 0.9)",
  },
  buttonDisabled: {
    opacity: 0.65,
  },

  // Signed In Confirmation Card
  signedInCard: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 16,
    padding: 16,
    gap: 12,
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.04,
        shadowRadius: 3,
      },
      android: {
        elevation: 1,
      },
    }),
  },
  signedInCardLate: {
    borderColor: "#FDE68A",
  },
  signedInTopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  checkCircle: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "#059669",
    alignItems: "center",
    justifyContent: "center",
  },
  checkCircleLate: {
    backgroundColor: "#D97706",
  },
  signedInHeading: {
    fontSize: 14,
    fontWeight: "800",
    color: "#0F172A",
  },
  signedInHeadingLate: {
    color: "#B45309",
  },
  signedInSubheading: {
    fontSize: 12,
    fontWeight: "500",
    color: "#64748B",
    marginTop: 2,
  },
  signedInSubheadingLate: {
    color: "#64748B",
  },
  onTimePill: {
    backgroundColor: "#ECFDF5",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  onTimePillText: {
    color: "#059669",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.4,
  },
  latePill: {
    backgroundColor: "#FFFBEB",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  latePillText: {
    color: "#D97706",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.4,
  },
  signedInDivider: {
    height: 1,
    backgroundColor: "#F1F5F9",
  },
  signedInDividerLate: {
    backgroundColor: "#F1F5F9",
  },
  syncStatusRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  syncRowContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  syncStatusLabel: {
    fontSize: 11,
    color: "#2563EB",
    fontWeight: "600",
  },
  syncDoneLabel: {
    fontSize: 11,
    color: "#059669",
    fontWeight: "600",
  },
  syncOfflineLabel: {
    fontSize: 11,
    color: "#D97706",
    fontWeight: "600",
  },
  anchorDetailRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#F8FAFC",
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
  },
  anchorDetailRowLate: {
    backgroundColor: "#F8FAFC",
  },
  anchorDetailText: {
    fontSize: 11,
    fontWeight: "600",
    color: "#475569",
  },
  anchorDetailTextLate: {
    color: "#475569",
  },

  // Sign-Out UI Elements
  signOutWrapper: {
    marginTop: 4,
  },
  signOutActionButton: {
    backgroundColor: "#0F172A",
    borderRadius: 14,
    minHeight: 54,
    padding: 16,
    justifyContent: "center",
  },
  signOutIconCircle: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "rgba(255, 255, 255, 0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  signOutActionTitle: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "800",
  },
  signOutActionSubtitle: {
    color: "rgba(255, 255, 255, 0.75)",
    fontSize: 11,
    fontWeight: "400",
    marginTop: 2,
  },
  signOutLockedCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 14,
    padding: 14,
  },
  signOutLockedTitle: {
    fontSize: 12,
    fontWeight: "700",
    color: "#0F172A",
  },
  signOutLockedSubtitle: {
    fontSize: 11,
    color: "#64748B",
    marginTop: 2,
    lineHeight: 16,
  },
  signedOutDoneCard: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 16,
    padding: 14,
    gap: 10,
  },
  signedOutDoneTopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  signedOutDoneIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "#059669",
    alignItems: "center",
    justifyContent: "center",
  },
  signedOutDoneTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#0F172A",
  },
  signedOutDoneSub: {
    fontSize: 11,
    fontWeight: "400",
    color: "#64748B",
    marginTop: 1,
  },
  signedOutPill: {
    backgroundColor: "#ECFDF5",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  signedOutPillText: {
    color: "#059669",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.4,
  },

  // Blocked Card (Late / Closed)
  blockedCard: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 16,
    padding: 20,
    alignItems: "center",
    gap: 8,
  },
  blockedIconContainer: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "#FEF2F2",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  blockedTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: "#0F172A",
    letterSpacing: -0.3,
  },
  blockedReason: {
    fontSize: 12,
    color: "#64748B",
    textAlign: "center",
    lineHeight: 18,
  },
  disabledActionButton: {
    backgroundColor: "#F1F5F9",
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 12,
    marginTop: 8,
    width: "100%",
    alignItems: "center",
  },
  disabledActionButtonText: {
    color: "#64748B",
    fontSize: 12,
    fontWeight: "700",
  },

  // Anchors Card
  anchorsCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    gap: 10,
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.04,
        shadowRadius: 3,
      },
      android: {
        elevation: 1,
      },
    }),
  },
  anchorsHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 4,
  },
  anchorsIconBadge: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: "#EFF6FF",
    alignItems: "center",
    justifyContent: "center",
  },
  anchorsTitle: {
    fontSize: 11,
    fontWeight: "800",
    color: "#0F172A",
    letterSpacing: 0.4,
  },
  anchorItem: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 4,
  },
  anchorItemLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  anchorItemLabel: {
    fontSize: 12,
    color: "#64748B",
  },
  anchorItemValueRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  anchorDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#059669",
  },
  anchorItemValue: {
    fontSize: 12,
    fontWeight: "700",
    color: "#0F172A",
  },
  anchorHardwareCode: {
    fontSize: 11,
    fontWeight: "700",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    color: "#0F172A",
  },

  // Footer Section
  footerSection: {
    alignItems: "center",
    paddingVertical: 16,
    gap: 12,
    marginTop: 4,
  },
  footerSyncNotice: {
    fontSize: 11,
    color: "#94A3B8",
    fontWeight: "500",
  },
  signOutButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 16,
    backgroundColor: "#FEE2E2",
    borderRadius: 10,
  },
  signOutText: {
    fontSize: 11,
    color: "#DC2626",
    fontWeight: "700",
  },
});
