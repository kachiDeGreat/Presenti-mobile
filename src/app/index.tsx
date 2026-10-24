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
  const [faceScanMode, setFaceScanMode] = useState<"ENROLL" | "VERIFY">(
    "VERIFY",
  );
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

    // 3b. Check if Admin has calibrated this account's presence anchors
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

    if (
      !member.isFaceEnrolled ||
      !member.faceEmbedding ||
      member.faceEmbedding.length === 0
    ) {
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

      const statusTag =
        windowEval.attendanceStatus === "LATE"
          ? " (Marked Late)"
          : " (On Time)";
      toast.success(
        `Face verified (${Math.round(result.confidence * 100)}%) & on-premise confirmed! Attendance synced at ${pending.timeDisplay}${statusTag}.`,
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
    toast.error(reason || "Face verification failed. Attendance blocked.", {
      title: "Proxy Check-In Rejected",
      duration: 6000,
    });
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
                  Linking.sendIntent(
                    "android.settings.SECURITY_SETTINGS",
                  ).catch(() => {
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
            "Please scan your registered finger or face to confirm sign out.";

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
            <View style={{ flex: 1 }}>
              <Text style={styles.orgName} numberOfLines={1}>
                {organization.churchName}
              </Text>
              <Text style={styles.branchName} numberOfLines={1}>
                {organization.branchName} • {organization.churchCode}
              </Text>
            </View>
          </TouchableOpacity>

          <View style={styles.topBarRight}>
            {avatarUrl ? (
              <Image source={{ uri: avatarUrl }} style={styles.topAvatar} />
            ) : (
              <View style={styles.topAvatarFallback}>
                <Text style={styles.topAvatarLetter}>
                  {(member.fullName?.[0] || "U").toUpperCase()}
                </Text>
              </View>
            )}
          </View>
        </View>

        {/* Member Profile Quick Chip Card */}
        <View style={styles.profileChipCard}>
          <View style={{ flex: 1 }}>
            <Text style={styles.profileName} numberOfLines={1}>
              {member.fullName}
            </Text>
            <Text style={styles.profileDept} numberOfLines={1}>
              {member.department}
            </Text>
          </View>

          <TouchableOpacity
            style={[
              styles.faceIdPill,
              !member.isFaceEnrolled && styles.faceIdPillUnbound,
            ]}
            onPress={() => {
              setFaceScanMode("ENROLL");
              setShowFaceModal(true);
            }}
            activeOpacity={0.7}
          >
            <Ionicons
              name={member.isFaceEnrolled ? "shield-checkmark" : "scan-outline"}
              size={13}
              color={member.isFaceEnrolled ? "#059669" : "#D97706"}
            />
            <Text
              style={[
                styles.faceIdPillText,
                !member.isFaceEnrolled && styles.faceIdPillTextUnbound,
              ]}
            >
              {member.isFaceEnrolled ? "Face Bound" : "Bind Face ID"}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Hero Clock & Shift Surface (Material 3 Surface) */}
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
                  {windowEval.openTimeFormatted} –{" "}
                  {windowEval.closeTimeFormatted}
                </Text>
              )}
          </View>
        </View>

        {/* Primary Action / Attendance Status Section */}
        {todayPunch ? (
          /* STATE A: SIGNED IN TODAY */
          <View style={styles.punchedCard}>
            <View style={styles.punchedHeaderRow}>
              <View
                style={[
                  styles.checkCircle,
                  todayPunch.attendanceStatus === "LATE" &&
                    styles.checkCircleLate,
                ]}
              >
                <Ionicons
                  name={
                    todayPunch.attendanceStatus === "LATE"
                      ? "alert"
                      : "checkmark"
                  }
                  size={22}
                  color="#FFFFFF"
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.punchedTitle}>
                  {todayPunch.attendanceStatus === "LATE"
                    ? "Signed In (Late)"
                    : "Signed In Today"}
                </Text>
                <Text style={styles.punchedSubtitle}>
                  Arrival trapped at {todayPunch.displayTime}
                </Text>
              </View>
              <View
                style={
                  todayPunch.attendanceStatus === "LATE"
                    ? styles.pillLate
                    : styles.pillOnTime
                }
              >
                <Text
                  style={
                    todayPunch.attendanceStatus === "LATE"
                      ? styles.pillTextLate
                      : styles.pillTextOnTime
                  }
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
                  color="#059669"
                />
                <Text style={styles.metaText}>
                  {todayPunch.verificationMethod === "GEO_FALLBACK"
                    ? "GPS Geofence Verified"
                    : "Office Wi-Fi Verified"}
                </Text>
              </View>

              <View style={styles.metaItem}>
                <Ionicons
                  name={
                    todayPunch.status === "SYNCED"
                      ? "cloud-done"
                      : "cloud-upload"
                  }
                  size={14}
                  color={todayPunch.status === "SYNCED" ? "#059669" : "#2563EB"}
                />
                <Text style={styles.metaText}>
                  {todayPunch.status === "SYNCED"
                    ? "Cloud Synced"
                    : "Syncing..."}
                </Text>
              </View>
            </View>

            {/* Departure / Sign-Out Action */}
            {windowEval.enableSignOut && (
              <View style={styles.signOutBox}>
                {todayPunch.signedOutAt ? (
                  <View style={styles.signOutCompletedRow}>
                    <Ionicons name="log-out" size={16} color="#059669" />
                    <Text style={styles.signOutCompletedText}>
                      Signed out at {todayPunch.signOutDisplayTime}
                    </Text>
                  </View>
                ) : windowEval.canSignOut ? (
                  <TouchableOpacity
                    style={styles.signOutActionBtn}
                    onPress={handleSignOut}
                    disabled={isSyncingSignOut}
                    activeOpacity={0.8}
                  >
                    {isSyncingSignOut ? (
                      <ActivityIndicator size="small" color="#FFFFFF" />
                    ) : (
                      <>
                        <Ionicons
                          name="log-out-outline"
                          size={18}
                          color="#FFFFFF"
                        />
                        <Text style={styles.signOutActionText}>
                          Tap to Sign Out
                        </Text>
                      </>
                    )}
                  </TouchableOpacity>
                ) : (
                  <View style={styles.signOutWaitingRow}>
                    <Ionicons name="time-outline" size={14} color="#64748B" />
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
            <Ionicons name="lock-closed-outline" size={32} color="#DC2626" />
            <Text style={styles.blockedTitle}>
              {windowEval.status === "PAST_WINDOW"
                ? "Sign-In Window Closed"
                : windowEval.status === "BEFORE_WINDOW"
                  ? "Sign-In Not Started"
                  : "No Scheduled Session"}
            </Text>
            <Text style={styles.blockedSubtitle}>
              {windowEval.rejectionReason ||
                "Attendance is not available outside policy hours."}
            </Text>
          </View>
        ) : (
          /* STATE C: WINDOW OPEN - TAP TO CLOCK IN */
          <TouchableOpacity
            style={[
              styles.primaryPunchBtn,
              windowEval.status === "WINDOW_OPEN_LATE" && styles.punchBtnLate,
              isSyncingToCloud && styles.punchBtnDisabled,
            ]}
            onPress={handleClockIn}
            disabled={isSyncingToCloud}
            activeOpacity={0.85}
          >
            {isSyncingToCloud ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <>
                <View style={styles.punchIconCircle}>
                  <Ionicons name="finger-print" size={26} color="#FFFFFF" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.punchBtnTitle}>
                    {windowEval.status === "WINDOW_OPEN_LATE"
                      ? "Tap to Clock In (Late)"
                      : "Tap to Clock In"}
                  </Text>
                  <Text style={styles.punchBtnSubtitle}>
                    Facial Biometrics & Premises Check
                  </Text>
                </View>
                <Ionicons
                  name="arrow-forward"
                  size={18}
                  color="rgba(255, 255, 255, 0.7)"
                />
              </>
            )}
          </TouchableOpacity>
        )}

        {/* Quick Info Grid (2 Modern Minimal Tiles) */}
        <View style={styles.gridRow}>
          <View style={styles.gridTile}>
            <View style={styles.gridIconWrap}>
              <Ionicons name="location-outline" size={18} color="#2563EB" />
            </View>
            <Text style={styles.gridTitle}>Premises Anchor</Text>
            <Text style={styles.gridDesc}>
              {organization.geoFallback?.radiusMeters || 30}m Geofence Perimeter
            </Text>
          </View>

          <View style={styles.gridTile}>
            <View style={styles.gridIconWrap}>
              <Ionicons
                name="shield-checkmark-outline"
                size={18}
                color="#059669"
              />
            </View>
            <Text style={styles.gridTitle}>Security Protection</Text>
            <Text style={styles.gridDesc}>
              {member.isFaceEnrolled ? "Face & Phone Bound" : "Device Bound"}
            </Text>
          </View>
        </View>

        {/* Minimal Footer */}
        <View style={styles.bottomFooter}>
          <TouchableOpacity
            style={styles.minimalSignOut}
            onPress={async () => {
              await signOut();
              toast.info("Signed out of workforce session.");
              router.replace("/login");
            }}
            activeOpacity={0.7}
          >
            <Ionicons name="log-out-outline" size={16} color="#94A3B8" />
            <Text style={styles.minimalSignOutText}>
              Sign Out of {member.fullName}
            </Text>
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
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 40,
    gap: 16,
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
    gap: 12,
    flex: 1,
    marginRight: 12,
  },
  brandLogo: {
    height: 38,
    width: 38,
    borderRadius: 10,
  },
  orgName: {
    fontSize: 16,
    fontWeight: "700",
    color: "#0F172A",
    letterSpacing: -0.2,
  },
  branchName: {
    fontSize: 12,
    color: "#64748B",
    fontWeight: "500",
    marginTop: 1,
  },
  topBarRight: {
    flexDirection: "row",
    alignItems: "center",
  },
  topAvatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 2,
    borderColor: "#E2E8F0",
  },
  topAvatarFallback: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "#EFF6FF",
    borderWidth: 1.5,
    borderColor: "#BFDBFE",
    alignItems: "center",
    justifyContent: "center",
  },
  topAvatarLetter: {
    color: "#2563EB",
    fontSize: 15,
    fontWeight: "700",
  },

  // 2. Profile Quick Chip Card
  profileChipCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: 1,
    borderColor: "#E2E8F0",
    ...Platform.select({
      ios: {
        shadowColor: "#0F172A",
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.04,
        shadowRadius: 6,
      },
      android: {
        elevation: 1,
      },
    }),
  },
  profileName: {
    fontSize: 15,
    fontWeight: "700",
    color: "#0F172A",
  },
  profileDept: {
    fontSize: 12,
    color: "#64748B",
    fontWeight: "500",
    marginTop: 2,
  },
  faceIdPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "#ECFDF5",
    borderWidth: 1,
    borderColor: "#A7F3D0",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
  },
  faceIdPillUnbound: {
    backgroundColor: "#FFFBEB",
    borderColor: "#FDE68A",
  },
  faceIdPillText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#059669",
  },
  faceIdPillTextUnbound: {
    color: "#D97706",
  },

  // 3. Hero Clock & Shift Surface (Material 3 Elevated Surface)
  clockSurface: {
    backgroundColor: "#FFFFFF",
    borderRadius: 20,
    paddingVertical: 24,
    paddingHorizontal: 20,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#E2E8F0",
    ...Platform.select({
      ios: {
        shadowColor: "#0F172A",
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.05,
        shadowRadius: 10,
      },
      android: {
        elevation: 2,
      },
    }),
  },
  clockDateText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#64748B",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  clockTimeText: {
    fontSize: 44,
    fontWeight: "800",
    color: "#0F172A",
    letterSpacing: -1,
    marginVertical: 6,
    fontVariant: ["tabular-nums"],
  },
  shiftBadgeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 6,
  },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 14,
    borderWidth: 1,
  },
  badgeActive: {
    backgroundColor: "#ECFDF5",
    borderColor: "#A7F3D0",
  },
  badgeWarning: {
    backgroundColor: "#FFFBEB",
    borderColor: "#FDE68A",
  },
  badgeError: {
    backgroundColor: "#FEF2F2",
    borderColor: "#FECACA",
  },
  badgeNeutral: {
    backgroundColor: "#F1F5F9",
    borderColor: "#E2E8F0",
  },
  badgeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  dotActive: {
    backgroundColor: "#059669",
  },
  dotWarning: {
    backgroundColor: "#D97706",
  },
  dotError: {
    backgroundColor: "#DC2626",
  },
  dotNeutral: {
    backgroundColor: "#64748B",
  },
  badgeText: {
    fontSize: 11,
    fontWeight: "700",
  },
  textActive: {
    color: "#059669",
  },
  textWarning: {
    color: "#D97706",
  },
  textError: {
    color: "#DC2626",
  },
  textNeutral: {
    color: "#64748B",
  },
  shiftHoursText: {
    fontSize: 12,
    fontWeight: "500",
    color: "#64748B",
  },

  // 4. Primary Punch Button (Tactile Action)
  primaryPunchBtn: {
    backgroundColor: "#2563EB",
    borderRadius: 18,
    paddingVertical: 18,
    paddingHorizontal: 20,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    ...Platform.select({
      ios: {
        shadowColor: "#2563EB",
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.35,
        shadowRadius: 12,
      },
      android: {
        elevation: 4,
      },
    }),
  },
  punchBtnLate: {
    backgroundColor: "#D97706",
    ...Platform.select({
      ios: {
        shadowColor: "#D97706",
      },
    }),
  },
  punchBtnDisabled: {
    opacity: 0.7,
  },
  punchIconCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    alignItems: "center",
    justifyContent: "center",
  },
  punchBtnTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: "#FFFFFF",
    letterSpacing: -0.2,
  },
  punchBtnSubtitle: {
    fontSize: 12,
    color: "rgba(255, 255, 255, 0.85)",
    fontWeight: "500",
    marginTop: 2,
  },

  // 5. Signed-In Status Card
  punchedCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 18,
    padding: 18,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    gap: 14,
    ...Platform.select({
      ios: {
        shadowColor: "#0F172A",
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.04,
        shadowRadius: 6,
      },
      android: {
        elevation: 1,
      },
    }),
  },
  punchedHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  checkCircle: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: "#059669",
    alignItems: "center",
    justifyContent: "center",
  },
  checkCircleLate: {
    backgroundColor: "#D97706",
  },
  punchedTitle: {
    fontSize: 15,
    fontWeight: "800",
    color: "#0F172A",
  },
  punchedSubtitle: {
    fontSize: 12,
    color: "#64748B",
    fontWeight: "500",
    marginTop: 2,
  },
  pillOnTime: {
    backgroundColor: "#ECFDF5",
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 8,
  },
  pillLate: {
    backgroundColor: "#FFFBEB",
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 8,
  },
  pillTextOnTime: {
    fontSize: 10,
    fontWeight: "800",
    color: "#059669",
  },
  pillTextLate: {
    fontSize: 10,
    fontWeight: "800",
    color: "#D97706",
  },
  punchedMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#F8FAFC",
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  metaItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  metaText: {
    fontSize: 12,
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
    backgroundColor: "#ECFDF5",
    paddingVertical: 12,
    borderRadius: 12,
  },
  signOutCompletedText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#059669",
  },
  signOutActionBtn: {
    backgroundColor: "#0F172A",
    borderRadius: 14,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  signOutActionText: {
    fontSize: 14,
    fontWeight: "700",
    color: "#FFFFFF",
  },
  signOutWaitingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 8,
  },
  signOutWaitingText: {
    fontSize: 12,
    color: "#64748B",
    fontWeight: "500",
  },

  // 6. Blocked Window Card
  blockedCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 18,
    padding: 22,
    borderWidth: 1,
    borderColor: "#FECACA",
    alignItems: "center",
    gap: 8,
  },
  blockedTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: "#DC2626",
    marginTop: 4,
  },
  blockedSubtitle: {
    fontSize: 13,
    color: "#64748B",
    textAlign: "center",
    lineHeight: 18,
  },

  // 7. Minimal Info Grid
  gridRow: {
    flexDirection: "row",
    gap: 12,
  },
  gridTile: {
    flex: 1,
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    gap: 4,
  },
  gridIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: "#F8FAFC",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  gridTitle: {
    fontSize: 12,
    fontWeight: "700",
    color: "#0F172A",
  },
  gridDesc: {
    fontSize: 11,
    color: "#64748B",
    fontWeight: "500",
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
    fontSize: 12,
    color: "#94A3B8",
    fontWeight: "600",
  },
});
