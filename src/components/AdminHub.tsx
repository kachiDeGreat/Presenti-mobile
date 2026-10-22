import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  TextInput,
  Platform,
  Alert,
  Image,
  RefreshControl,
  Share,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as Location from "expo-location";
import * as Clipboard from "expo-clipboard";
import {
  collection,
  query,
  orderBy,
  onSnapshot,
  doc,
  updateDoc,
  deleteDoc,
  writeBatch,
  getDocs,
} from "firebase/firestore";
import { db } from "../config/firebase";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { PresenceMapMobile } from "./PresenceMapMobile";
import {
  scanPhysicalWifiNetworks,
  ScannedWifiNetwork,
} from "../services/wifiScanService";
import { updateOrganizationAnchors as updateAnchorsService } from "../services/organizationService";
import type { ChurchMember, PolicySettings } from "../types";

const RADIUS_OPTIONS = [10, 20, 30, 50, 80, 100];
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface LiveAttendanceRecord {
  id: string;
  memberId: string;
  memberName: string;
  department: string;
  serviceDate: string;
  punchedAt: string;
  status: "ON_TIME" | "LATE";
  verificationMethod: "WIFI_BSSID" | "GEO_FALLBACK";
  bssidDetected?: string;
  signedOutAt?: string;
}

export const AdminHub: React.FC = () => {
  const { user, organization, refreshOrganization, signOut } = useAuth();
  const toast = useToast();

  const [activeTab, setActiveTab] = useState<
    "feed" | "anchors" | "roster" | "policy"
  >("feed");
  const [refreshing, setRefreshing] = useState(false);

  // ---------------------------------------------------------------------------
  // TAB 1: LIVE ATTENDANCE FEED
  // ---------------------------------------------------------------------------
  const [attendance, setAttendance] = useState<LiveAttendanceRecord[]>([]);
  const [isAttendanceLoading, setIsAttendanceLoading] = useState(true);
  const [feedSearch, setFeedSearch] = useState("");
  const [selectedDeptFilter, setSelectedDeptFilter] = useState<string>("ALL");
  const [isClearingFeed, setIsClearingFeed] = useState(false);

  useEffect(() => {
    if (!organization?.id || !db) return;
    setIsAttendanceLoading(true);

    try {
      const attRef = collection(db, "churches", organization.id, "attendance");
      const q = query(attRef, orderBy("punchedAt", "desc"));
      const unsubscribe = onSnapshot(
        q,
        (snap) => {
          const records: LiveAttendanceRecord[] = snap.docs.map((d) => ({
            id: d.id,
            ...(d.data() as any),
          }));
          setAttendance(records);
          setIsAttendanceLoading(false);
        },
        (err) => {
          console.warn("Live attendance stream error:", err);
          setIsAttendanceLoading(false);
        }
      );
      return () => unsubscribe();
    } catch (e) {
      console.warn("Error subscribing to attendance:", e);
      setIsAttendanceLoading(false);
    }
  }, [organization?.id]);

  const todayDateStr = useMemo(() => {
    return new Date().toISOString().split("T")[0];
  }, []);

  const todayRecords = useMemo(() => {
    return attendance.filter((r) => r.serviceDate === todayDateStr);
  }, [attendance, todayDateStr]);

  const onTimeCount = useMemo(() => {
    return todayRecords.filter((r) => r.status === "ON_TIME").length;
  }, [todayRecords]);

  const lateCount = useMemo(() => {
    return todayRecords.filter((r) => r.status === "LATE").length;
  }, [todayRecords]);

  const punctualityRate = useMemo(() => {
    if (todayRecords.length === 0) return 100;
    return Math.round((onTimeCount / todayRecords.length) * 100);
  }, [todayRecords, onTimeCount]);

  const filteredFeedRecords = useMemo(() => {
    return todayRecords.filter((rec) => {
      const matchSearch =
        !feedSearch.trim() ||
        rec.memberName?.toLowerCase().includes(feedSearch.toLowerCase()) ||
        rec.department?.toLowerCase().includes(feedSearch.toLowerCase());
      const matchDept =
        selectedDeptFilter === "ALL" || rec.department === selectedDeptFilter;
      return matchSearch && matchDept;
    });
  }, [todayRecords, feedSearch, selectedDeptFilter]);

  const handleClearFeed = async () => {
    if (!organization?.id || isClearingFeed) return;

    Alert.alert(
      "Clear Attendance Feed",
      "Are you sure you want to permanently clear all attendance records from the cloud database? This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear Database",
          style: "destructive",
          onPress: async () => {
            setIsClearingFeed(true);
            try {
              const attRef = collection(
                db,
                "churches",
                organization.id,
                "attendance"
              );
              const snap = await getDocs(attRef);
              if (!snap.empty) {
                const docs = snap.docs;
                for (let i = 0; i < docs.length; i += 400) {
                  const batch = writeBatch(db);
                  const chunk = docs.slice(i, i + 400);
                  chunk.forEach((d) => batch.delete(d.ref));
                  await batch.commit();
                }
              }
              setAttendance([]);
              toast.success("Attendance feed cleared from database.");
            } catch (err: any) {
              console.error("Clear feed error:", err);
              toast.error("Failed to clear feed from cloud.");
            } finally {
              setIsClearingFeed(false);
            }
          },
        },
      ]
    );
  };

  // ---------------------------------------------------------------------------
  // TAB 2: HARDWARE PRESENCE ANCHORS & CALIBRATION
  // ---------------------------------------------------------------------------
  const [calMode, setCalMode] = useState<"HYBRID" | "GEOFENCE_ONLY">(
    organization?.beaconConfig?.verificationMode === "GEOFENCE_ONLY"
      ? "GEOFENCE_ONLY"
      : "HYBRID"
  );
  const [ssidHint, setSsidHint] = useState<string>(
    organization?.beaconConfig?.ssidHint || ""
  );
  const [targetBssid, setTargetBssid] = useState<string>(
    organization?.beaconConfig?.targetBssid || ""
  );
  const [latitude, setLatitude] = useState<number>(
    organization?.geoFallback?.latitude || 4.975
  );
  const [longitude, setLongitude] = useState<number>(
    organization?.geoFallback?.longitude || 8.3417
  );
  const [radiusMeters, setRadiusMeters] = useState<number>(
    organization?.geoFallback?.radiusMeters || 10
  );
  const [availableNetworks, setAvailableNetworks] = useState<
    ScannedWifiNetwork[]
  >([]);
  const [isScanningWifi, setIsScanningWifi] = useState(false);
  const [isLocatingGps, setIsLocatingGps] = useState(false);
  const [isSavingAnchors, setIsSavingAnchors] = useState(false);

  // Sync state if organization updates in background
  useEffect(() => {
    if (organization) {
      if (organization.beaconConfig?.verificationMode) {
        setCalMode(organization.beaconConfig.verificationMode);
      }
      if (organization.beaconConfig?.ssidHint) {
        setSsidHint(organization.beaconConfig.ssidHint);
      }
      if (organization.beaconConfig?.targetBssid) {
        setTargetBssid(organization.beaconConfig.targetBssid);
      }
      if (organization.geoFallback?.latitude) {
        setLatitude(organization.geoFallback.latitude);
      }
      if (organization.geoFallback?.longitude) {
        setLongitude(organization.geoFallback.longitude);
      }
      if (organization.geoFallback?.radiusMeters) {
        setRadiusMeters(organization.geoFallback.radiusMeters);
      }
    }
  }, [organization]);

  const handleScanWifi = async () => {
    setIsScanningWifi(true);
    try {
      const res = await scanPhysicalWifiNetworks();
      const list = res.networks || [];
      setAvailableNetworks(list);
      if (list.length === 0) {
        toast.info(
          "No Wi-Fi broadcast points detected nearby. You can enter the BSSID MAC address manually."
        );
      } else {
        toast.success(`Discovered ${list.length} nearby Wi-Fi broadcast points.`);
      }
    } catch (err: any) {
      toast.warn("Wi-Fi scan limited or unavailable on this device.");
    } finally {
      setIsScanningWifi(false);
    }
  };

  const handleSelectNetwork = (net: ScannedWifiNetwork) => {
    setSsidHint(net.ssid);
    setTargetBssid(net.bssid);
    toast.success(`Selected router: ${net.ssid} (${net.bssid})`);
  };

  const handlePinpointGps = async () => {
    setIsLocatingGps(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        toast.warn("Location permission is required to sample GPS coordinates.");
        return;
      }
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });
      setLatitude(pos.coords.latitude);
      setLongitude(pos.coords.longitude);
      toast.success(
        `High-precision GPS pinpointed (±${Math.round(pos.coords.accuracy || 5)}m accuracy).`
      );
    } catch (err: any) {
      toast.error("Could not capture GPS location from phone sensors.");
    } finally {
      setIsLocatingGps(false);
    }
  };

  const handleSaveAnchors = async () => {
    if (!organization?.id || isSavingAnchors) return;

    if (calMode === "HYBRID" && !targetBssid.trim()) {
      toast.warn("Please enter or scan an office Wi-Fi router BSSID MAC address.");
      return;
    }
    if (latitude === 0 && longitude === 0) {
      toast.warn("Please sample on-site GPS coordinates.");
      return;
    }

    setIsSavingAnchors(true);
    try {
      await updateAnchorsService(organization.id, {
        ssidHint: ssidHint.trim(),
        targetBssid: targetBssid.trim().toLowerCase(),
        latitude,
        longitude,
        radiusMeters,
        verificationMode: calMode,
      });
      await refreshOrganization();
      toast.success(
        "Presence Anchors calibrated & synced to cloud! Web admin portal updated."
      );
    } catch (err: any) {
      console.error("Save anchors error:", err);
      toast.error("Failed to commit anchors to cloud database.");
    } finally {
      setIsSavingAnchors(false);
    }
  };

  // ---------------------------------------------------------------------------
  // TAB 3: WORKFORCE ROSTER & MEMBER MANAGEMENT
  // ---------------------------------------------------------------------------
  const [members, setMembers] = useState<ChurchMember[]>([]);
  const [isMembersLoading, setIsMembersLoading] = useState(true);
  const [rosterSearch, setRosterSearch] = useState("");
  const [rosterDeptFilter, setRosterDeptFilter] = useState("ALL");
  const [unbindingMemberId, setUnbindingMemberId] = useState<string | null>(
    null
  );

  useEffect(() => {
    if (!organization?.id || !db) return;
    setIsMembersLoading(true);

    try {
      const memRef = collection(db, "churches", organization.id, "members");
      const q = query(memRef, orderBy("registeredAt", "desc"));
      const unsubscribe = onSnapshot(
        q,
        (snap) => {
          const list: ChurchMember[] = snap.docs.map((d) => ({
            id: d.id,
            ...(d.data() as any),
          }));
          setMembers(list);
          setIsMembersLoading(false);
        },
        (err) => {
          console.warn("Members stream error:", err);
          setIsMembersLoading(false);
        }
      );
      return () => unsubscribe();
    } catch (e) {
      console.warn("Error subscribing to members:", e);
      setIsMembersLoading(false);
    }
  }, [organization?.id]);

  const filteredMembers = useMemo(() => {
    return members.filter((m) => {
      const matchSearch =
        !rosterSearch.trim() ||
        m.fullName?.toLowerCase().includes(rosterSearch.toLowerCase()) ||
        m.email?.toLowerCase().includes(rosterSearch.toLowerCase()) ||
        m.phone?.includes(rosterSearch);
      const matchDept =
        rosterDeptFilter === "ALL" || m.department === rosterDeptFilter;
      return matchSearch && matchDept;
    });
  }, [members, rosterSearch, rosterDeptFilter]);

  const handleUnbindMemberDevice = (member: ChurchMember) => {
    if (!organization?.id || unbindingMemberId) return;

    Alert.alert(
      "Unbind Worker Device",
      `Are you sure you want to release the device hardware lock for ${member.fullName}? They will be able to enroll on a new phone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Unbind Device",
          style: "default",
          onPress: async () => {
            setUnbindingMemberId(member.id);
            try {
              const docRef = doc(
                db,
                "churches",
                organization.id,
                "members",
                member.id
              );
              await updateDoc(docRef, { boundDeviceId: "UNBOUND" });
              toast.success(`Device lock released for ${member.fullName}.`);
            } catch (err: any) {
              console.error("Unbind error:", err);
              toast.error("Failed to release device lock.");
            } finally {
              setUnbindingMemberId(null);
            }
          },
        },
      ]
    );
  };

  const handleDeleteMember = (member: ChurchMember) => {
    if (!organization?.id) return;

    Alert.alert(
      "Remove Member",
      `Are you sure you want to remove ${member.fullName} from this organization? Their attendance history will remain archived.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: async () => {
            try {
              const docRef = doc(
                db,
                "churches",
                organization.id,
                "members",
                member.id
              );
              await deleteDoc(docRef);
              toast.success(`Removed ${member.fullName} from roster.`);
            } catch (err: any) {
              console.error("Delete member error:", err);
              toast.error("Failed to remove member.");
            }
          },
        },
      ]
    );
  };

  // ---------------------------------------------------------------------------
  // TAB 4: POLICY & SETTINGS
  // ---------------------------------------------------------------------------
  const [serviceDays, setServiceDays] = useState<(number | string)[]>(
    organization?.policySettings?.serviceDays || [1, 2, 3, 4, 5]
  );
  const [arrivalCutoff, setArrivalCutoff] = useState<string>(
    organization?.policySettings?.arrivalCutoff || "07:00"
  );
  const [lateTolerance, setLateTolerance] = useState<string>(
    organization?.policySettings?.lateTolerance || "07:30"
  );
  const [allowLateSignIn, setAllowLateSignIn] = useState<boolean>(
    organization?.policySettings?.allowLateSignIn ?? true
  );
  const [enableSignOut, setEnableSignOut] = useState<boolean>(
    organization?.policySettings?.enableSignOut ?? false
  );
  const [signOutTime, setSignOutTime] = useState<string>(
    organization?.policySettings?.signOutTime || "17:00"
  );
  const [isSavingPolicy, setIsSavingPolicy] = useState(false);

  const toggleServiceDay = (dayIndex: number) => {
    setServiceDays((prev) => {
      if (prev.includes(dayIndex)) {
        if (prev.length === 1) {
          toast.warn("At least one active service day is required.");
          return prev;
        }
        return prev.filter((d) => d !== dayIndex);
      } else {
        return [...prev, dayIndex].sort();
      }
    });
  };

  const handleSavePolicy = async () => {
    if (!organization?.id || isSavingPolicy) return;
    setIsSavingPolicy(true);

    try {
      const updatedPolicy: PolicySettings = {
        ...(organization.policySettings || {}),
        serviceDays,
        arrivalCutoff: arrivalCutoff.trim(),
        lateTolerance: lateTolerance.trim(),
        allowLateSignIn,
        enableSignOut,
        signOutTime: signOutTime.trim(),
      };

      const orgRef = doc(db, "churches", organization.id);
      await updateDoc(orgRef, { policySettings: updatedPolicy });
      await refreshOrganization();
      toast.success("Organization attendance policy updated successfully.");
    } catch (err: any) {
      console.error("Save policy error:", err);
      toast.error("Failed to update policy settings.");
    } finally {
      setIsSavingPolicy(false);
    }
  };

  const handleResetWorkspace = () => {
    if (!organization?.id) return;

    Alert.alert(
      "DANGER: Wipe Organization Workspace",
      "This action will permanently erase this entire organization workspace, including all anchors, registered workforce profiles, and attendance feeds. Type confirmation cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Wipe Workspace",
          style: "destructive",
          onPress: async () => {
            try {
              await deleteDoc(doc(db, "churches", organization.id));
              if (user?.email) {
                await deleteDoc(
                  doc(db, "account_roles", user.email.trim().toLowerCase())
                ).catch(() => {});
              }
              toast.info("Organization workspace purged.");
              await signOut();
            } catch (err: any) {
              console.error("Purge error:", err);
              toast.error("Failed to wipe workspace.");
            }
          },
        },
      ]
    );
  };

  const copyOrgCode = async () => {
    if (organization?.churchCode) {
      await Clipboard.setStringAsync(organization.churchCode);
      toast.success(
        `Copied Organization Code "${organization.churchCode}" to clipboard!`
      );
    }
  };

  const handlePullRefresh = async () => {
    setRefreshing(true);
    await refreshOrganization().catch(() => {});
    setRefreshing(false);
  };

  // ---------------------------------------------------------------------------
  // RENDER
  // ---------------------------------------------------------------------------
  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      {/* Top Admin Header */}
      <View style={styles.headerBar}>
        <View style={styles.headerLeft}>
          <View style={styles.adminBadgeRow}>
            <View style={styles.adminPill}>
              <View style={styles.greenPulse} />
              <Text style={styles.adminPillText}>ADMIN COMMAND</Text>
            </View>
            <TouchableOpacity
              onPress={copyOrgCode}
              style={styles.orgCodePill}
              activeOpacity={0.7}
            >
              <Text style={styles.orgCodeLabel}>CODE:</Text>
              <Text style={styles.orgCodeText}>
                {organization?.churchCode || "NO-CODE"}
              </Text>
              <Ionicons name="copy-outline" size={11} color="#2563EB" />
            </TouchableOpacity>
          </View>
          <Text style={styles.headerOrgName} numberOfLines={1}>
            {organization?.churchName || "Organization Workspace"}
          </Text>
          <Text style={styles.headerBranchName} numberOfLines={1}>
            {organization?.branchName || "Main Campus"}
          </Text>
        </View>

        <View style={styles.headerRight}>
          <TouchableOpacity
            style={styles.signOutBtn}
            onPress={() => {
              Alert.alert("Sign Out", "Sign out of Admin Command Center?", [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Sign Out",
                  style: "destructive",
                  onPress: () => signOut(),
                },
              ]);
            }}
          >
            <Ionicons name="log-out-outline" size={18} color="#ef4444" />
          </TouchableOpacity>
        </View>
      </View>

      {/* Main Tab Content */}
      <ScrollView
        style={styles.contentScroll}
        contentContainerStyle={styles.contentInner}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handlePullRefresh}
            tintColor="#2563EB"
          />
        }
      >
        {/* ================================================================= */}
        {/* TAB 1: LIVE ATTENDANCE FEED */}
        {/* ================================================================= */}
        {activeTab === "feed" && (
          <View style={styles.tabSection}>
            {/* Metrics Grid */}
            <View style={styles.metricsGrid}>
              <View style={styles.metricCard}>
                <Text style={styles.metricLabel}>CHECKED IN TODAY</Text>
                <Text style={styles.metricValue}>{todayRecords.length}</Text>
                <Text style={styles.metricSub}>Active Live Stream</Text>
              </View>

              <View style={styles.metricCard}>
                <Text style={styles.metricLabel}>PUNCTUALITY</Text>
                <Text
                  style={[
                    styles.metricValue,
                    {
                      color:
                        punctualityRate >= 80
                          ? "#059669"
                          : punctualityRate >= 50
                          ? "#d97706"
                          : "#dc2626",
                    },
                  ]}
                >
                  {punctualityRate}%
                </Text>
                <Text style={styles.metricSub}>
                  {onTimeCount} on-time · {lateCount} late
                </Text>
              </View>
            </View>

            {/* Feed Controls */}
            <View style={styles.feedControlsRow}>
              <View style={styles.searchInputWrapper}>
                <Ionicons
                  name="search-outline"
                  size={16}
                  color="#94a3b8"
                  style={styles.searchIcon}
                />
                <TextInput
                  style={styles.searchInput}
                  placeholder="Search team member..."
                  placeholderTextColor="#94a3b8"
                  value={feedSearch}
                  onChangeText={setFeedSearch}
                />
              </View>

              <TouchableOpacity
                style={styles.clearFeedBtn}
                onPress={handleClearFeed}
                disabled={isClearingFeed || todayRecords.length === 0}
              >
                {isClearingFeed ? (
                  <ActivityIndicator size="small" color="#dc2626" />
                ) : (
                  <>
                    <Ionicons name="trash-outline" size={14} color="#dc2626" />
                    <Text style={styles.clearFeedText}>CLEAR</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>

            {/* Department Filter Chips */}
            {organization?.departments && organization.departments.length > 0 && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.deptScroller}
                contentContainerStyle={styles.deptScrollerContent}
              >
                <TouchableOpacity
                  style={[
                    styles.deptChip,
                    selectedDeptFilter === "ALL" && styles.deptChipActive,
                  ]}
                  onPress={() => setSelectedDeptFilter("ALL")}
                >
                  <Text
                    style={[
                      styles.deptChipText,
                      selectedDeptFilter === "ALL" && styles.deptChipTextActive,
                    ]}
                  >
                    ALL DEPARTMENTS ({todayRecords.length})
                  </Text>
                </TouchableOpacity>

                {organization.departments.map((dept) => {
                  const count = todayRecords.filter(
                    (r) => r.department === dept
                  ).length;
                  const isSelected = selectedDeptFilter === dept;
                  return (
                    <TouchableOpacity
                      key={dept}
                      style={[
                        styles.deptChip,
                        isSelected && styles.deptChipActive,
                      ]}
                      onPress={() => setSelectedDeptFilter(dept)}
                    >
                      <Text
                        style={[
                          styles.deptChipText,
                          isSelected && styles.deptChipTextActive,
                        ]}
                      >
                        {dept} ({count})
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}

            {/* Feed Stream List */}
            {isAttendanceLoading ? (
              <View style={styles.emptyContainer}>
                <ActivityIndicator size="large" color="#2563EB" />
                <Text style={styles.emptySub}>Connecting to live feed...</Text>
              </View>
            ) : filteredFeedRecords.length === 0 ? (
              <View style={styles.emptyContainer}>
                <Ionicons name="radio-outline" size={44} color="#cbd5e1" />
                <Text style={styles.emptyTitle}>No Clock-Ins Recorded Yet</Text>
                <Text style={styles.emptySub}>
                  When workforce members punch in from the mobile app within
                  premises, live arrivals stream here in real time.
                </Text>
              </View>
            ) : (
              <View style={styles.feedList}>
                {filteredFeedRecords.map((item) => {
                  const punchDate = new Date(item.punchedAt);
                  const punchTime = !isNaN(punchDate.getTime())
                    ? punchDate.toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })
                    : item.punchedAt;

                  const isOnTime = item.status === "ON_TIME";

                  return (
                    <View key={item.id} style={styles.feedCard}>
                      <View style={styles.feedCardTop}>
                        <View style={styles.memberAvatar}>
                          <Text style={styles.memberAvatarText}>
                            {item.memberName?.[0]?.toUpperCase() || "M"}
                          </Text>
                        </View>

                        <View style={styles.feedMemberInfo}>
                          <Text style={styles.feedMemberName}>
                            {item.memberName}
                          </Text>
                          <Text style={styles.feedMemberDept}>
                            {item.department || "General Workforce"}
                          </Text>
                        </View>

                        <View
                          style={[
                            styles.statusBadge,
                            isOnTime
                              ? styles.statusBadgeOnTime
                              : styles.statusBadgeLate,
                          ]}
                        >
                          <Text
                            style={[
                              styles.statusBadgeText,
                              isOnTime
                                ? styles.statusBadgeTextOnTime
                                : styles.statusBadgeTextLate,
                            ]}
                          >
                            {isOnTime ? "ON TIME" : "LATE"}
                          </Text>
                        </View>
                      </View>

                      <View style={styles.feedCardBottom}>
                        <View style={styles.feedDetailItem}>
                          <Ionicons
                            name="time-outline"
                            size={13}
                            color="#64748b"
                          />
                          <Text style={styles.feedDetailText}>
                            Clock-In: <strong>{punchTime}</strong>
                          </Text>
                        </View>

                        <View style={styles.feedDetailItem}>
                          <Ionicons
                            name={
                              item.verificationMethod === "WIFI_BSSID"
                                ? "wifi-outline"
                                : "navigate-outline"
                            }
                            size={13}
                            color="#64748b"
                          />
                          <Text style={styles.feedDetailText}>
                            {item.verificationMethod === "WIFI_BSSID"
                              ? "Wi-Fi Anchor"
                              : "GPS Geofence"}
                          </Text>
                        </View>
                      </View>
                    </View>
                  );
                })}
              </View>
            )}
          </View>
        )}

        {/* ================================================================= */}
        {/* TAB 2: PRESENCE ANCHORS & DIRECT CALIBRATION */}
        {/* ================================================================= */}
        {activeTab === "anchors" && (
          <View style={styles.tabSection}>
            <View style={styles.infoBanner}>
              <Ionicons
                name="shield-checkmark-outline"
                size={20}
                color="#2563EB"
              />
              <View style={{ flex: 1 }}>
                <Text style={styles.infoBannerTitle}>
                  Direct On-Site Hardware Calibration
                </Text>
                <Text style={styles.infoBannerSub}>
                  Because you are logged in as Administrator, this phone
                  calibrates physical Wi-Fi &amp; GPS anchors directly. No QR
                  code scan required!
                </Text>
              </View>
            </View>

            {/* Architecture Mode Toggle */}
            <View style={styles.card}>
              <Text style={styles.cardHeader}>VERIFICATION ARCHITECTURE</Text>
              <View style={styles.modeToggleRow}>
                <TouchableOpacity
                  style={[
                    styles.modeToggleBtn,
                    calMode === "GEOFENCE_ONLY" && styles.modeToggleBtnActive,
                  ]}
                  onPress={() => setCalMode("GEOFENCE_ONLY")}
                >
                  <Ionicons
                    name="navigate-outline"
                    size={18}
                    color={calMode === "GEOFENCE_ONLY" ? "#ffffff" : "#475569"}
                  />
                  <Text
                    style={[
                      styles.modeToggleText,
                      calMode === "GEOFENCE_ONLY" && styles.modeToggleTextActive,
                    ]}
                  >
                    Router-Free GPS
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.modeToggleBtn,
                    calMode === "HYBRID" && styles.modeToggleBtnActive,
                  ]}
                  onPress={() => setCalMode("HYBRID")}
                >
                  <Ionicons
                    name="wifi-outline"
                    size={18}
                    color={calMode === "HYBRID" ? "#ffffff" : "#475569"}
                  />
                  <Text
                    style={[
                      styles.modeToggleText,
                      calMode === "HYBRID" && styles.modeToggleTextActive,
                    ]}
                  >
                    Office Wi-Fi (Hybrid)
                  </Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* Wi-Fi Calibration Section (if HYBRID) */}
            {calMode === "HYBRID" && (
              <View style={styles.card}>
                <View style={styles.cardHeaderRow}>
                  <Text style={styles.cardHeader}>OFFICE WI-FI ROUTER ANCHOR</Text>
                  <TouchableOpacity
                    style={styles.scanBtn}
                    onPress={handleScanWifi}
                    disabled={isScanningWifi}
                  >
                    {isScanningWifi ? (
                      <ActivityIndicator size="small" color="#2563EB" />
                    ) : (
                      <>
                        <Ionicons name="refresh-outline" size={14} color="#2563EB" />
                        <Text style={styles.scanBtnText}>SCAN WI-FI</Text>
                      </>
                    )}
                  </TouchableOpacity>
                </View>

                {availableNetworks.length > 0 && (
                  <View style={styles.networkList}>
                    <Text style={styles.subLabel}>Tap a network to select:</Text>
                    {availableNetworks.map((net, idx) => {
                      const isSelected =
                        targetBssid.toLowerCase() === net.bssid.toLowerCase();
                      return (
                        <TouchableOpacity
                          key={`${net.bssid}-${idx}`}
                          style={[
                            styles.networkItem,
                            isSelected && styles.networkItemSelected,
                          ]}
                          onPress={() => handleSelectNetwork(net)}
                        >
                          <Ionicons
                            name="wifi"
                            size={16}
                            color={isSelected ? "#2563EB" : "#64748b"}
                          />
                          <View style={{ flex: 1 }}>
                            <Text style={styles.networkSsid}>{net.ssid}</Text>
                            <Text style={styles.networkBssid}>{net.bssid}</Text>
                          </View>
                          {isSelected && (
                            <Ionicons
                              name="checkmark-circle"
                              size={18}
                              color="#2563EB"
                            />
                          )}
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                )}

                <View style={styles.formGroup}>
                  <Text style={styles.inputLabel}>TARGET ROUTER BSSID (MAC)</Text>
                  <TextInput
                    style={styles.textInput}
                    placeholder="e.g. 0c:61:f9:65:8f:07"
                    placeholderTextColor="#94a3b8"
                    value={targetBssid}
                    onChangeText={setTargetBssid}
                    autoCapitalize="none"
                  />
                </View>

                <View style={styles.formGroup}>
                  <Text style={styles.inputLabel}>NETWORK SSID HINT</Text>
                  <TextInput
                    style={styles.textInput}
                    placeholder="e.g. OfficeCorp-5G"
                    placeholderTextColor="#94a3b8"
                    value={ssidHint}
                    onChangeText={setSsidHint}
                  />
                </View>
              </View>
            )}

            {/* GPS Geofence Section */}
            <View style={styles.card}>
              <View style={styles.cardHeaderRow}>
                <Text style={styles.cardHeader}>SATELLITE GPS GEOFENCE</Text>
                <TouchableOpacity
                  style={styles.scanBtn}
                  onPress={handlePinpointGps}
                  disabled={isLocatingGps}
                >
                  {isLocatingGps ? (
                    <ActivityIndicator size="small" color="#2563EB" />
                  ) : (
                    <>
                      <Ionicons name="locate-outline" size={14} color="#2563EB" />
                      <Text style={styles.scanBtnText}>PINPOINT MY GPS</Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>

              {/* Leaflet Satellite Map Preview */}
              <View style={styles.mapContainer}>
                <PresenceMapMobile
                  latitude={latitude}
                  longitude={longitude}
                  radiusMeters={radiusMeters}
                  onCoordinatesChange={(lat, lng) => {
                    setLatitude(lat);
                    setLongitude(lng);
                  }}
                  height={220}
                />
              </View>

              {/* Radius Options */}
              <View style={styles.formGroup}>
                <Text style={styles.inputLabel}>
                  PREMISES BOUNDARY RADIUS: {radiusMeters} METERS
                </Text>
                <View style={styles.radiusPillRow}>
                  {RADIUS_OPTIONS.map((r) => (
                    <TouchableOpacity
                      key={r}
                      style={[
                        styles.radiusPill,
                        radiusMeters === r && styles.radiusPillActive,
                      ]}
                      onPress={() => setRadiusMeters(r)}
                    >
                      <Text
                        style={[
                          styles.radiusPillText,
                          radiusMeters === r && styles.radiusPillTextActive,
                        ]}
                      >
                        {r}m
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              <View style={styles.coordDisplayRow}>
                <View style={styles.coordBox}>
                  <Text style={styles.coordBoxLabel}>LATITUDE</Text>
                  <Text style={styles.coordBoxValue}>{latitude.toFixed(6)}</Text>
                </View>
                <View style={styles.coordBox}>
                  <Text style={styles.coordBoxLabel}>LONGITUDE</Text>
                  <Text style={styles.coordBoxValue}>{longitude.toFixed(6)}</Text>
                </View>
              </View>
            </View>

            {/* Save Button */}
            <TouchableOpacity
              style={styles.primaryActionBtn}
              onPress={handleSaveAnchors}
              disabled={isSavingAnchors}
            >
              {isSavingAnchors ? (
                <ActivityIndicator size="small" color="#ffffff" />
              ) : (
                <>
                  <Ionicons name="save-outline" size={18} color="#ffffff" />
                  <Text style={styles.primaryActionBtnText}>
                    SAVE PRESENCE ANCHORS
                  </Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        )}

        {/* ================================================================= */}
        {/* TAB 3: WORKFORCE ROSTER */}
        {/* ================================================================= */}
        {activeTab === "roster" && (
          <View style={styles.tabSection}>
            {/* Search Input */}
            <View style={styles.searchInputWrapper}>
              <Ionicons
                name="search-outline"
                size={16}
                color="#94a3b8"
                style={styles.searchIcon}
              />
              <TextInput
                style={styles.searchInput}
                placeholder="Search worker by name, email, phone..."
                placeholderTextColor="#94a3b8"
                value={rosterSearch}
                onChangeText={setRosterSearch}
              />
            </View>

            {/* Department Chips */}
            {organization?.departments && organization.departments.length > 0 && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.deptScroller}
                contentContainerStyle={styles.deptScrollerContent}
              >
                <TouchableOpacity
                  style={[
                    styles.deptChip,
                    rosterDeptFilter === "ALL" && styles.deptChipActive,
                  ]}
                  onPress={() => setRosterDeptFilter("ALL")}
                >
                  <Text
                    style={[
                      styles.deptChipText,
                      rosterDeptFilter === "ALL" && styles.deptChipTextActive,
                    ]}
                  >
                    ALL MEMBERS ({members.length})
                  </Text>
                </TouchableOpacity>

                {organization.departments.map((dept) => {
                  const count = members.filter(
                    (m) => m.department === dept
                  ).length;
                  const isSelected = rosterDeptFilter === dept;
                  return (
                    <TouchableOpacity
                      key={dept}
                      style={[
                        styles.deptChip,
                        isSelected && styles.deptChipActive,
                      ]}
                      onPress={() => setRosterDeptFilter(dept)}
                    >
                      <Text
                        style={[
                          styles.deptChipText,
                          isSelected && styles.deptChipTextActive,
                        ]}
                      >
                        {dept} ({count})
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}

            {/* Members List */}
            {isMembersLoading ? (
              <View style={styles.emptyContainer}>
                <ActivityIndicator size="large" color="#2563EB" />
                <Text style={styles.emptySub}>Loading workforce roster...</Text>
              </View>
            ) : filteredMembers.length === 0 ? (
              <View style={styles.emptyContainer}>
                <Ionicons name="people-outline" size={44} color="#cbd5e1" />
                <Text style={styles.emptyTitle}>No Workers Enrolled</Text>
                <Text style={styles.emptySub}>
                  Workers pair via the mobile app using Organization Code "
                  {organization?.churchCode}".
                </Text>
              </View>
            ) : (
              <View style={styles.feedList}>
                {filteredMembers.map((member) => {
                  const isUnbound =
                    !member.boundDeviceId || member.boundDeviceId === "UNBOUND";
                  const isUnbinding = unbindingMemberId === member.id;

                  return (
                    <View key={member.id} style={styles.memberCard}>
                      <View style={styles.memberCardHeader}>
                        <View style={styles.memberAvatar}>
                          <Text style={styles.memberAvatarText}>
                            {member.fullName?.[0]?.toUpperCase() || "W"}
                          </Text>
                        </View>

                        <View style={styles.memberMainInfo}>
                          <Text style={styles.memberName}>{member.fullName}</Text>
                          <Text style={styles.memberDept}>
                            {member.department || "General Workforce"}
                          </Text>
                          {member.email && (
                            <Text style={styles.memberContact}>{member.email}</Text>
                          )}
                          {member.phone && (
                            <Text style={styles.memberContact}>{member.phone}</Text>
                          )}
                        </View>

                        <TouchableOpacity
                          style={styles.deleteMemberBtn}
                          onPress={() => handleDeleteMember(member)}
                        >
                          <Ionicons
                            name="trash-outline"
                            size={16}
                            color="#94a3b8"
                          />
                        </TouchableOpacity>
                      </View>

                      {/* Device Binding Status & Unbind Button */}
                      <View style={styles.deviceStatusRow}>
                        <View
                          style={[
                            styles.devicePill,
                            isUnbound
                              ? styles.devicePillUnbound
                              : styles.devicePillBound,
                          ]}
                        >
                          <Ionicons
                            name={
                              isUnbound
                                ? "lock-open-outline"
                                : "phone-portrait-outline"
                            }
                            size={12}
                            color={isUnbound ? "#059669" : "#2563EB"}
                          />
                          <Text
                            style={[
                              styles.devicePillText,
                              isUnbound
                                ? styles.devicePillTextUnbound
                                : styles.devicePillTextBound,
                            ]}
                          >
                            {isUnbound ? "DEVICE UNBOUND" : "DEVICE LOCKED"}
                          </Text>
                        </View>

                        {!isUnbound && (
                          <TouchableOpacity
                            style={styles.unbindBtn}
                            onPress={() => handleUnbindMemberDevice(member)}
                            disabled={isUnbinding}
                          >
                            {isUnbinding ? (
                              <ActivityIndicator size="small" color="#d97706" />
                            ) : (
                              <>
                                <Ionicons
                                  name="refresh-outline"
                                  size={12}
                                  color="#d97706"
                                />
                                <Text style={styles.unbindBtnText}>
                                  RELEASE LOCK
                                </Text>
                              </>
                            )}
                          </TouchableOpacity>
                        )}
                      </View>
                    </View>
                  );
                })}
              </View>
            )}
          </View>
        )}

        {/* ================================================================= */}
        {/* TAB 4: ORGANIZATION POLICY & SETTINGS */}
        {/* ================================================================= */}
        {activeTab === "policy" && (
          <View style={styles.tabSection}>
            {/* Organization Identity Card */}
            <View style={styles.card}>
              <Text style={styles.cardHeader}>ORGANIZATION WORKSPACE</Text>
              <Text style={styles.cardTitle}>{organization?.churchName}</Text>
              <Text style={styles.cardSub}>{organization?.branchName}</Text>

              <TouchableOpacity
                style={styles.orgCodeBanner}
                onPress={copyOrgCode}
                activeOpacity={0.8}
              >
                <View>
                  <Text style={styles.orgCodeBannerLabel}>
                    WORKFORCE ENROLLMENT CODE
                  </Text>
                  <Text style={styles.orgCodeBannerCode}>
                    {organization?.churchCode}
                  </Text>
                </View>
                <Ionicons name="copy-outline" size={20} color="#2563EB" />
              </TouchableOpacity>
            </View>

            {/* Schedule Configuration Card */}
            <View style={styles.card}>
              <Text style={styles.cardHeader}>ACTIVE SERVICE / WORK DAYS</Text>
              <Text style={styles.subLabel}>
                Workers can punch in on selected days:
              </Text>

              <View style={styles.dayPillsRow}>
                {DAY_LABELS.map((label, idx) => {
                  const isActive = serviceDays.includes(idx);
                  return (
                    <TouchableOpacity
                      key={label}
                      style={[
                        styles.dayPill,
                        isActive && styles.dayPillActive,
                      ]}
                      onPress={() => toggleServiceDay(idx)}
                    >
                      <Text
                        style={[
                          styles.dayPillText,
                          isActive && styles.dayPillTextActive,
                        ]}
                      >
                        {label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* Arrival Times */}
              <View style={styles.formGroup}>
                <Text style={styles.inputLabel}>
                  CALL-UP / WINDOW OPEN TIME (24H)
                </Text>
                <TextInput
                  style={styles.textInput}
                  placeholder="07:00"
                  placeholderTextColor="#94a3b8"
                  value={arrivalCutoff}
                  onChangeText={setArrivalCutoff}
                />
              </View>

              <View style={styles.formGroup}>
                <Text style={styles.inputLabel}>
                  LATE TOLERANCE / CUTOFF TIME (24H)
                </Text>
                <TextInput
                  style={styles.textInput}
                  placeholder="07:30"
                  placeholderTextColor="#94a3b8"
                  value={lateTolerance}
                  onChangeText={setLateTolerance}
                />
              </View>

              {/* Late Sign-In Toggle */}
              <TouchableOpacity
                style={styles.toggleRow}
                onPress={() => setAllowLateSignIn(!allowLateSignIn)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.toggleTitle}>Allow Late Check-Ins</Text>
                  <Text style={styles.toggleSub}>
                    Workers arriving past cutoff are marked LATE instead of blocked.
                  </Text>
                </View>
                <Ionicons
                  name={allowLateSignIn ? "checkbox" : "square-outline"}
                  size={24}
                  color={allowLateSignIn ? "#2563EB" : "#94a3b8"}
                />
              </TouchableOpacity>

              {/* Sign-Out Policy Toggle */}
              <TouchableOpacity
                style={styles.toggleRow}
                onPress={() => setEnableSignOut(!enableSignOut)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.toggleTitle}>Require Sign-Out</Text>
                  <Text style={styles.toggleSub}>
                    Workers record departure punch starting from designated time.
                  </Text>
                </View>
                <Ionicons
                  name={enableSignOut ? "checkbox" : "square-outline"}
                  size={24}
                  color={enableSignOut ? "#2563EB" : "#94a3b8"}
                />
              </TouchableOpacity>

              {enableSignOut && (
                <View style={styles.formGroup}>
                  <Text style={styles.inputLabel}>
                    SIGN-OUT START TIME (24H)
                  </Text>
                  <TextInput
                    style={styles.textInput}
                    placeholder="17:00"
                    placeholderTextColor="#94a3b8"
                    value={signOutTime}
                    onChangeText={setSignOutTime}
                  />
                </View>
              )}

              <TouchableOpacity
                style={styles.primaryActionBtn}
                onPress={handleSavePolicy}
                disabled={isSavingPolicy}
              >
                {isSavingPolicy ? (
                  <ActivityIndicator size="small" color="#ffffff" />
                ) : (
                  <>
                    <Ionicons name="save-outline" size={18} color="#ffffff" />
                    <Text style={styles.primaryActionBtnText}>
                      SAVE POLICY SETTINGS
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            </View>

            {/* Danger Zone */}
            <View style={[styles.card, styles.dangerCard]}>
              <Text style={[styles.cardHeader, { color: "#dc2626" }]}>
                DANGER ZONE
              </Text>
              <Text style={styles.dangerDesc}>
                Purging the organization workspace deletes all anchor profiles,
                registered workforce members, and attendance feeds permanently.
              </Text>

              <TouchableOpacity
                style={styles.dangerBtn}
                onPress={handleResetWorkspace}
              >
                <Ionicons name="trash-outline" size={16} color="#ffffff" />
                <Text style={styles.dangerBtnText}>WIPE WORKSPACE</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </ScrollView>

      {/* Bottom Navigation Tabs */}
      <View style={styles.bottomNav}>
        <TouchableOpacity
          style={[styles.navTab, activeTab === "feed" && styles.navTabActive]}
          onPress={() => setActiveTab("feed")}
        >
          <Ionicons
            name={activeTab === "feed" ? "pulse" : "pulse-outline"}
            size={22}
            color={activeTab === "feed" ? "#2563EB" : "#64748b"}
          />
          <Text
            style={[
              styles.navTabText,
              activeTab === "feed" && styles.navTabTextActive,
            ]}
          >
            Live Feed
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.navTab, activeTab === "anchors" && styles.navTabActive]}
          onPress={() => setActiveTab("anchors")}
        >
          <Ionicons
            name={activeTab === "anchors" ? "radio" : "radio-outline"}
            size={22}
            color={activeTab === "anchors" ? "#2563EB" : "#64748b"}
          />
          <Text
            style={[
              styles.navTabText,
              activeTab === "anchors" && styles.navTabTextActive,
            ]}
          >
            Anchors
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.navTab, activeTab === "roster" && styles.navTabActive]}
          onPress={() => setActiveTab("roster")}
        >
          <Ionicons
            name={activeTab === "roster" ? "people" : "people-outline"}
            size={22}
            color={activeTab === "roster" ? "#2563EB" : "#64748b"}
          />
          <Text
            style={[
              styles.navTabText,
              activeTab === "roster" && styles.navTabTextActive,
            ]}
          >
            Roster
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.navTab, activeTab === "policy" && styles.navTabActive]}
          onPress={() => setActiveTab("policy")}
        >
          <Ionicons
            name={activeTab === "policy" ? "settings" : "settings-outline"}
            size={22}
            color={activeTab === "policy" ? "#2563EB" : "#64748b"}
          />
          <Text
            style={[
              styles.navTabText,
              activeTab === "policy" && styles.navTabTextActive,
            ]}
          >
            Policy
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f8fafc",
  },
  headerBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: "#ffffff",
    borderBottomWidth: 1,
    borderBottomColor: "#e2e8f0",
  },
  headerLeft: {
    flex: 1,
  },
  headerRight: {
    marginLeft: 12,
  },
  adminBadgeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 4,
  },
  adminPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "#eff6ff",
    borderWidth: 1,
    borderColor: "#bfdbfe",
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 2,
  },
  greenPulse: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#10b981",
  },
  adminPillText: {
    fontSize: 9,
    fontWeight: "800",
    color: "#1d4ed8",
    letterSpacing: 0.5,
  },
  orgCodePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#f1f5f9",
    borderWidth: 1,
    borderColor: "#cbd5e1",
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 2,
  },
  orgCodeLabel: {
    fontSize: 9,
    fontWeight: "700",
    color: "#64748b",
  },
  orgCodeText: {
    fontSize: 10,
    fontWeight: "800",
    color: "#0f172a",
    fontFamily: Platform.OS === "ios" ? "Courier" : "monospace",
  },
  headerOrgName: {
    fontSize: 16,
    fontWeight: "800",
    color: "#0f172a",
    letterSpacing: -0.3,
  },
  headerBranchName: {
    fontSize: 12,
    color: "#64748b",
    marginTop: 1,
  },
  signOutBtn: {
    padding: 8,
    borderRadius: 6,
    backgroundColor: "#fee2e2",
  },
  contentScroll: {
    flex: 1,
  },
  contentInner: {
    padding: 16,
    paddingBottom: 32,
  },
  tabSection: {
    gap: 16,
  },
  metricsGrid: {
    flexDirection: "row",
    gap: 12,
  },
  metricCard: {
    flex: 1,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e2e8f0",
    padding: 14,
    borderRadius: 6,
  },
  metricLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: "#64748b",
    letterSpacing: 0.5,
  },
  metricValue: {
    fontSize: 26,
    fontWeight: "800",
    color: "#0f172a",
    marginVertical: 4,
    letterSpacing: -0.5,
  },
  metricSub: {
    fontSize: 11,
    color: "#94a3b8",
  },
  feedControlsRow: {
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
  },
  searchInputWrapper: {
    flex: 1,
    position: "relative",
    justifyContent: "center",
  },
  searchIcon: {
    position: "absolute",
    left: 10,
    zIndex: 1,
  },
  searchInput: {
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e2e8f0",
    borderRadius: 4,
    paddingLeft: 34,
    paddingRight: 12,
    height: 40,
    fontSize: 13,
    color: "#0f172a",
  },
  clearFeedBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#fee2e2",
    borderWidth: 1,
    borderColor: "#fca5a5",
    paddingHorizontal: 12,
    height: 40,
    borderRadius: 4,
  },
  clearFeedText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#dc2626",
    letterSpacing: 0.4,
  },
  deptScroller: {
    flexGrow: 0,
  },
  deptScrollerContent: {
    gap: 6,
  },
  deptChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e2e8f0",
    borderRadius: 4,
  },
  deptChipActive: {
    backgroundColor: "#1e293b",
    borderColor: "#1e293b",
  },
  deptChipText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#475569",
    letterSpacing: 0.3,
  },
  deptChipTextActive: {
    color: "#ffffff",
  },
  feedList: {
    gap: 10,
  },
  feedCard: {
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e2e8f0",
    borderRadius: 6,
    padding: 12,
    gap: 10,
  },
  feedCardTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  memberAvatar: {
    width: 36,
    height: 36,
    borderRadius: 4,
    backgroundColor: "#1e293b",
    alignItems: "center",
    justifyContent: "center",
  },
  memberAvatarText: {
    color: "#ffffff",
    fontWeight: "700",
    fontSize: 15,
  },
  feedMemberInfo: {
    flex: 1,
  },
  feedMemberName: {
    fontSize: 14,
    fontWeight: "700",
    color: "#0f172a",
  },
  feedMemberDept: {
    fontSize: 11,
    color: "#64748b",
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 3,
  },
  statusBadgeOnTime: {
    backgroundColor: "#dcfce7",
    borderWidth: 1,
    borderColor: "#86efac",
  },
  statusBadgeLate: {
    backgroundColor: "#fef3c7",
    borderWidth: 1,
    borderColor: "#fcd34d",
  },
  statusBadgeText: {
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.4,
  },
  statusBadgeTextOnTime: {
    color: "#15803d",
  },
  statusBadgeTextLate: {
    color: "#b45309",
  },
  feedCardBottom: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: "#f1f5f9",
    paddingTop: 8,
  },
  feedDetailItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  feedDetailText: {
    fontSize: 11,
    color: "#64748b",
  },
  card: {
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e2e8f0",
    borderRadius: 6,
    padding: 16,
    gap: 12,
  },
  cardHeader: {
    fontSize: 11,
    fontWeight: "800",
    color: "#64748b",
    letterSpacing: 0.6,
  },
  cardHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#0f172a",
  },
  cardSub: {
    fontSize: 13,
    color: "#64748b",
    marginTop: -8,
  },
  subLabel: {
    fontSize: 12,
    color: "#64748b",
  },
  infoBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    backgroundColor: "#eff6ff",
    borderWidth: 1,
    borderColor: "#bfdbfe",
    borderRadius: 6,
    padding: 12,
  },
  infoBannerTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#1e40af",
  },
  infoBannerSub: {
    fontSize: 11,
    color: "#3b82f6",
    marginTop: 2,
    lineHeight: 16,
  },
  modeToggleRow: {
    flexDirection: "row",
    gap: 8,
  },
  modeToggleBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    backgroundColor: "#f8fafc",
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 4,
  },
  modeToggleBtnActive: {
    backgroundColor: "#2563EB",
    borderColor: "#2563EB",
  },
  modeToggleText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#475569",
  },
  modeToggleTextActive: {
    color: "#ffffff",
  },
  scanBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#eff6ff",
    borderWidth: 1,
    borderColor: "#bfdbfe",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  scanBtnText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#2563EB",
    letterSpacing: 0.4,
  },
  formGroup: {
    gap: 6,
  },
  inputLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: "#64748b",
    letterSpacing: 0.4,
  },
  textInput: {
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 4,
    paddingHorizontal: 12,
    height: 40,
    fontSize: 13,
    color: "#0f172a",
    fontFamily: Platform.OS === "ios" ? "Courier" : "monospace",
  },
  networkList: {
    gap: 6,
    maxHeight: 180,
  },
  networkItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 8,
    backgroundColor: "#f8fafc",
    borderWidth: 1,
    borderColor: "#e2e8f0",
    borderRadius: 4,
  },
  networkItemSelected: {
    borderColor: "#2563EB",
    backgroundColor: "#eff6ff",
  },
  networkSsid: {
    fontSize: 12,
    fontWeight: "700",
    color: "#0f172a",
  },
  networkBssid: {
    fontSize: 10,
    color: "#64748b",
    fontFamily: Platform.OS === "ios" ? "Courier" : "monospace",
  },
  mapContainer: {
    borderRadius: 6,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  radiusPillRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  radiusPill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: "#f1f5f9",
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 4,
  },
  radiusPillActive: {
    backgroundColor: "#2563EB",
    borderColor: "#2563EB",
  },
  radiusPillText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#475569",
  },
  radiusPillTextActive: {
    color: "#ffffff",
  },
  coordDisplayRow: {
    flexDirection: "row",
    gap: 8,
  },
  coordBox: {
    flex: 1,
    padding: 8,
    backgroundColor: "#f8fafc",
    borderWidth: 1,
    borderColor: "#e2e8f0",
    borderRadius: 4,
  },
  coordBoxLabel: {
    fontSize: 9,
    fontWeight: "700",
    color: "#64748b",
  },
  coordBoxValue: {
    fontSize: 12,
    fontWeight: "700",
    color: "#0f172a",
    fontFamily: Platform.OS === "ios" ? "Courier" : "monospace",
    marginTop: 2,
  },
  primaryActionBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#2563EB",
    paddingVertical: 12,
    borderRadius: 4,
  },
  primaryActionBtnText: {
    color: "#ffffff",
    fontWeight: "700",
    fontSize: 13,
    letterSpacing: 0.5,
  },
  memberCard: {
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e2e8f0",
    borderRadius: 6,
    padding: 12,
    gap: 10,
  },
  memberCardHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  memberMainInfo: {
    flex: 1,
  },
  memberName: {
    fontSize: 14,
    fontWeight: "700",
    color: "#0f172a",
  },
  memberDept: {
    fontSize: 11,
    color: "#64748b",
    marginTop: 1,
  },
  memberContact: {
    fontSize: 11,
    color: "#94a3b8",
  },
  deleteMemberBtn: {
    padding: 6,
  },
  deviceStatusRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: "#f1f5f9",
    paddingTop: 8,
  },
  devicePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 3,
  },
  devicePillBound: {
    backgroundColor: "#eff6ff",
    borderWidth: 1,
    borderColor: "#bfdbfe",
  },
  devicePillUnbound: {
    backgroundColor: "#dcfce7",
    borderWidth: 1,
    borderColor: "#86efac",
  },
  devicePillText: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.4,
  },
  devicePillTextBound: {
    color: "#1d4ed8",
  },
  devicePillTextUnbound: {
    color: "#15803d",
  },
  unbindBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#fef3c7",
    borderWidth: 1,
    borderColor: "#fcd34d",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 3,
  },
  unbindBtnText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#b45309",
    letterSpacing: 0.4,
  },
  orgCodeBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#eff6ff",
    borderWidth: 1,
    borderColor: "#bfdbfe",
    borderRadius: 4,
    padding: 12,
  },
  orgCodeBannerLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: "#3b82f6",
    letterSpacing: 0.5,
  },
  orgCodeBannerCode: {
    fontSize: 18,
    fontWeight: "800",
    color: "#1d4ed8",
    fontFamily: Platform.OS === "ios" ? "Courier" : "monospace",
    marginTop: 2,
  },
  dayPillsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  dayPill: {
    width: 40,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#f1f5f9",
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 4,
  },
  dayPillActive: {
    backgroundColor: "#2563EB",
    borderColor: "#2563EB",
  },
  dayPillText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#475569",
  },
  dayPillTextActive: {
    color: "#ffffff",
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 8,
  },
  toggleTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#0f172a",
  },
  toggleSub: {
    fontSize: 11,
    color: "#64748b",
    marginTop: 2,
  },
  dangerCard: {
    borderColor: "#fca5a5",
    backgroundColor: "#fff5f5",
  },
  dangerDesc: {
    fontSize: 12,
    color: "#b91c1c",
    lineHeight: 16,
  },
  dangerBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: "#dc2626",
    paddingVertical: 10,
    borderRadius: 4,
  },
  dangerBtnText: {
    color: "#ffffff",
    fontWeight: "700",
    fontSize: 12,
    letterSpacing: 0.5,
  },
  emptyContainer: {
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
    gap: 8,
  },
  emptyTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: "#334155",
  },
  emptySub: {
    fontSize: 12,
    color: "#94a3b8",
    textAlign: "center",
    maxWidth: 280,
    lineHeight: 18,
  },
  bottomNav: {
    flexDirection: "row",
    backgroundColor: "#ffffff",
    borderTopWidth: 1,
    borderTopColor: "#e2e8f0",
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  navTab: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
    paddingVertical: 4,
  },
  navTabActive: {},
  navTabText: {
    fontSize: 10,
    fontWeight: "600",
    color: "#64748b",
  },
  navTabTextActive: {
    color: "#2563EB",
    fontWeight: "700",
  },
});
