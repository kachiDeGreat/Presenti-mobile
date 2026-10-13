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
} from "react-native";
import { router, Redirect } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { LoadingIndicator } from "../components/LoadingIndicator";
import {
  recordAttendance,
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
import type { TodayPunchRecord } from "../types";

export default function DashboardScreen() {
  const {
    user,
    organization,
    member,
    cachedAnchors,
    deviceId,
    isLoading,
    signOut,
    refreshOrganization,
  } = useAuth();
  const toast = useToast();

  // Real-time clock ticking every second
  const [currentTime, setCurrentTime] = useState(new Date());

  // Today's trapped punch record (local or cloud)
  const [todayPunch, setTodayPunch] = useState<TodayPunchRecord | null>(null);
  const [isSyncingToCloud, setIsSyncingToCloud] = useState(false);
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
    return evaluateAttendanceWindow(organization?.policySettings, currentTime);
  }, [organization?.policySettings, currentTime]);

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
            verificationMethod: cloudDoc.verificationMethod || "WIFI_BSSID",
            bssidDetected: cloudDoc.bssidDetected,
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

  // Sync when app returns to foreground from background
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextAppState) => {
      if (nextAppState === "active") {
        refreshOrganization().catch(() => {});
      }
    });
    return () => subscription.remove();
  }, [refreshOrganization]);

  // Pull-to-refresh handler
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshOrganization();
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
            verificationMethod: cloudDoc.verificationMethod || "WIFI_BSSID",
            bssidDetected: cloudDoc.bssidDetected,
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

  if (isLoading) {
    return (
      <LoadingIndicator fullScreen message="Loading attendance dashboard..." />
    );
  }

  if (!user) {
    return <Redirect href="/login" />;
  }

  if (!organization || !member) {
    return <Redirect href="/onboarding" />;
  }

  // --- Clock In Execution (Instant Time Trap + Presence Verification + Cloud Sync) ---
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

    // 4. Drop down animated toast while checking physical presence anchors
    toast.syncing(
      `Trapped at ${timeDisplay}. Scanning Wi-Fi & verifying GPS presence...`,
      {
        title: "Verifying Presence",
      },
    );

    // 5. Physical Presence Verification (Wi-Fi Anchor or Geofence fallback)
    const effectiveAnchors = {
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

    // 6. Confirmed on-premise! Set local state with trapped time & verified anchor method
    const initialRecord: TodayPunchRecord = {
      memberId: member.id,
      punchedAt: punchedAtISO,
      displayTime: timeDisplay,
      serviceDate: todayServiceDate,
      status: "SYNCING",
      verificationMethod: presence.method,
      bssidDetected: presence.bssidDetected,
    };

    setTodayPunch(initialRecord);
    await saveTodayPunchRecord(initialRecord);

    toast.syncing(
      `On-premise confirmed (${presence.method === "GEO_FALLBACK" ? "GPS Geofence" : "Wi-Fi Anchor"})! Syncing to dashboard...`,
      {
        title: "Syncing to Cloud",
      },
    );

    // 7. Asynchronous Cloud Persistence
    try {
      await recordAttendance(organization.id, {
        memberId: member.id,
        memberName: member.fullName,
        department: member.department,
        serviceDate: todayServiceDate,
        timestamp: punchedAtISO,
        punchedAt: punchedAtISO,
        syncedAt: new Date().toISOString(),
        verificationMethod: presence.method,
        deviceId,
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
      };
      setTodayPunch(syncedRecord);
      await saveTodayPunchRecord(syncedRecord);

      toast.success(
        `Verified on-premise (${presence.method === "GEO_FALLBACK" ? "GPS Geofence" : "Wi-Fi Anchor"})! Attendance synced at ${timeDisplay}.`,
        { title: "Check-In Confirmed", duration: 4000 },
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
        `Verified & trapped at ${timeDisplay}. Will sync to dashboard once connection is stable.`,
        { title: "Punch Trapped Locally", duration: 4500 },
      );
    } finally {
      setIsSyncingToCloud(false);
    }
  };

  const avatarUrl = member.photoURL || user.photoURL;

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
            <Image
              source={require("../image/logo-dark.png")}
              style={styles.heroBrandLogo}
              resizeMode="contain"
            />
            <View style={styles.codeBadge}>
              <Text style={styles.codeBadgeText}>
                {organization.churchCode}
              </Text>
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

            <View style={styles.deviceLockBadge}>
              <Ionicons name="lock-closed" size={11} color="#059669" />
              <Text style={styles.deviceLockText}>Device Bound</Text>
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
              {organization.policySettings?.arrivalCutoff &&
              organization.policySettings?.lateTolerance
                ? `Window: ${windowEval.openTimeFormatted} - ${windowEval.closeTimeFormatted} • ${windowEval.summary}`
                : windowEval.summary}
            </Text>
          </View>
        </View>

        {/* Primary Action / Signed-In Status Card */}
        <View style={styles.actionSection}>
          {todayPunch ? (
            /* --- STATE: ALREADY SIGNED IN TODAY --- */
            <View style={styles.signedInCard}>
              <View style={styles.signedInTopRow}>
                <View style={styles.checkCircle}>
                  <Ionicons name="checkmark-sharp" size={24} color="#FFFFFF" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.signedInHeading}>
                    Signed In For Today
                  </Text>
                  <Text style={styles.signedInSubheading}>
                    Arrival trapped at {todayPunch.displayTime}
                  </Text>
                </View>
                <View style={styles.onTimePill}>
                  <Text style={styles.onTimePillText}>ON TIME</Text>
                </View>
              </View>

              <View style={styles.signedInDivider} />

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

              <View style={styles.anchorDetailRow}>
                <Ionicons
                  name={
                    todayPunch.verificationMethod === "GEO_FALLBACK"
                      ? "navigate-circle"
                      : "wifi"
                  }
                  size={15}
                  color="#059669"
                />
                <Text style={styles.anchorDetailText}>
                  {todayPunch.verificationMethod === "GEO_FALLBACK"
                    ? "Verified via GPS Geofence Perimeter"
                    : `Verified via Wi-Fi Anchor (${cachedAnchors?.targetBssid || "Premises Router"})`}
                </Text>
              </View>
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
          ) : (
            /* --- STATE: WINDOW OPEN (READY TO CLOCK IN) --- */
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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#F1F5F9",
  },
  scrollContent: {
    padding: 16,
    gap: 14,
    flexGrow: 1,
  },

  // Hero Card (Clean White Executive Theme)
  heroCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    padding: 18,
    shadowColor: "#0F172A",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 8,
    elevation: 2,
    borderWidth: 1,
    borderColor: "#E2E8F0",
  },
  heroTopRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  heroBrandLogo: {
    height: 28,
    width: 105,
  },
  orgTagBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#EFF6FF",
    borderWidth: 1,
    borderColor: "#DBEAFE",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    alignSelf: "flex-start",
    marginBottom: 6,
  },
  orgTagText: {
    color: "#2563EB",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.6,
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
    color: "#334155",
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
    borderWidth: 1.5,
    borderColor: "#BFDBFE",
  },
  avatarFallback: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#EFF6FF",
    borderWidth: 1.5,
    borderColor: "#BFDBFE",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarLetter: {
    color: "#2563EB",
    fontSize: 17,
    fontWeight: "700",
  },
  memberInfoCol: {
    flex: 1,
    gap: 3,
  },
  memberName: {
    color: "#0F172A",
    fontSize: 15,
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
    fontSize: 12,
    fontWeight: "500",
  },
  deviceLockBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#ECFDF5",
    borderWidth: 1,
    borderColor: "#A7F3D0",
    paddingHorizontal: 7,
    paddingVertical: 4,
    borderRadius: 6,
  },
  deviceLockText: {
    color: "#059669",
    fontSize: 10,
    fontWeight: "700",
  },

  // Live Digital Clock Card
  clockCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    padding: 18,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    shadowColor: "#64748B",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 2,
    gap: 8,
  },
  clockHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  clockDateLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: "#64748B",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  windowStatusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  windowStatusText: {
    fontSize: 11,
    fontWeight: "700",
  },
  statusActive: {
    backgroundColor: "#ECFDF5",
  },
  dotActive: {
    backgroundColor: "#10B981",
  },
  textActive: {
    color: "#047857",
  },
  statusWarning: {
    backgroundColor: "#FFFBEB",
  },
  dotWarning: {
    backgroundColor: "#F59E0B",
  },
  textWarning: {
    color: "#B45309",
  },
  statusError: {
    backgroundColor: "#FEF2F2",
  },
  dotError: {
    backgroundColor: "#EF4444",
  },
  textError: {
    color: "#B91C1C",
  },
  statusNeutral: {
    backgroundColor: "#F1F5F9",
  },
  dotNeutral: {
    backgroundColor: "#94A3B8",
  },
  textNeutral: {
    color: "#64748B",
  },
  digitalClockTime: {
    fontSize: 34,
    fontWeight: "800",
    color: "#0F172A",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    letterSpacing: -1,
    marginVertical: 4,
  },
  policyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#F8FAFC",
    padding: 8,
    borderRadius: 8,
  },
  policySummaryText: {
    fontSize: 11,
    color: "#475569",
    fontWeight: "500",
    flex: 1,
  },

  // Action Section
  actionSection: {
    marginTop: 2,
  },
  clockInPrimaryButton: {
    backgroundColor: "#1D4ED8",
    borderRadius: 14,
    padding: 16,
    shadowColor: "#2563EB",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 5,
  },
  buttonInnerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  fingerprintCircle: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    alignItems: "center",
    justifyContent: "center",
  },
  clockInPrimaryTitle: {
    color: "#FFFFFF",
    fontSize: 17,
    fontWeight: "800",
    letterSpacing: -0.2,
  },
  clockInPrimarySubtitle: {
    color: "#BFDBFE",
    fontSize: 12,
    fontWeight: "500",
    marginTop: 2,
  },
  buttonDisabled: {
    opacity: 0.65,
  },

  // Signed In Celebration Card
  signedInCard: {
    backgroundColor: "#F0FDF4",
    borderWidth: 1.5,
    borderColor: "#86EFAC",
    borderRadius: 14,
    padding: 16,
    gap: 12,
    shadowColor: "#10B981",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.12,
    shadowRadius: 6,
    elevation: 3,
  },
  signedInTopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  checkCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#10B981",
    alignItems: "center",
    justifyContent: "center",
  },
  signedInHeading: {
    fontSize: 16,
    fontWeight: "800",
    color: "#065F46",
  },
  signedInSubheading: {
    fontSize: 12,
    fontWeight: "600",
    color: "#047857",
    marginTop: 2,
  },
  onTimePill: {
    backgroundColor: "#DCFCE7",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#86EFAC",
  },
  onTimePillText: {
    color: "#166534",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  signedInDivider: {
    height: 1,
    backgroundColor: "#BBF7D0",
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
    fontSize: 12,
    color: "#2563EB",
    fontWeight: "600",
  },
  syncDoneLabel: {
    fontSize: 12,
    color: "#059669",
    fontWeight: "600",
  },
  syncOfflineLabel: {
    fontSize: 12,
    color: "#D97706",
    fontWeight: "600",
  },
  anchorDetailRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#DCFCE7",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  anchorDetailText: {
    fontSize: 11,
    fontWeight: "600",
    color: "#166534",
  },

  // Blocked Card (Late / Closed)
  blockedCard: {
    backgroundColor: "#FEF2F2",
    borderWidth: 1,
    borderColor: "#FECACA",
    borderRadius: 14,
    padding: 18,
    alignItems: "center",
    gap: 8,
  },
  blockedIconContainer: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "#FEE2E2",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 2,
  },
  blockedTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: "#991B1B",
  },
  blockedReason: {
    fontSize: 12,
    color: "#B91C1C",
    textAlign: "center",
    lineHeight: 17,
  },
  disabledActionButton: {
    backgroundColor: "#F87171",
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 10,
    marginTop: 6,
    width: "100%",
    alignItems: "center",
  },
  disabledActionButtonText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "700",
  },

  // Anchors Card
  anchorsCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    gap: 10,
  },
  anchorsHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 4,
  },
  anchorsIconBadge: {
    width: 26,
    height: 26,
    borderRadius: 6,
    backgroundColor: "#EFF6FF",
    alignItems: "center",
    justifyContent: "center",
  },
  anchorsTitle: {
    fontSize: 11,
    fontWeight: "800",
    color: "#334155",
    letterSpacing: 0.8,
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
    backgroundColor: "#10B981",
  },
  anchorItemValue: {
    fontSize: 12,
    fontWeight: "600",
    color: "#0F172A",
  },
  anchorHardwareCode: {
    fontSize: 11,
    fontWeight: "700",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    color: "#2563EB",
  },

  // Footer Section
  footerSection: {
    alignItems: "center",
    paddingVertical: 12,
    gap: 10,
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
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  signOutText: {
    fontSize: 13,
    color: "#EF4444",
    fontWeight: "600",
  },
});
