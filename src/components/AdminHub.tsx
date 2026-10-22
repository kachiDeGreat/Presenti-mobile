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
  Vibration,
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
import { reverseGeocodeCoords } from "../services/geocodingService";

const RADIUS_OPTIONS = [
  { value: 10, label: "10m", desc: "Executive Room" },
  { value: 20, label: "20m", desc: "Standard Suite" },
  { value: 30, label: "30m", desc: "Main Hall / Venue" },
  { value: 50, label: "50m", desc: "Medium Compound" },
  { value: 80, label: "80m", desc: "Large Grounds" },
  { value: 100, label: "100m", desc: "Open Campus" },
];

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
  const { organization, refreshOrganization, signOut } = useAuth();
  const toast = useToast();

  // Navigation: Only 2 core tabs on mobile
  const [activeTab, setActiveTab] = useState<"feed" | "anchors">("feed");
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

  const departmentList = useMemo(() => {
    const set = new Set<string>();
    todayRecords.forEach((r) => {
      if (r.department && r.department.trim()) {
        set.add(r.department.trim());
      }
    });
    return ["ALL", ...Array.from(set)];
  }, [todayRecords]);

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
      "Clear Today's Attendance Feed",
      "Are you sure you want to permanently clear today's attendance records from the cloud database? This action cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear Cloud Records",
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
  // TAB 2: HARDWARE PRESENCE ANCHORS & DIRECT MOBILE CALIBRATION
  // ---------------------------------------------------------------------------
  const [calMode, setCalMode] = useState<"GEOFENCE_ONLY" | "HYBRID">(
    organization?.beaconConfig?.verificationMode === "HYBRID"
      ? "HYBRID"
      : "GEOFENCE_ONLY"
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
    organization?.geoFallback?.radiusMeters || 20
  );
  const [locationAddress, setLocationAddress] = useState<string>("");
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);

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

  // Reverse geocode venue label
  useEffect(() => {
    if (latitude && longitude && latitude !== 0 && longitude !== 0) {
      reverseGeocodeCoords(latitude, longitude)
        .then((addr) => {
          if (addr?.displayName) {
            setLocationAddress(addr.displayName);
          } else if (addr?.name) {
            setLocationAddress(addr.name);
          }
        })
        .catch(() => {});
    }
  }, [latitude, longitude]);

  const isCalibrated = Boolean(
    organization?.isCalibrated ||
    organization?.geoFallback?.isCalibrated ||
    (organization?.geoFallback?.latitude && organization?.geoFallback?.longitude) ||
    (latitude !== 0 && longitude !== 0 && radiusMeters > 0)
  );

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
      setGpsAccuracy(Math.round(pos.coords.accuracy || 5));
      Vibration.vibrate(50);
      toast.success(
        `GPS Pinpointed: ±${Math.round(pos.coords.accuracy || 5)}m high-accuracy fix.`
      );
    } catch (err: any) {
      console.warn("GPS acquire error:", err);
      toast.error("Could not capture GPS location from phone sensors.");
    } finally {
      setIsLocatingGps(false);
    }
  };

  const handleSaveAnchors = async () => {
    if (!organization?.id || isSavingAnchors) return;

    if (calMode === "HYBRID" && !targetBssid.trim()) {
      toast.warn("Please scan or enter an office Wi-Fi router BSSID MAC address.");
      return;
    }
    if (latitude === 0 && longitude === 0) {
      toast.warn("Please pinpoint on-site GPS coordinates first.");
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
      Vibration.vibrate([0, 80, 40, 80]);
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

  const copyOrgCode = async () => {
    if (!organization?.churchCode) return;
    await Clipboard.setStringAsync(organization.churchCode);
    toast.success("Organization code copied to clipboard!");
  };

  const handlePullRefresh = async () => {
    setRefreshing(true);
    await refreshOrganization().catch(() => {});
    setRefreshing(false);
  };

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      {/* Sleek Modern Header */}
      <View style={styles.headerBar}>
        <View style={styles.headerLeft}>
          <View style={styles.orgBadgeRow}>
            <View style={styles.livePulseDot} />
            <Text style={styles.headerSubtitle}>ADMIN COMMAND CENTER</Text>
            <TouchableOpacity
              onPress={copyOrgCode}
              style={styles.orgCodePill}
              activeOpacity={0.7}
            >
              <Text style={styles.orgCodeText}>
                {organization?.churchCode || "ORG"}
              </Text>
              <Ionicons name="copy-outline" size={11} color="#64748B" />
            </TouchableOpacity>
          </View>
          <Text style={styles.headerOrgName} numberOfLines={1}>
            {organization?.churchName || "Organization Workspace"}
          </Text>
        </View>

        <TouchableOpacity
          style={styles.signOutIconButton}
          activeOpacity={0.8}
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
          <Ionicons name="log-out-outline" size={20} color="#DC2626" />
        </TouchableOpacity>
      </View>

      {/* Segmented Tab Control */}
      <View style={styles.segmentedContainer}>
        <View style={styles.segmentedControl}>
          <TouchableOpacity
            style={[
              styles.segmentItem,
              activeTab === "feed" && styles.segmentItemActive,
            ]}
            onPress={() => setActiveTab("feed")}
            activeOpacity={0.8}
          >
            <Ionicons
              name={activeTab === "feed" ? "pulse" : "pulse-outline"}
              size={16}
              color={activeTab === "feed" ? "#0F172A" : "#64748B"}
            />
            <Text
              style={[
                styles.segmentText,
                activeTab === "feed" && styles.segmentTextActive,
              ]}
            >
              Live Attendance
            </Text>
            {todayRecords.length > 0 && (
              <View
                style={[
                  styles.tabBadge,
                  activeTab === "feed" && styles.tabBadgeActive,
                ]}
              >
                <Text
                  style={[
                    styles.tabBadgeText,
                    activeTab === "feed" && styles.tabBadgeTextActive,
                  ]}
                >
                  {todayRecords.length}
                </Text>
              </View>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.segmentItem,
              activeTab === "anchors" && styles.segmentItemActive,
            ]}
            onPress={() => setActiveTab("anchors")}
            activeOpacity={0.8}
          >
            <Ionicons
              name={activeTab === "anchors" ? "radio" : "radio-outline"}
              size={16}
              color={activeTab === "anchors" ? "#0F172A" : "#64748B"}
            />
            <Text
              style={[
                styles.segmentText,
                activeTab === "anchors" && styles.segmentTextActive,
              ]}
            >
              Presence Anchors
            </Text>
            <View
              style={[
                styles.statusDotSmall,
                { backgroundColor: isCalibrated ? "#10B981" : "#F59E0B" },
              ]}
            />
          </TouchableOpacity>
        </View>
      </View>

      {/* Main Content Area */}
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
        {/* TAB 1: LIVE ATTENDANCE STREAM */}
        {/* ================================================================= */}
        {activeTab === "feed" && (
          <View style={styles.tabSection}>
            {/* Quick KPI Overview */}
            <View style={styles.kpiRow}>
              <View style={styles.kpiCard}>
                <Text style={styles.kpiLabel}>CHECKED IN</Text>
                <Text style={styles.kpiValue}>{todayRecords.length}</Text>
                <Text style={styles.kpiSub}>Today's punches</Text>
              </View>

              <View style={styles.kpiCard}>
                <Text style={styles.kpiLabel}>ON TIME</Text>
                <Text style={[styles.kpiValue, { color: "#059669" }]}>
                  {onTimeCount}
                </Text>
                <Text style={styles.kpiSub}>
                  {todayRecords.length > 0 ? `${punctualityRate}% rate` : "100% rate"}
                </Text>
              </View>

              <View style={styles.kpiCard}>
                <Text style={styles.kpiLabel}>LATE</Text>
                <Text
                  style={[
                    styles.kpiValue,
                    { color: lateCount > 0 ? "#D97706" : "#64748B" },
                  ]}
                >
                  {lateCount}
                </Text>
                <Text style={styles.kpiSub}>Flagged records</Text>
              </View>
            </View>

            {/* Search & Actions Bar */}
            <View style={styles.searchBarRow}>
              <View style={styles.searchBox}>
                <Ionicons name="search-outline" size={16} color="#94A3B8" />
                <TextInput
                  style={styles.searchInput}
                  placeholder="Search worker or department..."
                  placeholderTextColor="#94A3B8"
                  value={feedSearch}
                  onChangeText={setFeedSearch}
                  clearButtonMode="while-editing"
                />
                {feedSearch.length > 0 && (
                  <TouchableOpacity onPress={() => setFeedSearch("")}>
                    <Ionicons name="close-circle" size={16} color="#94A3B8" />
                  </TouchableOpacity>
                )}
              </View>

              {todayRecords.length > 0 && (
                <TouchableOpacity
                  style={styles.clearFeedButton}
                  onPress={handleClearFeed}
                  disabled={isClearingFeed}
                  activeOpacity={0.8}
                >
                  {isClearingFeed ? (
                    <ActivityIndicator size="small" color="#DC2626" />
                  ) : (
                    <Ionicons name="trash-outline" size={16} color="#DC2626" />
                  )}
                </TouchableOpacity>
              )}
            </View>

            {/* Department Filter Pills */}
            {departmentList.length > 2 && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.filterScroll}
              >
                {departmentList.map((dept) => {
                  const isActive = selectedDeptFilter === dept;
                  return (
                    <TouchableOpacity
                      key={dept}
                      style={[
                        styles.deptFilterPill,
                        isActive && styles.deptFilterPillActive,
                      ]}
                      onPress={() => setSelectedDeptFilter(dept)}
                      activeOpacity={0.7}
                    >
                      <Text
                        style={[
                          styles.deptFilterText,
                          isActive && styles.deptFilterTextActive,
                        ]}
                      >
                        {dept}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}

            {/* Feed List */}
            {isAttendanceLoading ? (
              <View style={styles.loadingBox}>
                <ActivityIndicator size="small" color="#2563EB" />
                <Text style={styles.loadingText}>Syncing live attendance feed...</Text>
              </View>
            ) : filteredFeedRecords.length === 0 ? (
              <View style={styles.emptyCard}>
                <View style={styles.emptyIconCircle}>
                  <Ionicons name="finger-print-outline" size={32} color="#94A3B8" />
                </View>
                <Text style={styles.emptyTitle}>
                  {feedSearch ? "No matching records found" : "No Attendance Recorded Today"}
                </Text>
                <Text style={styles.emptySub}>
                  {feedSearch
                    ? "Try adjusting your search query or department filter."
                    : "Workers' verified check-in punches will appear here live as they clock in."}
                </Text>
              </View>
            ) : (
              <View style={styles.feedList}>
                {filteredFeedRecords.map((item) => {
                  const isOnTime = item.status === "ON_TIME";
                  const punchTime = item.punchedAt
                    ? new Date(item.punchedAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : "--:--";

                  const initial = (item.memberName?.[0] || "W").toUpperCase();

                  return (
                    <View key={item.id} style={styles.punchCard}>
                      <View style={styles.punchTopRow}>
                        <View style={styles.avatarCircle}>
                          <Text style={styles.avatarText}>{initial}</Text>
                        </View>

                        <View style={styles.punchInfoCol}>
                          <Text style={styles.punchMemberName} numberOfLines={1}>
                            {item.memberName}
                          </Text>
                          <Text style={styles.punchDept} numberOfLines={1}>
                            {item.department || "General Workforce"}
                          </Text>
                        </View>

                        <View style={styles.punchMetaCol}>
                          <Text style={styles.punchTimeText}>{punchTime}</Text>
                          <View
                            style={[
                              styles.statusPill,
                              isOnTime
                                ? styles.statusPillOnTime
                                : styles.statusPillLate,
                            ]}
                          >
                            <Text
                              style={[
                                styles.statusPillText,
                                isOnTime
                                  ? styles.statusPillTextOnTime
                                  : styles.statusPillTextLate,
                              ]}
                            >
                              {isOnTime ? "ON TIME" : "LATE"}
                            </Text>
                          </View>
                        </View>
                      </View>

                      <View style={styles.punchDivider} />

                      <View style={styles.punchBottomRow}>
                        <View style={styles.methodBadge}>
                          <Ionicons
                            name={
                              item.verificationMethod === "WIFI_BSSID"
                                ? "wifi"
                                : "navigate"
                            }
                            size={12}
                            color="#2563EB"
                          />
                          <Text style={styles.methodBadgeText}>
                            {item.verificationMethod === "WIFI_BSSID"
                              ? "Wi-Fi Anchor"
                              : "GPS Geofence"}
                          </Text>
                        </View>

                        {item.signedOutAt ? (
                          <View style={styles.signOutTag}>
                            <Ionicons name="log-out" size={12} color="#059669" />
                            <Text style={styles.signOutTagText}>
                              Out:{" "}
                              {new Date(item.signedOutAt).toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </Text>
                          </View>
                        ) : (
                          <View style={styles.presenceActiveTag}>
                            <View style={styles.activeDot} />
                            <Text style={styles.presenceActiveText}>Active On-Site</Text>
                          </View>
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
        {/* TAB 2: PRESENCE ANCHORS & DIRECT CALIBRATION */}
        {/* ================================================================= */}
        {activeTab === "anchors" && (
          <View style={styles.tabSection}>
            {/* Status Hero Card */}
            <View style={styles.statusHeroCard}>
              <View style={styles.statusHeroTop}>
                <View
                  style={[
                    styles.statusHeroIconBox,
                    { backgroundColor: isCalibrated ? "#ECFDF5" : "#FFFBEB" },
                  ]}
                >
                  <Ionicons
                    name={isCalibrated ? "shield-checkmark" : "alert-circle"}
                    size={24}
                    color={isCalibrated ? "#059669" : "#D97706"}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.statusHeroTitle}>
                    {isCalibrated ? "Presence Anchors Active" : "Anchors Not Calibrated"}
                  </Text>
                  <Text style={styles.statusHeroSub}>
                    {isCalibrated
                      ? `Enforcing ${
                          calMode === "GEOFENCE_ONLY"
                            ? "Satellite GPS Geofence"
                            : "Hybrid Wi-Fi Router + GPS"
                        }`
                      : "Calibrate below on-site to lock physical boundaries."}
                  </Text>
                </View>
                <View
                  style={[
                    styles.liveSyncBadge,
                    { backgroundColor: isCalibrated ? "#ECFDF5" : "#FFFBEB" },
                  ]}
                >
                  <View
                    style={[
                      styles.syncPulseDot,
                      { backgroundColor: isCalibrated ? "#059669" : "#D97706" },
                    ]}
                  />
                  <Text
                    style={[
                      styles.liveSyncText,
                      { color: isCalibrated ? "#059669" : "#D97706" },
                    ]}
                  >
                    {isCalibrated ? "LIVE" : "PENDING"}
                  </Text>
                </View>
              </View>

              {locationAddress ? (
                <View style={styles.addressBox}>
                  <Ionicons name="location" size={14} color="#64748B" />
                  <Text style={styles.addressText} numberOfLines={2}>
                    {locationAddress}
                  </Text>
                </View>
              ) : null}
            </View>

            {/* Architecture Mode Selector */}
            <View style={styles.card}>
              <Text style={styles.cardSectionTitle}>VERIFICATION ARCHITECTURE</Text>
              <Text style={styles.cardSectionSub}>
                Select the physical security method required for worker clock-ins.
              </Text>

              <View style={styles.modeCardsRow}>
                <TouchableOpacity
                  style={[
                    styles.modeChoiceCard,
                    calMode === "GEOFENCE_ONLY" && styles.modeChoiceCardActive,
                  ]}
                  onPress={() => setCalMode("GEOFENCE_ONLY")}
                  activeOpacity={0.8}
                >
                  <View style={styles.modeChoiceHeader}>
                    <Ionicons
                      name="navigate"
                      size={20}
                      color={calMode === "GEOFENCE_ONLY" ? "#2563EB" : "#64748B"}
                    />
                    <View
                      style={[
                        styles.radioCircle,
                        calMode === "GEOFENCE_ONLY" && styles.radioCircleActive,
                      ]}
                    >
                      {calMode === "GEOFENCE_ONLY" && <View style={styles.radioDot} />}
                    </View>
                  </View>
                  <Text style={styles.modeChoiceTitle}>Satellite Geofence</Text>
                  <Text style={styles.modeChoiceSub}>
                    Recommended • 100% Router-Free. Uses high-precision GPS.
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.modeChoiceCard,
                    calMode === "HYBRID" && styles.modeChoiceCardActive,
                  ]}
                  onPress={() => setCalMode("HYBRID")}
                  activeOpacity={0.8}
                >
                  <View style={styles.modeChoiceHeader}>
                    <Ionicons
                      name="wifi"
                      size={20}
                      color={calMode === "HYBRID" ? "#2563EB" : "#64748B"}
                    />
                    <View
                      style={[
                        styles.radioCircle,
                        calMode === "HYBRID" && styles.radioCircleActive,
                      ]}
                    >
                      {calMode === "HYBRID" && <View style={styles.radioDot} />}
                    </View>
                  </View>
                  <Text style={styles.modeChoiceTitle}>Router + Geofence</Text>
                  <Text style={styles.modeChoiceSub}>
                    Dual-Tier • Scans office router BSSID MAC address with GPS fallback.
                  </Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* GPS Pinpoint Section */}
            <View style={styles.card}>
              <View style={styles.cardHeaderRow}>
                <View>
                  <Text style={styles.cardSectionTitle}>1. GPS PERIMETER COORDINATES</Text>
                  <Text style={styles.cardSectionSub}>
                    Sample high-accuracy latitude & longitude from device sensors.
                  </Text>
                </View>
              </View>

              <View style={styles.coordsDisplayBox}>
                <View style={styles.coordCol}>
                  <Text style={styles.coordLabel}>LATITUDE</Text>
                  <Text style={styles.coordVal}>
                    {latitude ? latitude.toFixed(6) : "0.000000"}
                  </Text>
                </View>
                <View style={styles.coordDivider} />
                <View style={styles.coordCol}>
                  <Text style={styles.coordLabel}>LONGITUDE</Text>
                  <Text style={styles.coordVal}>
                    {longitude ? longitude.toFixed(6) : "0.000000"}
                  </Text>
                </View>
                {gpsAccuracy !== null && (
                  <>
                    <View style={styles.coordDivider} />
                    <View style={styles.coordCol}>
                      <Text style={styles.coordLabel}>ACCURACY</Text>
                      <Text style={[styles.coordVal, { color: "#059669" }]}>
                        ±{gpsAccuracy}m
                      </Text>
                    </View>
                  </>
                )}
              </View>

              <TouchableOpacity
                style={[
                  styles.pinpointGpsButton,
                  isLocatingGps && styles.buttonDisabled,
                ]}
                onPress={handlePinpointGps}
                disabled={isLocatingGps}
                activeOpacity={0.85}
              >
                {isLocatingGps ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Ionicons name="locate" size={18} color="#FFFFFF" />
                )}
                <Text style={styles.pinpointGpsText}>
                  {isLocatingGps
                    ? "Acquiring High-Precision GPS..."
                    : "Pinpoint Current GPS Location"}
                </Text>
              </TouchableOpacity>
            </View>

            {/* Perimeter Radius Selector */}
            <View style={styles.card}>
              <Text style={styles.cardSectionTitle}>2. PERIMETER RADIUS</Text>
              <Text style={styles.cardSectionSub}>
                Allowable distance workers can be from the anchor coordinate ({radiusMeters}m selected).
              </Text>

              <View style={styles.radiusPillsGrid}>
                {RADIUS_OPTIONS.map((opt) => {
                  const isSel = radiusMeters === opt.value;
                  return (
                    <TouchableOpacity
                      key={opt.value}
                      style={[
                        styles.radiusPillItem,
                        isSel && styles.radiusPillItemActive,
                      ]}
                      onPress={() => setRadiusMeters(opt.value)}
                      activeOpacity={0.8}
                    >
                      <Text
                        style={[
                          styles.radiusPillLabel,
                          isSel && styles.radiusPillLabelActive,
                        ]}
                      >
                        {opt.label}
                      </Text>
                      <Text
                        style={[
                          styles.radiusPillDesc,
                          isSel && styles.radiusPillDescActive,
                        ]}
                        numberOfLines={1}
                      >
                        {opt.desc}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            {/* Office Router Configuration (If Hybrid Mode) */}
            {calMode === "HYBRID" && (
              <View style={styles.card}>
                <View style={styles.cardHeaderRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cardSectionTitle}>3. OFFICE WI-FI ROUTER ANCHOR</Text>
                    <Text style={styles.cardSectionSub}>
                      Pair with your premises Wi-Fi router's unique hardware BSSID.
                    </Text>
                  </View>
                  <TouchableOpacity
                    style={[
                      styles.scanWifiButton,
                      isScanningWifi && styles.buttonDisabled,
                    ]}
                    onPress={handleScanWifi}
                    disabled={isScanningWifi}
                    activeOpacity={0.8}
                  >
                    {isScanningWifi ? (
                      <ActivityIndicator size="small" color="#2563EB" />
                    ) : (
                      <Ionicons name="refresh" size={14} color="#2563EB" />
                    )}
                    <Text style={styles.scanWifiButtonText}>
                      {isScanningWifi ? "Scanning..." : "Scan Nearby"}
                    </Text>
                  </TouchableOpacity>
                </View>

                {/* Detected Networks Selector */}
                {availableNetworks.length > 0 && (
                  <View style={styles.networkListContainer}>
                    <Text style={styles.networkListHeader}>
                      DETECTED BROADCAST POINTS ({availableNetworks.length}):
                    </Text>
                    <ScrollView
                      style={styles.networkScroll}
                      nestedScrollEnabled
                      showsVerticalScrollIndicator={false}
                    >
                      {availableNetworks.slice(0, 6).map((net, idx) => {
                        const isMatch =
                          targetBssid &&
                          targetBssid.toLowerCase() === net.bssid.toLowerCase();
                        return (
                          <TouchableOpacity
                            key={`${net.bssid}-${idx}`}
                            style={[
                              styles.networkRow,
                              isMatch && styles.networkRowSelected,
                            ]}
                            onPress={() => handleSelectNetwork(net)}
                            activeOpacity={0.7}
                          >
                            <Ionicons
                              name="wifi"
                              size={16}
                              color={isMatch ? "#2563EB" : "#64748B"}
                            />
                            <View style={{ flex: 1 }}>
                              <Text
                                style={[
                                  styles.networkSsid,
                                  isMatch && styles.networkSsidActive,
                                ]}
                                numberOfLines={1}
                              >
                                {net.ssid || "Hidden Network"}
                              </Text>
                              <Text style={styles.networkBssid}>{net.bssid}</Text>
                            </View>
                            {isMatch && (
                              <Ionicons
                                name="checkmark-circle"
                                size={18}
                                color="#2563EB"
                              />
                            )}
                          </TouchableOpacity>
                        );
                      })}
                    </ScrollView>
                  </View>
                )}

                <View style={styles.inputGroup}>
                  <Text style={styles.inputLabel}>ROUTER SSID (NAME)</Text>
                  <TextInput
                    style={styles.textInput}
                    placeholder="e.g. Office_WiFi or Sanctuary_5G"
                    placeholderTextColor="#94A3B8"
                    value={ssidHint}
                    onChangeText={setSsidHint}
                  />
                </View>

                <View style={styles.inputGroup}>
                  <Text style={styles.inputLabel}>ROUTER BSSID (MAC ADDRESS)</Text>
                  <TextInput
                    style={[styles.textInput, styles.monoInput]}
                    placeholder="e.g. 34:2c:c4:91:a8:20"
                    placeholderTextColor="#94A3B8"
                    value={targetBssid}
                    onChangeText={setTargetBssid}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <Text style={styles.inputHelpText}>
                    Hardware MAC address broadcast by the premises router.
                  </Text>
                </View>
              </View>
            )}

            {/* Map Preview */}
            <View style={styles.card}>
              <Text style={styles.cardSectionTitle}>PREMISES GEOFENCE PREVIEW</Text>
              <Text style={styles.cardSectionSub}>
                Workers must be inside this circular boundary ({radiusMeters}m) to punch in.
              </Text>
              <View style={styles.mapFrame}>
                <PresenceMapMobile
                  latitude={latitude}
                  longitude={longitude}
                  radiusMeters={radiusMeters}
                  onCoordinatesChange={() => {}}
                  height={190}
                />
              </View>
            </View>

            {/* Save Action Button */}
            <TouchableOpacity
              style={[
                styles.saveAnchorsButton,
                isSavingAnchors && styles.buttonDisabled,
              ]}
              onPress={handleSaveAnchors}
              disabled={isSavingAnchors}
              activeOpacity={0.88}
            >
              {isSavingAnchors ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Ionicons name="cloud-upload" size={20} color="#FFFFFF" />
              )}
              <Text style={styles.saveAnchorsText}>
                {isSavingAnchors
                  ? "Committing & Syncing..."
                  : "Save Calibrated Anchors"}
              </Text>
            </TouchableOpacity>

            <View style={styles.webSyncHintCard}>
              <Ionicons name="desktop-outline" size={16} color="#64748B" />
              <Text style={styles.webSyncHintText}>
                Saving here immediately updates your Admin Web Portal in real time via Cloud Firestore.
              </Text>
            </View>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
};

// =============================================================================
// MODERN SLEEK STYLESHEET
// =============================================================================
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#F8FAFC",
  },
  headerBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingTop: 8,
    paddingBottom: 12,
    backgroundColor: "#FFFFFF",
    borderBottomWidth: 1,
    borderBottomColor: "#E2E8F0",
  },
  headerLeft: {
    flex: 1,
  },
  orgBadgeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 4,
  },
  livePulseDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#10B981",
  },
  headerSubtitle: {
    fontSize: 10,
    fontWeight: "700",
    color: "#64748B",
    letterSpacing: 0.6,
  },
  orgCodePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#F1F5F9",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    marginLeft: 4,
  },
  orgCodeText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#0F172A",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  headerOrgName: {
    fontSize: 18,
    fontWeight: "800",
    color: "#0F172A",
    letterSpacing: -0.4,
  },
  signOutIconButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "#FEE2E2",
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 12,
  },

  // Segmented Control
  segmentedContainer: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: "#FFFFFF",
    borderBottomWidth: 1,
    borderBottomColor: "#E2E8F0",
  },
  segmentedControl: {
    flexDirection: "row",
    backgroundColor: "#F1F5F9",
    borderRadius: 12,
    padding: 3,
  },
  segmentItem: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 9,
    gap: 6,
    borderRadius: 9,
  },
  segmentItemActive: {
    backgroundColor: "#FFFFFF",
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.08,
        shadowRadius: 2,
      },
      android: {
        elevation: 2,
      },
    }),
  },
  segmentText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#64748B",
  },
  segmentTextActive: {
    color: "#0F172A",
    fontWeight: "700",
  },
  tabBadge: {
    backgroundColor: "#E2E8F0",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 10,
  },
  tabBadgeActive: {
    backgroundColor: "#2563EB",
  },
  tabBadgeText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#475569",
  },
  tabBadgeTextActive: {
    color: "#FFFFFF",
  },
  statusDotSmall: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },

  // Content Structure
  contentScroll: {
    flex: 1,
  },
  contentInner: {
    padding: 16,
    paddingBottom: 40,
  },
  tabSection: {
    gap: 14,
  },

  // Card Structure
  card: {
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    padding: 16,
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
  cardHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  cardSectionTitle: {
    fontSize: 12,
    fontWeight: "800",
    color: "#475569",
    letterSpacing: 0.6,
  },
  cardSectionSub: {
    fontSize: 12,
    color: "#64748B",
    marginTop: 2,
    marginBottom: 10,
    lineHeight: 17,
  },

  // KPI Overview
  kpiRow: {
    flexDirection: "row",
    gap: 10,
  },
  kpiCard: {
    flex: 1,
    backgroundColor: "#FFFFFF",
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: "#E2E8F0",
  },
  kpiLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: "#64748B",
    letterSpacing: 0.5,
  },
  kpiValue: {
    fontSize: 22,
    fontWeight: "800",
    color: "#0F172A",
    marginVertical: 2,
    letterSpacing: -0.5,
  },
  kpiSub: {
    fontSize: 10,
    color: "#94A3B8",
    fontWeight: "500",
  },

  // Search & Filters
  searchBarRow: {
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
  },
  searchBox: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 42,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 13,
    color: "#0F172A",
  },
  clearFeedButton: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: "#FEE2E2",
    alignItems: "center",
    justifyContent: "center",
  },
  filterScroll: {
    gap: 6,
    paddingVertical: 2,
  },
  deptFilterPill: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#E2E8F0",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  deptFilterPillActive: {
    backgroundColor: "#0F172A",
    borderColor: "#0F172A",
  },
  deptFilterText: {
    fontSize: 11,
    fontWeight: "600",
    color: "#64748B",
  },
  deptFilterTextActive: {
    color: "#FFFFFF",
    fontWeight: "700",
  },

  // Feed Items
  feedList: {
    gap: 10,
  },
  punchCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: "#E2E8F0",
  },
  punchTopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  avatarCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#EFF6FF",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    fontSize: 14,
    fontWeight: "700",
    color: "#2563EB",
  },
  punchInfoCol: {
    flex: 1,
  },
  punchMemberName: {
    fontSize: 14,
    fontWeight: "700",
    color: "#0F172A",
  },
  punchDept: {
    fontSize: 11,
    color: "#64748B",
    marginTop: 1,
  },
  punchMetaCol: {
    alignItems: "flex-end",
    gap: 4,
  },
  punchTimeText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#0F172A",
  },
  statusPill: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  statusPillOnTime: {
    backgroundColor: "#ECFDF5",
  },
  statusPillLate: {
    backgroundColor: "#FFFBEB",
  },
  statusPillText: {
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  statusPillTextOnTime: {
    color: "#059669",
  },
  statusPillTextLate: {
    color: "#D97706",
  },
  punchDivider: {
    height: 1,
    backgroundColor: "#F1F5F9",
    marginVertical: 10,
  },
  punchBottomRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  methodBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "#F1F5F9",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  methodBadgeText: {
    fontSize: 10,
    fontWeight: "600",
    color: "#334155",
  },
  presenceActiveTag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  activeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#10B981",
  },
  presenceActiveText: {
    fontSize: 10,
    fontWeight: "600",
    color: "#059669",
  },
  signOutTag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#ECFDF5",
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  signOutTagText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#059669",
  },

  // Empty / Loading states
  loadingBox: {
    padding: 30,
    alignItems: "center",
    gap: 8,
  },
  loadingText: {
    fontSize: 12,
    color: "#64748B",
  },
  emptyCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    padding: 32,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#E2E8F0",
  },
  emptyIconCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "#F1F5F9",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  emptyTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: "#0F172A",
    marginBottom: 4,
    textAlign: "center",
  },
  emptySub: {
    fontSize: 12,
    color: "#64748B",
    textAlign: "center",
    lineHeight: 18,
    maxWidth: 260,
  },

  // Anchors Status Hero Card
  statusHeroCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: "#E2E8F0",
  },
  statusHeroTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  statusHeroIconBox: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  statusHeroTitle: {
    fontSize: 15,
    fontWeight: "800",
    color: "#0F172A",
  },
  statusHeroSub: {
    fontSize: 12,
    color: "#64748B",
    marginTop: 2,
  },
  liveSyncBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  syncPulseDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  liveSyncText: {
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  addressBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#F8FAFC",
    padding: 10,
    borderRadius: 10,
    marginTop: 12,
  },
  addressText: {
    fontSize: 11,
    color: "#475569",
    flex: 1,
    lineHeight: 15,
  },

  // Mode Selection Cards
  modeCardsRow: {
    flexDirection: "row",
    gap: 10,
  },
  modeChoiceCard: {
    flex: 1,
    backgroundColor: "#F8FAFC",
    borderWidth: 1.5,
    borderColor: "#E2E8F0",
    borderRadius: 14,
    padding: 12,
  },
  modeChoiceCardActive: {
    backgroundColor: "#EFF6FF",
    borderColor: "#2563EB",
  },
  modeChoiceHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
  },
  radioCircle: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: "#CBD5E1",
    alignItems: "center",
    justifyContent: "center",
  },
  radioCircleActive: {
    borderColor: "#2563EB",
  },
  radioDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#2563EB",
  },
  modeChoiceTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#0F172A",
    marginBottom: 2,
  },
  modeChoiceSub: {
    fontSize: 10,
    color: "#64748B",
    lineHeight: 14,
  },

  // GPS Pinpoint
  coordsDisplayBox: {
    flexDirection: "row",
    backgroundColor: "#F8FAFC",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    padding: 12,
    marginBottom: 10,
  },
  coordCol: {
    flex: 1,
    alignItems: "center",
  },
  coordDivider: {
    width: 1,
    backgroundColor: "#E2E8F0",
    marginHorizontal: 4,
  },
  coordLabel: {
    fontSize: 9,
    fontWeight: "700",
    color: "#64748B",
    letterSpacing: 0.5,
  },
  coordVal: {
    fontSize: 13,
    fontWeight: "700",
    color: "#0F172A",
    marginTop: 2,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  pinpointGpsButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#0F172A",
    height: 46,
    borderRadius: 12,
    gap: 8,
  },
  pinpointGpsText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#FFFFFF",
  },

  // Radius Pills
  radiusPillsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  radiusPillItem: {
    width: "31%",
    backgroundColor: "#F8FAFC",
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 6,
    alignItems: "center",
  },
  radiusPillItemActive: {
    backgroundColor: "#EFF6FF",
    borderColor: "#2563EB",
  },
  radiusPillLabel: {
    fontSize: 14,
    fontWeight: "800",
    color: "#0F172A",
  },
  radiusPillLabelActive: {
    color: "#2563EB",
  },
  radiusPillDesc: {
    fontSize: 9,
    color: "#64748B",
    marginTop: 2,
  },
  radiusPillDescActive: {
    color: "#1D4ED8",
  },

  // Wi-Fi Configuration
  scanWifiButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#EFF6FF",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#BFDBFE",
  },
  scanWifiButtonText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#2563EB",
  },
  networkListContainer: {
    backgroundColor: "#F8FAFC",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    padding: 10,
    marginBottom: 12,
  },
  networkListHeader: {
    fontSize: 10,
    fontWeight: "700",
    color: "#64748B",
    marginBottom: 6,
    letterSpacing: 0.5,
  },
  networkScroll: {
    maxHeight: 150,
  },
  networkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderRadius: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#F1F5F9",
  },
  networkRowSelected: {
    backgroundColor: "#EFF6FF",
  },
  networkSsid: {
    fontSize: 12,
    fontWeight: "700",
    color: "#0F172A",
  },
  networkSsidActive: {
    color: "#2563EB",
  },
  networkBssid: {
    fontSize: 10,
    color: "#64748B",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  inputGroup: {
    marginTop: 8,
    gap: 4,
  },
  inputLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: "#475569",
    letterSpacing: 0.5,
  },
  textInput: {
    backgroundColor: "#F8FAFC",
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 10,
    paddingHorizontal: 12,
    height: 42,
    fontSize: 13,
    color: "#0F172A",
  },
  monoInput: {
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 12,
  },
  inputHelpText: {
    fontSize: 10,
    color: "#94A3B8",
    marginTop: 2,
  },

  // Map Frame
  mapFrame: {
    borderRadius: 12,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#E2E8F0",
    marginTop: 4,
  },

  // Save Button
  saveAnchorsButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#2563EB",
    height: 52,
    borderRadius: 14,
    gap: 8,
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
  saveAnchorsText: {
    fontSize: 15,
    fontWeight: "800",
    color: "#FFFFFF",
  },
  webSyncHintCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#F1F5F9",
    padding: 12,
    borderRadius: 12,
    marginTop: -4,
  },
  webSyncHintText: {
    fontSize: 11,
    color: "#475569",
    flex: 1,
    lineHeight: 15,
  },

  buttonDisabled: {
    opacity: 0.6,
  },
});
