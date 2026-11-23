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
  loadFaceFromLocalVault,
} from "../services/organizationService";
import {
  evaluateAttendanceWindow,
  format12Hour,
  DAY_NAMES,
  type WindowEvaluationResult,
} from "../utils/timePolicy";
import {
  verifyPresenceAnchors,
  type PresenceVerificationResult,
} from "../services/presenceVerificationService";
import { verifyIdentityForClockIn } from "../services/biometricAuthService";
import type { TodayPunchRecord } from "../types";
import { AdminCalibrationModal } from "../components/AdminCalibrationModal";
import { AdminHub } from "../components/AdminHub";
import { FaceScannerModal } from "../components/FaceScannerModal";
import { TactilePressable } from "../components/TactilePressable";
import { C, MONO, R, S, T, shadow, ui } from "../constants/premium";

/** Isolated 1s clock so DashboardScreen doesn't re-render every second on budget phones */
const LiveClockDisplay = React.memo(() => {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const hoursString = now.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const dateString = now.toLocaleDateString([], {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <>
      <Text style={styles.clockDateText}>{dateString}</Text>
      <Text style={styles.clockTimeText}>{hoursString}</Text>
    </>
  );
});

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
    action: "clockIn" | "signOut" | "enrollOnly";
  }>({ visible: false, mode: "verify", action: "clockIn" });
  const [localFacePhoto, setLocalFacePhoto] = useState<string | undefined>(
    member?.facePhotoURL
  );
  const verifiedPresenceRef = React.useRef<PresenceVerificationResult | null>(null);
  const punchCancelledRef = React.useRef(false);

  // Instant 0ms On-Device Face Vault lookup so verification reads locally without cloud lag
  useEffect(() => {
    let active = true;
    const email = member?.email || user?.email;
    const memberId = member?.id;
    if (!email && !memberId) return;

    loadFaceFromLocalVault(email, memberId)
      .then((vault) => {
        if (!active) return;
        if (vault?.facePhotoURL) {
          setLocalFacePhoto(vault.facePhotoURL);
        } else if (member?.facePhotoURL) {
          setLocalFacePhoto(member.facePhotoURL);
        }
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, [member?.id, member?.email, member?.facePhotoURL, user?.email]);

  // Policy evaluation tick (30s cadence — live seconds live inside LiveClockDisplay)
  const [currentTime, setCurrentTime] = useState(new Date());

  // Today's trapped punch record (local or cloud)
  const [todayPunch, setTodayPunch] = useState<TodayPunchRecord | null>(null);
  const [isSyncingToCloud, setIsSyncingToCloud] = useState(false);
  const [isSyncingSignOut, setIsSyncingSignOut] = useState(false);
  const [hasCheckedToday, setHasCheckedToday] = useState(false);

  // Ticking interval (30s)
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 30000);
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
      member?.assignedShiftId,
    );
  }, [organization?.policySettings, currentTime, todayPunch, member?.assignedShiftId]);

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
      if (!organization) {
        router.replace("/admin-onboarding" as any);
      }
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
    if (!organization) {
      return (
        <LoadingIndicator fullScreen message="Preparing organization setup..." />
      );
    }
    return <AdminHub />;
  }

  // Workforce Member Experience: Guard enrollment
  if (!organization || !member) {
    return (
      <LoadingIndicator fullScreen message="Loading workforce profile..." />
    );
  }

  // Verify Wi-Fi / GPS Geofence BEFORE opening the face scanner
  const verifyOnPremiseBeforeScan = async (): Promise<PresenceVerificationResult | null> => {
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
      toast.warn(
        "Admin has not calibrated this account. Contact admin to calibrate it.",
        { title: "Account Not Calibrated", duration: 6000 },
      );
      return null;
    }

    const effectiveMode =
      organization.beaconConfig?.verificationMode ||
      cachedAnchors?.verificationMode ||
      (organization.beaconConfig?.targetBssid || cachedAnchors?.targetBssid
        ? "HYBRID"
        : "GEOFENCE_ONLY");

    punchCancelledRef.current = false;
    setIsSyncingToCloud(true);
    toast.syncing(
      effectiveMode === "GEOFENCE_ONLY"
        ? "Checking GPS Geofence perimeter..."
        : "Checking Wi-Fi & GPS premises anchor...",
      { title: "Verifying Location" },
    );

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

    let presence: PresenceVerificationResult;
    try {
      presence = await verifyPresenceAnchors(effectiveAnchors);
    } catch (presenceErr: any) {
      presence = {
        isVerified: false,
        method: "GEO_FALLBACK",
        failureReason:
          presenceErr?.message || "Failed to verify presence on device.",
        details: "Verification error",
      };
    } finally {
      setIsSyncingToCloud(false);
    }

    if (punchCancelledRef.current) {
      toast.hide();
      verifiedPresenceRef.current = null;
      return null;
    }

    if (!presence.isVerified) {
      toast.error(
        presence.failureReason ||
          "You are outside the organization premises. Move closer to clock in.",
        { title: "Outside Geofence", duration: 6000 },
      );
      return null;
    }

    toast.hide();
    verifiedPresenceRef.current = presence;
    return presence;
  };

  // Clock-in execution: 1) Window check -> 2) Location/Wi-Fi check -> 3) AI Face Scan
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

    // 3. Ensure account has an enrolled face reference from On-Device Vault or profile
    let activeFaceRef = localFacePhoto || member?.facePhotoURL;
    if (!activeFaceRef) {
      const vault = await loadFaceFromLocalVault(
        member?.email || user?.email,
        member?.id
      );
      if (vault?.facePhotoURL) {
        activeFaceRef = vault.facePhotoURL;
        setLocalFacePhoto(vault.facePhotoURL);
      }
    }

    if (!activeFaceRef) {
      toast.warn(
        "Your Face ID was reset by an administrator or is missing on this device. Complete Face ID enrollment first, then tap Clock In to verify.",
        { title: "Face ID Enrollment Required", duration: 5000 },
      );
      setFaceModal({
        visible: true,
        mode: "enroll",
        action: "enrollOnly",
      });
      return;
    }

    // 4. MANDATORY ON-PREMISE LOCATION / WI-FI CHECK BEFORE FACE SCAN
    const presence = await verifyOnPremiseBeforeScan();
    if (!presence) return;

    // 5. MANDATORY 1-TO-1 AI FACE VERIFICATION AGAINST ONBOARDING FACE
    setFaceModal({
      visible: true,
      mode: "verify",
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

    // 5. Confirm physical presence (reuse pre-scan lock or re-verify)
    let presence = verifiedPresenceRef.current;
    verifiedPresenceRef.current = null;
    if (!presence || !presence.isVerified) {
      presence = await verifyOnPremiseBeforeScan();
      if (!presence) return;
    }

    setIsSyncingToCloud(true);

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

    let activeFaceRef = localFacePhoto || member?.facePhotoURL;
    if (!activeFaceRef) {
      const vault = await loadFaceFromLocalVault(
        member?.email || user?.email,
        member?.id
      );
      if (vault?.facePhotoURL) {
        activeFaceRef = vault.facePhotoURL;
        setLocalFacePhoto(vault.facePhotoURL);
      }
    }

    if (!activeFaceRef) {
      toast.warn(
        "Your Face ID was reset by an administrator or is missing on this device. Complete Face ID enrollment first, then tap Sign Out to verify.",
        { title: "Face ID Enrollment Required", duration: 5000 },
      );
      setFaceModal({
        visible: true,
        mode: "enroll",
        action: "enrollOnly",
      });
      return;
    }

    // Verify on-premise location BEFORE opening Face Scanner
    const presence = await verifyOnPremiseBeforeScan();
    if (!presence) return;

    // MANDATORY 1-TO-1 AI FACE VERIFICATION AGAINST ONBOARDING FACE
    setFaceModal({
      visible: true,
      mode: "verify",
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

        {/* Hero Digital Shift Clock Card */}
        <View style={styles.clockSurface}>
          <LiveClockDisplay />

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
                      <ActivityIndicator size="small" color={C.ink} />
                    ) : (
                      <>
                        <Ionicons name="log-out-outline" size={18} color={C.ink} />
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
          /* STATE C: WINDOW OPEN - TAP TO CLOCK IN (Tactile Native Spring CTA) */
          <TactilePressable
            style={[
              styles.primaryPunchBtn,
              windowEval.status === "WINDOW_OPEN_LATE" && styles.punchBtnLate,
              isSyncingToCloud && styles.punchBtnDisabled,
            ]}
            rippleColor="rgba(255,255,255,0.18)"
            onPress={handleClockIn}
            disabled={isSyncingToCloud}
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
          </TactilePressable>
        )}

        {/* Quick Info Grid */}
        <View style={styles.gridRow}>
          <View style={styles.gridTile}>
            <View style={[styles.gridIconWrap, { backgroundColor: C.accentSoft }]}>
              <Ionicons name="compass-outline" size={18} color={C.accent} />
            </View>
            <Text style={styles.gridTitle}>Premises Anchor</Text>
            <Text style={styles.gridDesc}>
              {organization.geoFallback?.radiusMeters || 20}m Geofence Perimeter
            </Text>
          </View>

          <View style={styles.gridTile}>
            <View style={[styles.gridIconWrap, { backgroundColor: C.successSoft }]}>
              <Ionicons name="shield-checkmark-outline" size={18} color={C.success} />
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

      {/* 1-to-1 AI Face Verification Scanner (Reads reference face from On-Device Vault) */}
      <FaceScannerModal
        visible={faceModal.visible}
        mode={faceModal.mode}
        referencePhotoUrl={localFacePhoto || member?.facePhotoURL}
        onCancel={() => {
          punchCancelledRef.current = true;
          verifiedPresenceRef.current = null;
          setIsSyncingToCloud(false);
          toast.hide();
          setFaceModal((prev) => ({ ...prev, visible: false }));
        }}
        onSuccess={async (capturedDataUri) => {
          const currentAction = faceModal.action;
          const currentMode = faceModal.mode;
          setFaceModal((prev) => ({ ...prev, visible: false }));

          // Enrollment only happens if explicitly triggered after an admin reset;
          // it NEVER auto-clocks in or overwrites an existing face during clock-in.
          if (currentMode === "enroll" || currentAction === "enrollOnly") {
            try {
              setLocalFacePhoto(capturedDataUri);
              await enrollFace([1], capturedDataUri);
              toast.success(
                "Face ID saved to device! You can now tap Clock In to verify against your enrolled face.",
                { title: "Face ID Saved Locally", duration: 4500 },
              );
            } catch (err: any) {
              toast.error(
                err?.message || "Failed to save enrolled Face ID. Please try again.",
              );
            }
            return;
          }

          if (currentAction === "clockIn") {
            await executeClockInAfterVerification();
          } else if (currentAction === "signOut") {
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
    backgroundColor: C.canvas,
  },
  scrollContent: {
    paddingHorizontal: S.screenX,
    paddingTop: S.sm,
    paddingBottom: 40,
    gap: 14,
    maxWidth: 540,
    width: "100%",
    alignSelf: "center",
  },

  // 1. Top Bar / App Branding (Light canvas header)
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 6,
  },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    flex: 1,
    marginRight: 10,
  },
  brandLogo: {
    height: 40,
    width: 40,
    borderRadius: R.sm,
  },
  brandBadgeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  livePulseDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: C.success,
  },
  brandTag: {
    ...T.labelSm,
    color: C.ink,
  },
  orgCodePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: C.card,
    borderRadius: R.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: C.lineCard,
  },
  orgCodeText: {
    ...T.labelSm,
    fontSize: 9,
    color: C.ink,
  },
  orgName: {
    ...T.title,
    fontSize: 18,
  },
  topBarRight: {
    flexDirection: "row",
    alignItems: "center",
  },
  topAvatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 2,
    borderColor: C.card,
  },
  topAvatarFallback: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: C.ink,
    alignItems: "center",
    justifyContent: "center",
    ...shadow.card,
  },
  topAvatarLetter: {
    color: C.white,
    fontSize: 15,
    fontWeight: "800",
  },

  // 2. Profile Quick Chip Card
  profileChipCard: {
    ...ui.card,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  profileName: {
    ...T.heading,
    fontSize: 15,
  },
  profileDept: {
    ...T.caption,
    fontSize: 12,
  },
  biometricBadge: {
    ...ui.pill,
    backgroundColor: C.successSoft,
  },
  biometricBadgeText: {
    ...T.labelSm,
    color: C.success,
  },

  // 3. Hero Digital Shift Clock Card
  clockSurface: {
    ...ui.card,
    paddingVertical: 24,
    paddingHorizontal: S.lg,
    alignItems: "center",
  },
  clockDateText: {
    ...T.label,
    color: C.muted,
  },
  clockTimeText: {
    ...T.hero,
    fontSize: 44,
    marginVertical: 6,
    fontVariant: ["tabular-nums"],
  },
  shiftBadgeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 6,
  },
  statusBadge: {
    ...ui.pill,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  badgeActive: {
    backgroundColor: C.successSoft,
  },
  badgeWarning: {
    backgroundColor: C.warnSoft,
  },
  badgeError: {
    backgroundColor: C.dangerSoft,
  },
  badgeNeutral: {
    backgroundColor: C.cardAlt,
  },
  badgeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  dotActive: {
    backgroundColor: C.success,
  },
  dotWarning: {
    backgroundColor: C.warn,
  },
  dotError: {
    backgroundColor: C.danger,
  },
  dotNeutral: {
    backgroundColor: C.muted,
  },
  badgeText: {
    ...T.labelSm,
  },
  textActive: {
    color: C.success,
  },
  textWarning: {
    color: C.warn,
  },
  textError: {
    color: C.danger,
  },
  textNeutral: {
    color: C.muted,
  },
  shiftHoursText: {
    ...T.labelSm,
    color: C.ink2,
  },

  // 4. Primary Punch Button (Bolt Style Hero Action)
  primaryPunchBtn: {
    backgroundColor: C.ink,
    borderRadius: R.md,
    paddingVertical: 16,
    paddingHorizontal: 18,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    ...shadow.raised,
  },
  punchBtnLate: {
    backgroundColor: C.warn,
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
    paddingVertical: 6,
  },
  punchIconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(255, 255, 255, 0.16)",
    alignItems: "center",
    justifyContent: "center",
  },
  punchBtnTitle: {
    ...ui.btnPrimaryText,
  },
  punchBtnSubtitle: {
    fontSize: 12,
    color: "rgba(255, 255, 255, 0.8)",
    fontWeight: "500",
    marginTop: 2,
  },

  // 5. Signed-In Status Card
  punchedCard: {
    ...ui.card,
    gap: 14,
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
    backgroundColor: C.success,
    alignItems: "center",
    justifyContent: "center",
  },
  checkCircleLate: {
    backgroundColor: C.warn,
  },
  punchedTitle: {
    ...T.heading,
  },
  punchedSubtitle: {
    ...T.caption,
  },
  pillGeneric: {
    ...ui.pill,
  },
  pillOnTime: {
    backgroundColor: C.successSoft,
  },
  pillLate: {
    backgroundColor: C.warnSoft,
  },
  pillTextGeneric: {
    ...T.labelSm,
  },
  pillTextOnTime: {
    color: C.success,
  },
  pillTextLate: {
    color: C.warn,
  },
  punchedMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: C.cardAlt,
    borderRadius: R.md,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  metaItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  metaText: {
    fontSize: 12,
    color: C.ink2,
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
    backgroundColor: C.successSoft,
    borderRadius: R.md,
    paddingVertical: 12,
  },
  signOutCompletedText: {
    ...T.labelSm,
    color: C.success,
  },
  signOutActionBtn: {
    ...ui.btnSecondary,
    width: "100%",
  },
  signOutActionText: {
    ...ui.btnSecondaryText,
  },
  signOutWaitingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 8,
  },
  signOutWaitingText: {
    ...T.caption,
    fontSize: 12,
  },

  // 6. Blocked Window Card
  blockedCard: {
    ...ui.card,
    padding: S.lg,
    alignItems: "center",
    gap: 8,
  },
  blockedTitle: {
    ...T.heading,
    color: C.danger,
    marginTop: 4,
  },
  blockedSubtitle: {
    ...T.caption,
    textAlign: "center",
  },

  // 7. Minimal Info Grid
  gridRow: {
    flexDirection: "row",
    gap: 12,
  },
  gridTile: {
    flex: 1,
    ...ui.card,
    gap: 4,
  },
  gridIconWrap: {
    ...ui.iconBubble,
    backgroundColor: C.cardAlt,
    marginBottom: 6,
  },
  gridTitle: {
    ...T.labelSm,
    color: C.ink,
  },
  gridDesc: {
    ...T.caption,
    fontSize: 12,
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
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  minimalSignOutText: {
    ...T.labelSm,
    color: C.muted,
  },
});
