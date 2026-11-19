import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
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
  Modal,
  Pressable,
  Dimensions,
  LayoutAnimation,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import {
  collection,
  query,
  orderBy,
  onSnapshot,
  writeBatch,
  getDocs,
  doc,
  updateDoc,
  deleteDoc,
  limit,
} from "firebase/firestore";
import { db } from "../config/firebase";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { PresenceMapMobile } from "./PresenceMapMobile";
import {
  scanPhysicalWifiNetworks,
  ScannedWifiNetwork,
} from "../services/wifiScanService";
import {
  updateOrganizationAnchors as updateAnchorsService,
  clearMemberFaceEnrollment,
  resetMemberDeviceBinding,
  updateMemberStatus,
  deleteOrganizationMember,
  getCachedOrganization,
  getCachedAnchors,
  getAdminOrganization,
} from "../services/organizationService";
import { reverseGeocodeCoords } from "../services/geocodingService";
import { acquireDeviceCoordinates } from "../services/locationService";
import { AskPresentiChatModal } from "./AskPresentiChatModal";
import { FaceScannerModal } from "./FaceScannerModal";
import { TactilePressable } from "./TactilePressable";
import { C, MONO, R, S, T, shadow, ui } from "../constants/premium";
import type { MobileAIContext } from "../services/geminiService";
import type { ChurchMember } from "../types";

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
  signOutDisplayTime?: string;
  deviceId?: string;
}

const TABS = [
  { key: "feed" as const, label: "Live Feed", icon: "pulse-outline" as const, activeIcon: "pulse" as const },
  { key: "anchors" as const, label: "Anchors", icon: "location-outline" as const, activeIcon: "location" as const },
  { key: "workforce" as const, label: "Workforce", icon: "people-outline" as const, activeIcon: "people" as const },
];

export const AdminHub: React.FC = () => {
  const { user, organization, refreshOrganization, signOut } = useAuth();
  const toast = useToast();

  // Navigation: 3 Core Tabs on Mobile with WhatsApp-style Swiping
  const [activeTab, setActiveTab] = useState<"feed" | "anchors" | "workforce">("feed");
  const activeTabRef = useRef<"feed" | "anchors" | "workforce">("feed");
  activeTabRef.current = activeTab;

  const [refreshing, setRefreshing] = useState(false);
  const [screenWidth, setScreenWidth] = useState(Dimensions.get("window").width);
  const horizontalPagerRef = useRef<ScrollView>(null);

  // Proactively resolve and hydrate organization workspace on mount
  useEffect(() => {
    if (!organization?.id && user) {
      getAdminOrganization(user.email, user.uid)
        .then((org) => {
          if (org && refreshOrganization) {
            refreshOrganization().catch(() => {});
          }
        })
        .catch(() => {});
    }
  }, [organization?.id, user, refreshOrganization]);

  const handleTabPress = (tabKey: "feed" | "anchors" | "workforce", index: number) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setActiveTab(tabKey);
    activeTabRef.current = tabKey;
    (horizontalPagerRef.current as any)?.scrollTo({ x: index * screenWidth, animated: true });
  };

  const handlePageChange = (e: any) => {
    const offsetX = e.nativeEvent.contentOffset.x;
    const newIndex = Math.round(offsetX / screenWidth);
    if (newIndex === 0 && activeTab !== "feed") setActiveTab("feed");
    else if (newIndex === 1 && activeTab !== "anchors") setActiveTab("anchors");
    else if (newIndex === 2 && activeTab !== "workforce") setActiveTab("workforce");
  };

  // ----------------------------------------------------------------------
  // TAB 1: LIVE ATTENDANCE FEED
  // ----------------------------------------------------------------------
  const [attendance, setAttendance] = useState<LiveAttendanceRecord[]>([]);
  const [isAttendanceLoading, setIsAttendanceLoading] = useState(true);
  const [feedSearch, setFeedSearch] = useState("");
  const [selectedDeptFilter, setSelectedDeptFilter] = useState<string>("ALL");
  const [isClearingFeed, setIsClearingFeed] = useState(false);
  const [feedTimeScope, setFeedTimeScope] = useState<"TODAY" | "ALL">("TODAY");

  // Modal 1: Attendance Record Detail Modal
  const [selectedPunch, setSelectedPunch] = useState<LiveAttendanceRecord | null>(null);

  // Auto-retry resolving organization if missing
  useEffect(() => {
    if (!organization?.id && refreshOrganization) {
      refreshOrganization().catch(() => {});
    }
  }, [organization?.id, refreshOrganization]);

  useEffect(() => {
    if (!organization?.id || !db) {
      setIsAttendanceLoading(false);
      return;
    }
    setIsAttendanceLoading(true);

    const safetyTimeout = setTimeout(() => {
      setIsAttendanceLoading(false);
    }, 3500);

    const attRef = collection(db, "churches", organization.id, "attendance");

    // Immediate direct query for instant rendering
    getDocs(attRef)
      .then((snap) => {
        const records: LiveAttendanceRecord[] = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as any),
        }));
        records.sort((a, b) => {
          const tA = new Date(a.punchedAt || (a as any).timestamp || 0).getTime();
          const tB = new Date(b.punchedAt || (b as any).timestamp || 0).getTime();
          return tB - tA;
        });
        setAttendance(records);
        setIsAttendanceLoading(false);
      })
      .catch((err) => {
        console.warn("Immediate attendance fetch notice:", err);
        setIsAttendanceLoading(false);
      });

    try {
      const unsubscribe = onSnapshot(
        attRef,
        (snap) => {
          clearTimeout(safetyTimeout);
          const records: LiveAttendanceRecord[] = snap.docs.map((d) => ({
            id: d.id,
            ...(d.data() as any),
          }));
          records.sort((a, b) => {
            const tA = new Date(a.punchedAt || (a as any).timestamp || 0).getTime();
            const tB = new Date(b.punchedAt || (b as any).timestamp || 0).getTime();
            return tB - tA;
          });
          setAttendance(records);
          setIsAttendanceLoading(false);
        },
        (err) => {
          clearTimeout(safetyTimeout);
          console.warn("Live attendance stream notice:", err);
          setIsAttendanceLoading(false);
        }
      );
      return () => {
        clearTimeout(safetyTimeout);
        unsubscribe();
      };
    } catch (e) {
      clearTimeout(safetyTimeout);
      console.warn("Error subscribing to attendance:", e);
      setIsAttendanceLoading(false);
    }
  }, [organization?.id]);

  const localTodayStr = useMemo(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }, []);
  const utcTodayStr = useMemo(() => new Date().toISOString().split("T")[0], []);

  const todayRecords = useMemo(() => {
    return attendance.filter(
      (r) => r.serviceDate === localTodayStr || r.serviceDate === utcTodayStr
    );
  }, [attendance, localTodayStr, utcTodayStr]);

  const activeRecords = useMemo(() => {
    if (feedTimeScope === "ALL") return attendance;
    return todayRecords;
  }, [feedTimeScope, attendance, todayRecords]);

  const onTimeCount = useMemo(() => {
    return activeRecords.filter((r) => r.status === "ON_TIME").length;
  }, [activeRecords]);

  const lateCount = useMemo(() => {
    return activeRecords.filter((r) => r.status === "LATE").length;
  }, [activeRecords]);

  const punctualityRate = useMemo(() => {
    if (activeRecords.length === 0) return 100;
    return Math.round((onTimeCount / activeRecords.length) * 100);
  }, [activeRecords, onTimeCount]);

  const departmentList = useMemo(() => {
    const set = new Set<string>();
    activeRecords.forEach((r) => {
      if (r.department && r.department.trim()) {
        set.add(r.department.trim());
      }
    });
    return ["ALL", ...Array.from(set)];
  }, [activeRecords]);

  const filteredFeedRecords = useMemo(() => {
    return activeRecords.filter((rec) => {
      const matchSearch =
        !feedSearch.trim() ||
        rec.memberName?.toLowerCase().includes(feedSearch.toLowerCase()) ||
        rec.department?.toLowerCase().includes(feedSearch.toLowerCase());
      const matchDept =
        selectedDeptFilter === "ALL" || rec.department === selectedDeptFilter;
      return matchSearch && matchDept;
    });
  }, [activeRecords, feedSearch, selectedDeptFilter]);

  const handleClearFeed = async () => {
    if (!organization?.id || isClearingFeed) return;

    Alert.alert(
      "Clear Today's Attendance Feed",
      "Are you sure you want to permanently clear today's attendance records from the database? This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear Records",
          style: "destructive",
          onPress: async () => {
            setIsClearingFeed(true);
            try {
              const attRef = collection(db, "churches", organization.id, "attendance");
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
              toast.error("Failed to clear feed.");
            } finally {
              setIsClearingFeed(false);
            }
          },
        },
      ]
    );
  };

  // ----------------------------------------------------------------------
  // TAB 2: PRESENCE ANCHORS & CALIBRATION
  // ----------------------------------------------------------------------
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

  const [availableNetworks, setAvailableNetworks] = useState<ScannedWifiNetwork[]>([]);
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
    } catch {
      toast.warn("Wi-Fi scan limited on this device.");
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
      const coords = await acquireDeviceCoordinates({
        onInstantFix: (instant) => {
          setLatitude(instant.latitude);
          setLongitude(instant.longitude);
          setGpsAccuracy(instant.accuracy);
        },
      });

      setLatitude(coords.latitude);
      setLongitude(coords.longitude);
      setGpsAccuracy(coords.accuracy);
      Vibration.vibrate(50);
      toast.success(`GPS Pinpointed: ±${coords.accuracy}m fix.`);

      reverseGeocodeCoords(coords.latitude, coords.longitude)
        .then((addr) => {
          if (addr?.displayName) {
            setLocationAddress(addr.displayName);
          } else if (addr?.name) {
            setLocationAddress(addr.name);
          }
        })
        .catch(() => {});
    } catch (err: any) {
      console.warn("GPS acquire notice:", err);
      toast.error(err?.message || "Could not capture GPS location.");
    } finally {
      setIsLocatingGps(false);
    }
  };

  const handleSaveAnchors = async () => {
    if (isSavingAnchors) return;
    setIsSavingAnchors(true);

    try {
      // 1. Resolve Organization ID with multiple comprehensive fallbacks
      let targetOrgId = organization?.id;

      if (!targetOrgId) {
        try {
          const cached = await getCachedOrganization();
          if (cached?.id) targetOrgId = cached.id;
        } catch {}
      }

      if (!targetOrgId) {
        try {
          const cachedAnchors = await getCachedAnchors();
          if (cachedAnchors?.churchId) targetOrgId = cachedAnchors.churchId;
        } catch {}
      }

      if (!targetOrgId && user) {
        try {
          const adminOrg = await getAdminOrganization(user.email, user.uid);
          if (adminOrg?.id) {
            targetOrgId = adminOrg.id;
          }
        } catch {}
      }

      if (!targetOrgId) {
        try {
          const allSnap = await getDocs(query(collection(db, "churches"), limit(10)));
          if (!allSnap.empty) {
            const cleanEmail = (user?.email || "").trim().toLowerCase();
            const match = allSnap.docs.find((d) => {
              const data = d.data();
              return (
                (cleanEmail && data.adminEmail && data.adminEmail.trim().toLowerCase() === cleanEmail) ||
                (user?.uid && Array.isArray(data.adminUids) && data.adminUids.includes(user.uid)) ||
                (user?.uid && (d.id === user.uid || data.ownerId === user.uid || data.userId === user.uid))
              );
            });
            const chosen = match || allSnap.docs[0];
            if (chosen) targetOrgId = chosen.id;
          }
        } catch {}
      }

      if (!targetOrgId) {
        toast.error("Could not find your organization workspace. Please check your internet connection.");
        return;
      }

      // 2. Validate Wi-Fi BSSID for Hybrid mode
      if (calMode === "HYBRID" && !targetBssid.trim()) {
        toast.warn("Hybrid mode requires a router BSSID. Scan or enter a MAC address, or switch to Satellite GPS Geofence.");
        return;
      }

      // 3. Check or Auto-Acquire GPS coordinates if not set
      let activeLat = latitude;
      let activeLng = longitude;
      if ((!activeLat || activeLat === 0) && (!activeLng || activeLng === 0)) {
        toast.info("Acquiring current GPS location for premises...");
        try {
          const coords = await acquireDeviceCoordinates();
          activeLat = coords.latitude;
          activeLng = coords.longitude;
          setLatitude(coords.latitude);
          setLongitude(coords.longitude);
          setGpsAccuracy(coords.accuracy);
        } catch (err: any) {
          toast.warn("Please tap 'PINPOINT CURRENT GPS' to set premises location.");
          return;
        }
      }

      await updateAnchorsService(targetOrgId, {
        ssidHint: ssidHint.trim(),
        targetBssid: targetBssid.trim().toLowerCase(),
        latitude: activeLat,
        longitude: activeLng,
        radiusMeters,
        verificationMode: calMode,
      });

      // Synchronize updated anchors with local state & AuthContext
      await refreshOrganization().catch(() => {});

      Vibration.vibrate([0, 80, 40, 80]);
      toast.success("Presence Anchors calibrated & synced to cloud!");
    } catch (err: any) {
      console.error("Save anchors error:", err);
      toast.error("Failed to commit anchors: " + (err?.message || "Check network connection."));
    } finally {
      setIsSavingAnchors(false);
    }
  };

  // ----------------------------------------------------------------------
  // TAB 3: REGISTERED WORKFORCE USERS (Organization Directory)
  // ----------------------------------------------------------------------
  const [members, setMembers] = useState<ChurchMember[]>([]);
  const [isMembersLoading, setIsMembersLoading] = useState(true);
  const [workforceSearch, setWorkforceSearch] = useState("");
  const [selectedWorkforceFilter, setSelectedWorkforceFilter] = useState<
    "ALL" | "FACE_ENROLLED" | "PENDING_FACE" | "SUSPENDED"
  >("ALL");

  // Modal 2: Worker Detail & Management Modal
  const [selectedWorker, setSelectedWorker] = useState<ChurchMember | null>(null);
  const [isManagingWorker, setIsManagingWorker] = useState(false);

  // Real-time listener for registered organization members
  useEffect(() => {
    if (!organization?.id || !db) {
      setIsMembersLoading(false);
      return;
    }
    setIsMembersLoading(true);

    const safetyTimeout = setTimeout(() => {
      setIsMembersLoading(false);
    }, 3500);

    const membersRef = collection(db, "churches", organization.id, "members");

    // Immediate direct query for instant rendering
    getDocs(membersRef)
      .then((snap) => {
        const list: ChurchMember[] = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as any),
        }));
        list.sort((a, b) =>
          (a.fullName || (a as any).name || "").localeCompare(
            b.fullName || (b as any).name || ""
          )
        );
        setMembers(list);
        setIsMembersLoading(false);
      })
      .catch((err) => {
        console.warn("Immediate workforce fetch notice:", err);
        setIsMembersLoading(false);
      });

    try {
      const unsubscribe = onSnapshot(
        membersRef,
        (snap) => {
          clearTimeout(safetyTimeout);
          const list: ChurchMember[] = snap.docs.map((d) => ({
            id: d.id,
            ...(d.data() as any),
          }));
          list.sort((a, b) =>
            (a.fullName || (a as any).name || "").localeCompare(
              b.fullName || (b as any).name || ""
            )
          );
          setMembers(list);
          setIsMembersLoading(false);
        },
        (err) => {
          clearTimeout(safetyTimeout);
          console.warn("Workforce listener notice:", err);
          setIsMembersLoading(false);
        }
      );
      return () => {
        clearTimeout(safetyTimeout);
        unsubscribe();
      };
    } catch (e) {
      clearTimeout(safetyTimeout);
      console.warn("Error subscribing to workforce:", e);
      setIsMembersLoading(false);
    }
  }, [organization?.id]);

  const filteredMembers = useMemo(() => {
    return members.filter((m) => {
      const matchSearch =
        !workforceSearch.trim() ||
        m.fullName?.toLowerCase().includes(workforceSearch.toLowerCase()) ||
        m.email?.toLowerCase().includes(workforceSearch.toLowerCase()) ||
        m.phone?.includes(workforceSearch) ||
        m.department?.toLowerCase().includes(workforceSearch.toLowerCase());

      let matchFilter = true;
      if (selectedWorkforceFilter === "FACE_ENROLLED") {
        matchFilter = Boolean(m.isFaceEnrolled);
      } else if (selectedWorkforceFilter === "PENDING_FACE") {
        matchFilter = !m.isFaceEnrolled;
      } else if (selectedWorkforceFilter === "SUSPENDED") {
        matchFilter = (m as any).status === "SUSPENDED";
      }

      return matchSearch && matchFilter;
    });
  }, [members, workforceSearch, selectedWorkforceFilter]);

  const totalMembersCount = members.length;
  const faceEnrolledCount = useMemo(() => members.filter((m) => m.isFaceEnrolled).length, [members]);
  const activeMembersCount = useMemo(
    () => members.filter((m) => (m as any).status !== "SUSPENDED").length,
    [members]
  );

  // Member Management Actions
  const handleResetDevice = async (member: ChurchMember) => {
    if (!organization?.id) return;
    Alert.alert(
      "Reset Hardware Device Binding",
      `Allow ${member.fullName} to bind a new smartphone on their next clock-in?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reset Binding",
          style: "default",
          onPress: async () => {
            setIsManagingWorker(true);
            try {
              await resetMemberDeviceBinding(organization.id, member.id);
              toast.success(`Device binding cleared for ${member.fullName}.`);
              setSelectedWorker((prev) => (prev ? { ...prev, boundDeviceId: "" } : null));
            } catch (err: any) {
              toast.error("Failed to reset device binding.");
            } finally {
              setIsManagingWorker(false);
            }
          },
        },
      ]
    );
  };

  const handleResetFace = async (member: ChurchMember) => {
    if (!organization?.id) return;
    Alert.alert(
      "Reset Face ID Biometrics",
      `Clear face biometrics for ${member.fullName}? They will be required to re-enroll their face.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reset Face ID",
          style: "destructive",
          onPress: async () => {
            setIsManagingWorker(true);
            try {
              await clearMemberFaceEnrollment(organization.id, member.id);
              toast.success(`Face biometrics cleared for ${member.fullName}.`);
              setSelectedWorker((prev) =>
                prev ? { ...prev, isFaceEnrolled: false, faceEmbedding: [] } : null
              );
            } catch (err: any) {
              toast.error("Failed to reset face enrollment.");
            } finally {
              setIsManagingWorker(false);
            }
          },
        },
      ]
    );
  };

  const handleToggleStatus = async (member: ChurchMember) => {
    if (!organization?.id) return;
    const isSuspended = (member as any).status === "SUSPENDED";
    const nextStatus = isSuspended ? "ACTIVE" : "SUSPENDED";

    Alert.alert(
      nextStatus === "SUSPENDED" ? "Suspend Member" : "Re-activate Member",
      `Are you sure you want to set ${member.fullName}'s account to ${nextStatus}?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: nextStatus === "SUSPENDED" ? "Suspend" : "Activate",
          style: nextStatus === "SUSPENDED" ? "destructive" : "default",
          onPress: async () => {
            setIsManagingWorker(true);
            try {
              await updateMemberStatus(organization.id, member.id, nextStatus);
              toast.success(`${member.fullName} is now ${nextStatus}.`);
              setSelectedWorker((prev) => (prev ? ({ ...prev, status: nextStatus } as any) : null));
            } catch (err: any) {
              toast.error("Failed to update status.");
            } finally {
              setIsManagingWorker(false);
            }
          },
        },
      ]
    );
  };

  const handleDeleteMember = async (member: ChurchMember) => {
    if (!organization?.id) return;
    Alert.alert(
      "Delete Workforce Member",
      `Permanently remove ${member.fullName} from ${organization.churchName}? All associated credentials will be unlinked.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete Worker",
          style: "destructive",
          onPress: async () => {
            setIsManagingWorker(true);
            try {
              await deleteOrganizationMember(organization.id, member.id);
              toast.success(`Removed ${member.fullName}.`);
              setSelectedWorker(null);
            } catch (err: any) {
              toast.error("Failed to delete member.");
            } finally {
              setIsManagingWorker(false);
            }
          },
        },
      ]
    );
  };

  // ----------------------------------------------------------------------
  // MODAL 3: ADMIN PROFILE & WEB PORTAL DIALOG
  // ----------------------------------------------------------------------
  const [showAdminProfileModal, setShowAdminProfileModal] = useState(false);
  const [showAskPresenti, setShowAskPresenti] = useState(false);
  const [showAdminFaceTestModal, setShowAdminFaceTestModal] = useState(false);

  const mobileAIContext: MobileAIContext = useMemo(
    () => ({
      organizationName: organization?.churchName || "Organization",
      branchName: organization?.branchName || "Main Campus",
      dateLabel: new Date().toLocaleDateString("en-US", {
        weekday: "long",
        month: "short",
        day: "numeric",
        year: "numeric",
      }),
      totalCheckedIn: todayRecords.length,
      onTimeCount,
      lateCount,
      totalWorkforceCount: totalMembersCount,
      departments: organization?.departments || [],
      records: todayRecords.map((r) => ({
        memberName: r.memberName || "Unknown",
        department: r.department || "General",
        status: r.status || "ON_TIME",
        punchedAt: r.punchedAt || "",
        verificationMethod: r.verificationMethod || "WIFI_BSSID",
        signedOutAt: r.signedOutAt,
      })),
      members: members.map((m) => ({
        fullName: m.fullName || "Worker",
        department: m.department || "General",
        isFaceEnrolled: Boolean(m.isFaceEnrolled),
        status: (m as any).status || "ACTIVE",
      })),
    }),
    [
      organization?.churchName,
      organization?.branchName,
      organization?.departments,
      todayRecords,
      onTimeCount,
      lateCount,
      totalMembersCount,
      members,
    ]
  );

  const copyOrgCode = async () => {
    if (!organization?.churchCode) return;
    await Clipboard.setStringAsync(organization.churchCode);
    toast.success("Organization code copied to clipboard!");
  };

  const copyWebUrl = async () => {
    await Clipboard.setStringAsync("https://presenti-admin-web.vercel.app");
    toast.success("Web Portal URL copied to clipboard!");
  };

  const handlePullRefresh = async () => {
    setRefreshing(true);
    try {
      await refreshOrganization().catch(() => {});

      let targetOrgId = organization?.id;
      if (!targetOrgId) {
        try {
          const cached = await getCachedOrganization();
          if (cached?.id) targetOrgId = cached.id;
        } catch {}
      }
      if (!targetOrgId) {
        try {
          const cachedAnchors = await getCachedAnchors();
          if (cachedAnchors?.churchId) targetOrgId = cachedAnchors.churchId;
        } catch {}
      }
      if (!targetOrgId && user) {
        try {
          const adminOrg = await getAdminOrganization(user.email, user.uid);
          if (adminOrg?.id) targetOrgId = adminOrg.id;
        } catch {}
      }

      if (targetOrgId && db) {
        const attRef = collection(db, "churches", targetOrgId, "attendance");
        const membersRef = collection(db, "churches", targetOrgId, "members");
        const [attSnap, memSnap] = await Promise.all([
          getDocs(attRef).catch(() => null),
          getDocs(membersRef).catch(() => null),
        ]);
        if (attSnap) {
          const records: LiveAttendanceRecord[] = attSnap.docs.map((d) => ({
            id: d.id,
            ...(d.data() as any),
          }));
          records.sort((a, b) => {
            const tA = new Date(a.punchedAt || (a as any).timestamp || 0).getTime();
            const tB = new Date(b.punchedAt || (b as any).timestamp || 0).getTime();
            return tB - tA;
          });
          setAttendance(records);
        }
        if (memSnap) {
          const list: ChurchMember[] = memSnap.docs.map((d) => ({
            id: d.id,
            ...(d.data() as any),
          }));
          list.sort((a, b) =>
            (a.fullName || (a as any).name || "").localeCompare(
              b.fullName || (b as any).name || ""
            )
          );
          setMembers(list);
        }
      }
      toast.success("Feed & workforce refreshed.");
    } catch (e) {
      console.warn("Pull refresh notice:", e);
    } finally {
      setIsAttendanceLoading(false);
      setIsMembersLoading(false);
      setRefreshing(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      {/* ---------------------------------------------------------------- */}
      {/* BOLT / INDRIVE STYLE COMPACT HEADER BAR                          */}
      {/* ---------------------------------------------------------------- */}
      <View style={styles.topHeader}>
        <View style={styles.headerLeftCol}>
          <View style={styles.telemetryTagRow}>
            <View style={styles.livePulseDot} />
            <Text style={styles.telemetryTagText}>FIELD ADMIN HUB</Text>
            <TouchableOpacity
              onPress={copyOrgCode}
              style={styles.orgCodePill}
              activeOpacity={0.7}
            >
              <Text style={styles.orgCodeText}>{organization?.churchCode || "ORG"}</Text>
              <Ionicons name="copy-outline" size={10} color="#142748" />
            </TouchableOpacity>
          </View>
          <Text style={styles.organizationName} numberOfLines={1}>
            {organization?.churchName || "Organization Workspace"}
          </Text>
        </View>

        <TouchableOpacity
          style={styles.adminAvatarButton}
          onPress={() => setShowAdminProfileModal(true)}
          activeOpacity={0.85}
        >
          <View style={styles.adminAvatarCircle}>
            <Text style={styles.adminAvatarText}>
              {(user?.displayName?.[0] || user?.email?.[0] || "A").toUpperCase()}
            </Text>
          </View>
        </TouchableOpacity>
      </View>

      {/* ---------------------------------------------------------------- */}
      {/* HORIZONTAL SWIPEABLE PAGER (WHATSAPP-STYLE TAB SWIPING)          */}
      {/* ---------------------------------------------------------------- */}
      <View
        style={styles.pagerContainer}
        onLayout={(e) => {
          const w = e.nativeEvent.layout.width;
          if (w > 0 && Math.abs(w - screenWidth) > 1) {
            setScreenWidth(w);
          }
        }}
      >
        <ScrollView
          ref={horizontalPagerRef}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={handlePageChange}
          keyboardShouldPersistTaps="handled"
          style={{ flex: 1 }}
          contentContainerStyle={{ flexGrow: 1 }}
        >
          {/* ============================================================== */}
          {/* TAB 1: LIVE ATTENDANCE FEED (PAGE 0)                           */}
          {/* ============================================================== */}
          <View style={{ width: screenWidth, flex: 1 }}>
            <ScrollView
              style={styles.scrollArea}
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              alwaysBounceVertical
              overScrollMode="always"
              nestedScrollEnabled
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={handlePullRefresh}
                  tintColor="#2d81ff"
                  colors={["#2d81ff", "#142748"]}
                  progressBackgroundColor="#ffffff"
                />
              }
            >
              <View style={styles.tabContent}>
            {/* KPI Metrics Row */}
            <View style={styles.kpiRow}>
              <View style={[styles.kpiCard, { borderTopWidth: 3, borderTopColor: C.accent }]}>
                <Text style={styles.kpiLabel}>CHECKED IN</Text>
                <Text style={[styles.kpiValue, { color: C.accent }]}>{todayRecords.length}</Text>
                <Text style={styles.kpiSub}>Today's punches</Text>
              </View>

              <View style={[styles.kpiCard, { borderTopWidth: 3, borderTopColor: C.success }]}>
                <Text style={styles.kpiLabel}>ON TIME</Text>
                <Text style={[styles.kpiValue, { color: C.success }]}>{onTimeCount}</Text>
                <Text style={styles.kpiSub}>
                  {todayRecords.length > 0 ? `${punctualityRate}% rate` : "100% rate"}
                </Text>
              </View>

              <View style={[styles.kpiCard, { borderTopWidth: 3, borderTopColor: C.warn }]}>
                <Text style={styles.kpiLabel}>LATE</Text>
                <Text style={[styles.kpiValue, { color: lateCount > 0 ? C.warn : C.muted }]}>
                  {lateCount}
                </Text>
                <Text style={styles.kpiSub}>Flagged arrivals</Text>
              </View>
            </View>

            {/* Search & Actions Bar with Time Scope Toggle */}
            <View style={styles.searchRow}>
              <View style={styles.searchBox}>
                <Ionicons name="search-outline" size={16} color="#64748b" />
                <TextInput
                  style={styles.searchInput}
                  placeholder={feedTimeScope === "TODAY" ? "Search today's punches..." : "Search all attendance..."}
                  placeholderTextColor="#94a3b8"
                  value={feedSearch}
                  onChangeText={setFeedSearch}
                />
                {feedSearch.length > 0 && (
                  <TouchableOpacity onPress={() => setFeedSearch("")}>
                    <Ionicons name="close-circle" size={16} color="#94a3b8" />
                  </TouchableOpacity>
                )}
              </View>

              <View style={styles.timeScopeToggle}>
                <TouchableOpacity
                  style={[styles.timeScopeBtn, feedTimeScope === "TODAY" && styles.timeScopeBtnActive]}
                  onPress={() => setFeedTimeScope("TODAY")}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.timeScopeText, feedTimeScope === "TODAY" && styles.timeScopeTextActive]}>
                    TODAY
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.timeScopeBtn, feedTimeScope === "ALL" && styles.timeScopeBtnActive]}
                  onPress={() => setFeedTimeScope("ALL")}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.timeScopeText, feedTimeScope === "ALL" && styles.timeScopeTextActive]}>
                    ALL ({attendance.length})
                  </Text>
                </TouchableOpacity>
              </View>

              {activeRecords.length > 0 && (
                <TouchableOpacity
                  style={styles.actionIconBtn}
                  onPress={handleClearFeed}
                  disabled={isClearingFeed}
                  activeOpacity={0.8}
                >
                  {isClearingFeed ? (
                    <ActivityIndicator size="small" color="#d92d20" />
                  ) : (
                    <Ionicons name="trash-outline" size={16} color="#d92d20" />
                  )}
                </TouchableOpacity>
              )}
            </View>

            {/* Department Filter Chips */}
            {departmentList.length > 2 && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.chipsScroll}
              >
                {departmentList.map((dept) => {
                  const isActive = selectedDeptFilter === dept;
                  return (
                    <TouchableOpacity
                      key={dept}
                      style={[styles.chipItem, isActive && styles.chipItemActive]}
                      onPress={() => setSelectedDeptFilter(dept)}
                      activeOpacity={0.8}
                    >
                      <Text style={[styles.chipText, isActive && styles.chipTextActive]}>
                        {dept}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}

            {/* Live Feed List */}
            {isAttendanceLoading ? (
              <View style={styles.loadingBox}>
                <ActivityIndicator size="small" color="#142748" />
                <Text style={styles.loadingText}>Connecting to live attendance radar...</Text>
              </View>
            ) : filteredFeedRecords.length === 0 ? (
              <View style={styles.emptyCard}>
                <View style={styles.emptyIconCircle}>
                  <Ionicons name="finger-print-outline" size={28} color="#64748b" />
                </View>
                <Text style={styles.emptyTitle}>
                  {feedSearch
                    ? "No matching records found"
                    : feedTimeScope === "TODAY"
                    ? "No Attendance Recorded Today"
                    : "No Attendance Records in Database"}
                </Text>
                <Text style={styles.emptySub}>
                  {feedSearch
                    ? "Try adjusting your search query."
                    : feedTimeScope === "TODAY" && attendance.length > 0
                    ? `No punches found for today (${localTodayStr}). You have ${attendance.length} total attendance punch${attendance.length === 1 ? '' : 'es'} in the database.`
                    : "Workers' verified check-in punches will appear here live as they clock in."}
                </Text>

                {feedTimeScope === "TODAY" && attendance.length > 0 && (
                  <TouchableOpacity
                    style={styles.switchScopeBtn}
                    onPress={() => setFeedTimeScope("ALL")}
                    activeOpacity={0.8}
                  >
                    <Ionicons name="time-outline" size={15} color="#ffffff" style={{ marginRight: 6 }} />
                    <Text style={styles.switchScopeBtnText}>VIEW ALL {attendance.length} ATTENDANCE RECORDS</Text>
                  </TouchableOpacity>
                )}

                {!organization?.id && (
                  <View style={styles.pullHintRow}>
                    <Ionicons name="arrow-down-outline" size={14} color="#64748b" style={{ marginRight: 5 }} />
                    <Text style={styles.pullHintText}>Pull down to refresh workspace</Text>
                  </View>
                )}
              </View>
            ) : (
              <View style={styles.feedCardList}>
                {filteredFeedRecords.map((item) => {
                  const isOnTime = item.status === "ON_TIME";
                  const punchTime = item.punchedAt
                    ? new Date(item.punchedAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })
                    : "--:--";
                  const initial = (item.memberName?.[0] || "W").toUpperCase();

                  return (
                    <TouchableOpacity
                      key={item.id}
                      style={styles.feedCard}
                      onPress={() => setSelectedPunch(item)}
                      activeOpacity={0.85}
                    >
                      <View style={styles.feedCardTop}>
                        <View style={styles.workerAvatarCircle}>
                          <Text style={styles.workerAvatarText}>{initial}</Text>
                        </View>

                        <View style={styles.feedCardInfo}>
                          <Text style={styles.feedWorkerName} numberOfLines={1}>
                            {item.memberName}
                          </Text>
                          <Text style={styles.feedWorkerDept} numberOfLines={1}>
                            {item.department || "General Workforce"}
                          </Text>
                        </View>

                        <View style={styles.feedCardMeta}>
                          <Text style={styles.feedTimeText}>{punchTime}</Text>
                          <View
                            style={[
                              styles.punctualityPill,
                              isOnTime ? styles.pillOnTime : styles.pillLate,
                            ]}
                          >
                            <Text
                              style={[
                                styles.punctualityText,
                                isOnTime ? styles.pillTextOnTime : styles.pillTextLate,
                              ]}
                            >
                              {isOnTime ? "ON TIME" : "LATE"}
                            </Text>
                          </View>
                        </View>
                      </View>

                      <View style={styles.feedCardDivider} />

                      <View style={styles.feedCardBottom}>
                        <View style={styles.verificationBadge}>
                          <Ionicons
                            name={item.verificationMethod === "WIFI_BSSID" ? "wifi" : "navigate"}
                            size={12}
                            color="#2d81ff"
                          />
                          <Text style={styles.verificationBadgeText}>
                            {item.verificationMethod === "WIFI_BSSID"
                              ? "Office Wi-Fi Anchor"
                              : "Satellite GPS Geofence"}
                          </Text>
                        </View>

                        {item.signedOutAt ? (
                          <View style={styles.signedOutBadge}>
                            <Ionicons name="log-out" size={12} color="#10b981" />
                            <Text style={styles.signedOutBadgeText}>
                              Out:{" "}
                              {new Date(item.signedOutAt).toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </Text>
                          </View>
                        ) : (
                          <View style={styles.activeOnSiteBadge}>
                            <View style={styles.activeDot} />
                            <Text style={styles.activeOnSiteText}>Active On-Site</Text>
                          </View>
                        )}
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
              </View>
            </ScrollView>
          </View>

          {/* ============================================================== */}
          {/* TAB 2: PRESENCE ANCHORS & CALIBRATION (PAGE 1)                 */}
          {/* ============================================================== */}
          <View style={{ width: screenWidth, flex: 1 }}>
            <ScrollView
              style={styles.scrollArea}
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              alwaysBounceVertical
              overScrollMode="always"
              nestedScrollEnabled
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={handlePullRefresh}
                  tintColor="#2d81ff"
                  colors={["#2d81ff", "#142748"]}
                  progressBackgroundColor="#ffffff"
                />
              }
            >
              <View style={styles.tabContent}>
            {/* Status Hero Card */}
            <View style={styles.statusHeroCard}>
              <View style={styles.statusHeroTop}>
                <View
                  style={[
                    styles.statusHeroIconBox,
                    { backgroundColor: isCalibrated ? "#ecfdf5" : "#fffbeb" },
                  ]}
                >
                  <Ionicons
                    name={isCalibrated ? "shield-checkmark" : "alert-circle"}
                    size={24}
                    color={isCalibrated ? "#10b981" : "#f59e0b"}
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
                            : "Hybrid Router + GPS"
                        }`
                      : "Pinpoint GPS and calibrate below to enforce boundary."}
                  </Text>
                </View>
                <View
                  style={[
                    styles.liveTagBadge,
                    { backgroundColor: isCalibrated ? "#ecfdf5" : "#fffbeb" },
                  ]}
                >
                  <Text
                    style={[
                      styles.liveTagText,
                      { color: isCalibrated ? "#10b981" : "#f59e0b" },
                    ]}
                  >
                    {isCalibrated ? "ACTIVE" : "PENDING"}
                  </Text>
                </View>
              </View>

              {locationAddress ? (
                <View style={styles.addressBox}>
                  <Ionicons name="location" size={14} color="#64748b" />
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
                      color={calMode === "GEOFENCE_ONLY" ? "#142748" : "#64748b"}
                    />
                    {calMode === "GEOFENCE_ONLY" && (
                      <Ionicons name="checkmark-circle" size={18} color="#2d81ff" />
                    )}
                  </View>
                  <Text style={styles.modeChoiceTitle}>Satellite Geofence</Text>
                  <Text style={styles.modeChoiceSub}>
                    Recommended • Router-free high-precision GPS satellite perimeter.
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
                      color={calMode === "HYBRID" ? "#142748" : "#64748b"}
                    />
                    {calMode === "HYBRID" && (
                      <Ionicons name="checkmark-circle" size={18} color="#2d81ff" />
                    )}
                  </View>
                  <Text style={styles.modeChoiceTitle}>Router + Geofence</Text>
                  <Text style={styles.modeChoiceSub}>
                    Dual-Tier • Matches office router BSSID MAC with GPS perimeter.
                  </Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* GPS Pinpoint Section */}
            <View style={styles.card}>
              <Text style={styles.cardSectionTitle}>1. GPS PERIMETER COORDINATES</Text>
              <Text style={styles.cardSectionSub}>
                Capture high-accuracy latitude & longitude from device hardware sensors.
              </Text>

              <View style={styles.coordsBox}>
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
                      <Text style={[styles.coordVal, { color: "#10b981" }]}>
                        ±{gpsAccuracy}m
                      </Text>
                    </View>
                  </>
                )}
              </View>

              <TouchableOpacity
                style={[styles.primaryActionBtn, isLocatingGps && styles.btnDisabled]}
                onPress={handlePinpointGps}
                disabled={isLocatingGps}
                activeOpacity={0.85}
              >
                {isLocatingGps ? (
                  <ActivityIndicator size="small" color="#f2f1ee" />
                ) : (
                  <Ionicons name="locate" size={18} color="#f2f1ee" />
                )}
                <Text style={styles.primaryActionBtnText}>
                  {isLocatingGps ? "ACQUIRING GPS FIX..." : "PINPOINT CURRENT GPS"}
                </Text>
              </TouchableOpacity>
            </View>

            {/* Perimeter Radius Selector */}
            <View style={styles.card}>
              <Text style={styles.cardSectionTitle}>2. PERIMETER RADIUS</Text>
              <Text style={styles.cardSectionSub}>
                Allowable distance workers can be from centerpoint ({radiusMeters}m selected).
              </Text>

              <View style={styles.radiusGrid}>
                {RADIUS_OPTIONS.map((opt) => {
                  const isSel = radiusMeters === opt.value;
                  return (
                    <TouchableOpacity
                      key={opt.value}
                      style={[styles.radiusItem, isSel && styles.radiusItemActive]}
                      onPress={() => setRadiusMeters(opt.value)}
                      activeOpacity={0.8}
                    >
                      <Text style={[styles.radiusLabel, isSel && styles.radiusLabelActive]}>
                        {opt.label}
                      </Text>
                      <Text
                        style={[styles.radiusDesc, isSel && styles.radiusDescActive]}
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
                    style={[styles.secondaryScanBtn, isScanningWifi && styles.btnDisabled]}
                    onPress={handleScanWifi}
                    disabled={isScanningWifi}
                    activeOpacity={0.8}
                  >
                    {isScanningWifi ? (
                      <ActivityIndicator size="small" color="#142748" />
                    ) : (
                      <Ionicons name="refresh" size={14} color="#142748" />
                    )}
                    <Text style={styles.secondaryScanBtnText}>
                      {isScanningWifi ? "Scanning..." : "Scan Nearby"}
                    </Text>
                  </TouchableOpacity>
                </View>

                {availableNetworks.length > 0 && (
                  <View style={styles.networkListContainer}>
                    <Text style={styles.networkListHeader}>
                      DETECTED BROADCAST POINTS ({availableNetworks.length}):
                    </Text>
                    <ScrollView style={styles.networkScroll} nestedScrollEnabled>
                      {availableNetworks.slice(0, 6).map((net, idx) => {
                        const isMatch =
                          targetBssid &&
                          targetBssid.toLowerCase() === net.bssid.toLowerCase();
                        return (
                          <TouchableOpacity
                            key={`${net.bssid}-${idx}`}
                            style={[styles.networkRow, isMatch && styles.networkRowSelected]}
                            onPress={() => handleSelectNetwork(net)}
                            activeOpacity={0.7}
                          >
                            <Ionicons
                              name="wifi"
                              size={16}
                              color={isMatch ? "#2d81ff" : "#64748b"}
                            />
                            <View style={{ flex: 1 }}>
                              <Text
                                style={[styles.networkSsid, isMatch && styles.networkSsidActive]}
                                numberOfLines={1}
                              >
                                {net.ssid || "Hidden Network"}
                              </Text>
                              <Text style={styles.networkBssid}>{net.bssid}</Text>
                            </View>
                            {isMatch && (
                              <Ionicons name="checkmark-circle" size={18} color="#2d81ff" />
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
                    placeholder="e.g. Office_WiFi"
                    placeholderTextColor="#94a3b8"
                    value={ssidHint}
                    onChangeText={setSsidHint}
                  />
                </View>

                <View style={styles.inputGroup}>
                  <Text style={styles.inputLabel}>ROUTER BSSID (MAC ADDRESS)</Text>
                  <TextInput
                    style={[styles.textInput, styles.monoInput]}
                    placeholder="e.g. 34:2c:c4:91:a8:20"
                    placeholderTextColor="#94a3b8"
                    value={targetBssid}
                    onChangeText={setTargetBssid}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>
              </View>
            )}

            {/* Interactive Leaflet Map Preview */}
            <View style={styles.card}>
              <Text style={styles.cardSectionTitle}>PREMISES GEOFENCE RADAR</Text>
              <Text style={styles.cardSectionSub}>
                Workers must be inside this circular boundary ({radiusMeters}m) to punch in.
              </Text>
              <View style={styles.mapFrame}>
                <PresenceMapMobile
                  latitude={latitude}
                  longitude={longitude}
                  radiusMeters={radiusMeters}
                  onCoordinatesChange={() => {}}
                  height={220}
                />
              </View>
            </View>

            {/* Save Anchors Primary Action */}
            <TouchableOpacity
              style={[styles.primaryActionBtn, isSavingAnchors && styles.btnDisabled]}
              onPress={handleSaveAnchors}
              disabled={isSavingAnchors}
              activeOpacity={0.88}
            >
              {isSavingAnchors ? (
                <ActivityIndicator size="small" color="#f2f1ee" />
              ) : (
                <Ionicons name="cloud-upload-outline" size={20} color="#f2f1ee" />
              )}
              <Text style={styles.primaryActionBtnText}>
                {isSavingAnchors ? "COMMITTING & SYNCING..." : "SAVE CALIBRATED ANCHORS"}
              </Text>
            </TouchableOpacity>
              </View>
            </ScrollView>
          </View>

          {/* ============================================================== */}
          {/* TAB 3: REGISTERED WORKFORCE USERS (PAGE 2)                     */}
          {/* ============================================================== */}
          <View style={{ width: screenWidth, flex: 1 }}>
            <ScrollView
              style={styles.scrollArea}
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              alwaysBounceVertical
              overScrollMode="always"
              nestedScrollEnabled
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={handlePullRefresh}
                  tintColor="#2d81ff"
                  colors={["#2d81ff", "#142748"]}
                  progressBackgroundColor="#ffffff"
                />
              }
            >
              <View style={styles.tabContent}>
            {/* Workforce KPI Summary */}
            <View style={styles.kpiRow}>
              <View style={styles.kpiCard}>
                <Text style={styles.kpiLabel}>TOTAL WORKFORCE</Text>
                <Text style={styles.kpiValue}>{totalMembersCount}</Text>
                <Text style={styles.kpiSub}>Registered profiles</Text>
              </View>

              <View style={styles.kpiCard}>
                <Text style={styles.kpiLabel}>FACE ENROLLED</Text>
                <Text style={[styles.kpiValue, { color: "#10b981" }]}>{faceEnrolledCount}</Text>
                <Text style={styles.kpiSub}>Biometric verified</Text>
              </View>

              <View style={styles.kpiCard}>
                <Text style={styles.kpiLabel}>ACTIVE STATUS</Text>
                <Text style={[styles.kpiValue, { color: "#2d81ff" }]}>{activeMembersCount}</Text>
                <Text style={styles.kpiSub}>Eligible to punch</Text>
              </View>
            </View>

            {/* Quick Face Scanner Launcher for Field Testing */}
            <TouchableOpacity
              style={styles.workforceFaceBanner}
              onPress={() => setShowAdminFaceTestModal(true)}
              activeOpacity={0.85}
            >
              <View style={styles.workforceFaceBannerLeft}>
                <View style={styles.workforceFaceIconBox}>
                  <Ionicons name="scan-circle" size={22} color="#2d81ff" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.workforceFaceTitle}>Test AI Face Scanner</Text>
                  <Text style={styles.workforceFaceSub}>
                    Run live facial verification & anti-spoofing camera
                  </Text>
                </View>
              </View>
              <View style={styles.workforceFaceBadge}>
                <Text style={styles.workforceFaceBadgeText}>TEST SCAN</Text>
              </View>
            </TouchableOpacity>

            {/* Workforce Search & Filter Bar */}
            <View style={styles.searchRow}>
              <View style={styles.searchBox}>
                <Ionicons name="search-outline" size={16} color="#64748b" />
                <TextInput
                  style={styles.searchInput}
                  placeholder="Search by name, email, department..."
                  placeholderTextColor="#94a3b8"
                  value={workforceSearch}
                  onChangeText={setWorkforceSearch}
                />
                {workforceSearch.length > 0 && (
                  <TouchableOpacity onPress={() => setWorkforceSearch("")}>
                    <Ionicons name="close-circle" size={16} color="#94a3b8" />
                  </TouchableOpacity>
                )}
              </View>
            </View>

            {/* Filter Tabs */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chipsScroll}
            >
              <TouchableOpacity
                style={[
                  styles.chipItem,
                  selectedWorkforceFilter === "ALL" && styles.chipItemActive,
                ]}
                onPress={() => setSelectedWorkforceFilter("ALL")}
              >
                <Text
                  style={[
                    styles.chipText,
                    selectedWorkforceFilter === "ALL" && styles.chipTextActive,
                  ]}
                >
                  ALL ({totalMembersCount})
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.chipItem,
                  selectedWorkforceFilter === "FACE_ENROLLED" && styles.chipItemActive,
                ]}
                onPress={() => setSelectedWorkforceFilter("FACE_ENROLLED")}
              >
                <Text
                  style={[
                    styles.chipText,
                    selectedWorkforceFilter === "FACE_ENROLLED" && styles.chipTextActive,
                  ]}
                >
                  FACE ENROLLED ({faceEnrolledCount})
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.chipItem,
                  selectedWorkforceFilter === "PENDING_FACE" && styles.chipItemActive,
                ]}
                onPress={() => setSelectedWorkforceFilter("PENDING_FACE")}
              >
                <Text
                  style={[
                    styles.chipText,
                    selectedWorkforceFilter === "PENDING_FACE" && styles.chipTextActive,
                  ]}
                >
                  PENDING FACE ({totalMembersCount - faceEnrolledCount})
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.chipItem,
                  selectedWorkforceFilter === "SUSPENDED" && styles.chipItemActive,
                ]}
                onPress={() => setSelectedWorkforceFilter("SUSPENDED")}
              >
                <Text
                  style={[
                    styles.chipText,
                    selectedWorkforceFilter === "SUSPENDED" && styles.chipTextActive,
                  ]}
                >
                  SUSPENDED
                </Text>
              </TouchableOpacity>
            </ScrollView>

            {/* Members List */}
            {isMembersLoading ? (
              <View style={styles.loadingBox}>
                <ActivityIndicator size="small" color="#142748" />
                <Text style={styles.loadingText}>Syncing registered workforce directory...</Text>
              </View>
            ) : filteredMembers.length === 0 ? (
              <View style={styles.emptyCard}>
                <View style={styles.emptyIconCircle}>
                  <Ionicons name="people-outline" size={28} color="#64748b" />
                </View>
                <Text style={styles.emptyTitle}>
                  {workforceSearch ? "No matching members found" : "No Registered Workers"}
                </Text>
                <Text style={styles.emptySub}>
                  {workforceSearch
                    ? "Try adjusting your search terms or filter."
                    : "Workers who register on the mobile app will appear here."}
                </Text>
                {!organization?.id && (
                  <View style={styles.pullHintRow}>
                    <Ionicons name="arrow-down-outline" size={14} color="#64748b" style={{ marginRight: 5 }} />
                    <Text style={styles.pullHintText}>Pull down to refresh workspace</Text>
                  </View>
                )}
              </View>
            ) : (
              <View style={styles.feedCardList}>
                {filteredMembers.map((member) => {
                  const isSuspended = (member as any).status === "SUSPENDED";
                  const initial = (member.fullName?.[0] || "W").toUpperCase();

                  return (
                    <TouchableOpacity
                      key={member.id}
                      style={[styles.feedCard, isSuspended && styles.suspendedCard]}
                      onPress={() => setSelectedWorker(member)}
                      activeOpacity={0.85}
                    >
                      <View style={styles.feedCardTop}>
                        {member.facePhotoURL || member.photoURL ? (
                          <Image
                            source={{ uri: member.facePhotoURL || member.photoURL }}
                            style={styles.memberPhotoThumb}
                          />
                        ) : (
                          <View style={styles.workerAvatarCircle}>
                            <Text style={styles.workerAvatarText}>{initial}</Text>
                          </View>
                        )}

                        <View style={styles.feedCardInfo}>
                          <Text style={styles.feedWorkerName} numberOfLines={1}>
                            {member.fullName}
                          </Text>
                          <Text style={styles.feedWorkerDept} numberOfLines={1}>
                            {member.department || "General"} • {member.phone || member.email || "No contact"}
                          </Text>
                        </View>

                        <View style={styles.feedCardMeta}>
                          <View
                            style={[
                              styles.punctualityPill,
                              isSuspended ? styles.pillLate : styles.pillOnTime,
                            ]}
                          >
                            <Text
                              style={[
                                styles.punctualityText,
                                isSuspended ? styles.pillTextLate : styles.pillTextOnTime,
                              ]}
                            >
                              {isSuspended ? "SUSPENDED" : "ACTIVE"}
                            </Text>
                          </View>
                        </View>
                      </View>

                      <View style={styles.feedCardDivider} />

                      <View style={styles.feedCardBottom}>
                        <View style={styles.verificationBadge}>
                          <Ionicons
                            name={member.isFaceEnrolled ? "checkmark-circle" : "ellipse-outline"}
                            size={12}
                            color={member.isFaceEnrolled ? "#10b981" : "#64748b"}
                          />
                          <Text style={styles.verificationBadgeText}>
                            {member.isFaceEnrolled ? "Face Enrolled" : "Face Pending"}
                          </Text>
                        </View>

                        <View style={styles.deviceBindingTag}>
                          <Ionicons name="hardware-chip-outline" size={12} color="#64748b" />
                          <Text style={styles.deviceBindingText}>
                            {member.boundDeviceId ? "Device Bound" : "Unbound"}
                          </Text>
                        </View>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
              </View>
            </ScrollView>
          </View>
        </ScrollView>
      </View>

      {/* ---------------------------------------------------------------- */}
      {/* BOTTOM TAB NAVIGATION (ARTCRAFT CLEAN MINIMAL STYLE)             */}
      {/* ---------------------------------------------------------------- */}
      <View style={styles.bottomTabBar}>
        {TABS.map((tab, idx) => {
          const isActive = activeTab === tab.key;
          return (
            <TactilePressable
              key={tab.key}
              style={styles.bottomTabItem}
              scaleTo={0.92}
              onPress={() => handleTabPress(tab.key, idx)}
            >
              <View
                style={[
                  styles.bottomTabIconContainer,
                  isActive && { backgroundColor: C.accentSoft, width: 48, height: 30 },
                ]}
              >
                <Ionicons
                  name={isActive ? tab.activeIcon : tab.icon}
                  size={21}
                  color={isActive ? C.accent : C.ink}
                />
                {tab.key === "feed" && todayRecords.length > 0 && (
                  <View style={[styles.bottomBadge, isActive && styles.bottomBadgeActive]}>
                    <Text style={[styles.bottomBadgeText, isActive && styles.bottomBadgeTextActive]}>
                      {todayRecords.length > 99 ? "99+" : todayRecords.length}
                    </Text>
                  </View>
                )}
                {tab.key === "anchors" && (
                  <View
                    style={[
                      styles.bottomStatusDot,
                      { backgroundColor: isCalibrated ? C.success : C.warn },
                    ]}
                  />
                )}
                {tab.key === "workforce" && totalMembersCount > 0 && (
                  <View style={[styles.bottomBadge, isActive && styles.bottomBadgeActive]}>
                    <Text style={[styles.bottomBadgeText, isActive && styles.bottomBadgeTextActive]}>
                      {totalMembersCount > 99 ? "99+" : totalMembersCount}
                    </Text>
                  </View>
                )}
              </View>

              <Text
                style={[
                  styles.bottomTabLabel,
                  isActive && styles.bottomTabLabelActive,
                ]}
                numberOfLines={1}
              >
                {tab.label}
              </Text>
            </TactilePressable>
          );
        })}
      </View>

      {/* Floating Ask Presenti AI Chat Bubble */}
      <TactilePressable
        style={styles.askPresentiFab}
        scaleTo={0.9}
        rippleColor="rgba(255,255,255,0.2)"
        onPress={() => setShowAskPresenti(true)}
      >
        <Ionicons name="chatbubble-ellipses" size={20} color="#ffffff" />
        <View style={styles.askPresentiSparkBadge}>
          <Ionicons name="sparkles" size={10} color="#142748" />
        </View>
      </TactilePressable>

      <AskPresentiChatModal
        visible={showAskPresenti}
        onClose={() => setShowAskPresenti(false)}
        context={mobileAIContext}
        organizationId={organization?.id}
        userId={(user?.email || user?.uid || "default").trim().toLowerCase()}
      />

      {/* OPay-Style AI Face Biometric Scanner Modal for Testing */}
      <FaceScannerModal
        visible={showAdminFaceTestModal}
        mode="enroll"
        onCancel={() => setShowAdminFaceTestModal(false)}
        onSuccess={() => {
          setShowAdminFaceTestModal(false);
          toast.success("AI Face Verification Passed! Biometrics confirmed.");
        }}
      />

      {/* ---------------------------------------------------------------- */}
      {/* MODAL 1: ATTENDANCE RECORD DETAIL POPUP                           */}
      {/* ---------------------------------------------------------------- */}
      <Modal
        visible={Boolean(selectedPunch)}
        transparent
        animationType="fade"
        onRequestClose={() => setSelectedPunch(null)}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => setSelectedPunch(null)}
        >
          <Pressable style={styles.modalSheetCard} onPress={(e) => e.stopPropagation()}>
            <View style={styles.modalDragHandle} />

            <View style={styles.modalHeaderRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.modalTitle}>Attendance Verification</Text>
                <Text style={styles.modalSubtitle}>Hardware & biometric audit details</Text>
              </View>
              <TouchableOpacity
                onPress={() => setSelectedPunch(null)}
                style={styles.modalCloseButton}
              >
                <Ionicons name="close" size={20} color="#142748" />
              </TouchableOpacity>
            </View>

            {selectedPunch && (
              <View style={styles.modalBody}>
                {/* Worker Header Card */}
                <View style={styles.detailCard}>
                  <View style={styles.detailAvatar}>
                    <Text style={styles.detailAvatarText}>
                      {(selectedPunch.memberName?.[0] || "W").toUpperCase()}
                    </Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.detailName}>{selectedPunch.memberName}</Text>
                    <Text style={styles.detailDept}>
                      {selectedPunch.department || "General Workforce"}
                    </Text>
                  </View>
                  <View
                    style={[
                      styles.punctualityPill,
                      selectedPunch.status === "ON_TIME" ? styles.pillOnTime : styles.pillLate,
                    ]}
                  >
                    <Text
                      style={[
                        styles.punctualityText,
                        selectedPunch.status === "ON_TIME"
                          ? styles.pillTextOnTime
                          : styles.pillTextLate,
                      ]}
                    >
                      {selectedPunch.status === "ON_TIME" ? "ON TIME" : "LATE"}
                    </Text>
                  </View>
                </View>

                {/* Audit Details Grid */}
                <View style={styles.auditGrid}>
                  <View style={styles.auditRow}>
                    <Text style={styles.auditLabel}>CLOCK IN TIME</Text>
                    <Text style={styles.auditValue}>
                      {new Date(selectedPunch.punchedAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                    </Text>
                  </View>

                  <View style={styles.auditRow}>
                    <Text style={styles.auditLabel}>SERVICE DATE</Text>
                    <Text style={styles.auditValue}>{selectedPunch.serviceDate}</Text>
                  </View>

                  <View style={styles.auditRow}>
                    <Text style={styles.auditLabel}>VERIFICATION ANCHOR</Text>
                    <Text style={styles.auditValue}>
                      {selectedPunch.verificationMethod === "WIFI_BSSID"
                        ? "Office Wi-Fi Router"
                        : "Satellite GPS Geofence"}
                    </Text>
                  </View>

                  {selectedPunch.bssidDetected && (
                    <View style={styles.auditRow}>
                      <Text style={styles.auditLabel}>DETECTED BSSID</Text>
                      <Text style={[styles.auditValue, styles.monoText]}>
                        {selectedPunch.bssidDetected}
                      </Text>
                    </View>
                  )}

                  <View style={styles.auditRow}>
                    <Text style={styles.auditLabel}>DEPARTURE / SIGN OUT</Text>
                    <Text style={styles.auditValue}>
                      {selectedPunch.signedOutAt
                        ? new Date(selectedPunch.signedOutAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })
                        : "Active On-Site"}
                    </Text>
                  </View>
                </View>

                <TouchableOpacity
                  style={styles.modalDismissBtn}
                  onPress={() => setSelectedPunch(null)}
                >
                  <Text style={styles.modalDismissText}>CLOSE AUDIT</Text>
                </TouchableOpacity>
              </View>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* ---------------------------------------------------------------- */}
      {/* MODAL 2: WORKER DETAIL & MANAGEMENT MODAL                        */}
      {/* ---------------------------------------------------------------- */}
      <Modal
        visible={Boolean(selectedWorker)}
        transparent
        animationType="fade"
        onRequestClose={() => setSelectedWorker(null)}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => setSelectedWorker(null)}
        >
          <Pressable style={styles.modalSheetCard} onPress={(e) => e.stopPropagation()}>
            <View style={styles.modalDragHandle} />

            <View style={styles.modalHeaderRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.modalTitle}>Manage Workforce Member</Text>
                <Text style={styles.modalSubtitle}>Profile, biometrics & device access</Text>
              </View>
              <TouchableOpacity
                onPress={() => setSelectedWorker(null)}
                style={styles.modalCloseButton}
              >
                <Ionicons name="close" size={20} color="#142748" />
              </TouchableOpacity>
            </View>

            {selectedWorker && (
              <View style={styles.modalBody}>
                {/* Profile Card */}
                <View style={styles.detailCard}>
                  {selectedWorker.facePhotoURL || selectedWorker.photoURL ? (
                    <Image
                      source={{ uri: selectedWorker.facePhotoURL || selectedWorker.photoURL }}
                      style={styles.memberPhotoModal}
                    />
                  ) : (
                    <View style={styles.detailAvatar}>
                      <Text style={styles.detailAvatarText}>
                        {(selectedWorker.fullName?.[0] || "W").toUpperCase()}
                      </Text>
                    </View>
                  )}
                  <View style={{ flex: 1 }}>
                    <Text style={styles.detailName}>{selectedWorker.fullName}</Text>
                    <Text style={styles.detailDept}>
                      {selectedWorker.department || "General"} • {selectedWorker.phone || "No phone"}
                    </Text>
                    <Text style={styles.detailEmail}>{selectedWorker.email || "No email"}</Text>
                  </View>
                </View>

                {/* Status & Biometrics summary */}
                <View style={styles.auditGrid}>
                  <View style={styles.auditRow}>
                    <Text style={styles.auditLabel}>FACE ENROLLMENT</Text>
                    <Text
                      style={[
                        styles.auditValue,
                        { color: selectedWorker.isFaceEnrolled ? "#10b981" : "#f59e0b" },
                      ]}
                    >
                      {selectedWorker.isFaceEnrolled ? "Enrolled & Active" : "Pending Registration"}
                    </Text>
                  </View>

                  <View style={styles.auditRow}>
                    <Text style={styles.auditLabel}>HARDWARE DEVICE BINDING</Text>
                    <Text style={[styles.auditValue, styles.monoText]}>
                      {selectedWorker.boundDeviceId
                        ? `Bound (${selectedWorker.boundDeviceId.slice(0, 10)}...)`
                        : "Unbound"}
                    </Text>
                  </View>

                  <View style={styles.auditRow}>
                    <Text style={styles.auditLabel}>ACCOUNT STATUS</Text>
                    <Text
                      style={[
                        styles.auditValue,
                        {
                          color:
                            (selectedWorker as any).status === "SUSPENDED"
                              ? "#d92d20"
                              : "#10b981",
                        },
                      ]}
                    >
                      {(selectedWorker as any).status === "SUSPENDED" ? "Suspended" : "Active"}
                    </Text>
                  </View>
                </View>

                {/* Management Action Buttons */}
                <View style={styles.workerActionCol}>
                  <TouchableOpacity
                    style={styles.workerActionBtn}
                    onPress={() => handleResetDevice(selectedWorker)}
                    disabled={isManagingWorker}
                  >
                    <Ionicons name="hardware-chip-outline" size={18} color="#142748" />
                    <Text style={styles.workerActionBtnText}>RESET HARDWARE DEVICE BINDING</Text>
                  </TouchableOpacity>

                  {selectedWorker.isFaceEnrolled && (
                    <TouchableOpacity
                      style={styles.workerActionBtn}
                      onPress={() => handleResetFace(selectedWorker)}
                      disabled={isManagingWorker}
                    >
                      <Ionicons name="refresh-circle-outline" size={18} color="#142748" />
                      <Text style={styles.workerActionBtnText}>RESET FACE ID BIOMETRICS</Text>
                    </TouchableOpacity>
                  )}

                  <TouchableOpacity
                    style={[styles.workerActionBtn, styles.workerActionBtnWarning]}
                    onPress={() => handleToggleStatus(selectedWorker)}
                    disabled={isManagingWorker}
                  >
                    <Ionicons
                      name={(selectedWorker as any).status === "SUSPENDED" ? "checkmark-circle" : "ban-outline"}
                      size={18}
                      color={(selectedWorker as any).status === "SUSPENDED" ? "#10b981" : "#f59e0b"}
                    />
                    <Text
                      style={[
                        styles.workerActionBtnText,
                        {
                          color:
                            (selectedWorker as any).status === "SUSPENDED"
                              ? "#10b981"
                              : "#f59e0b",
                        },
                      ]}
                    >
                      {(selectedWorker as any).status === "SUSPENDED"
                        ? "RE-ACTIVATE WORKER"
                        : "SUSPEND WORKER ACCESS"}
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.workerActionBtn, styles.workerActionBtnDestructive]}
                    onPress={() => handleDeleteMember(selectedWorker)}
                    disabled={isManagingWorker}
                  >
                    <Ionicons name="trash-outline" size={18} color="#d92d20" />
                    <Text
                      style={[styles.workerActionBtnText, { color: "#d92d20" }]}
                    >
                      REMOVE FROM WORKSPACE
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* ---------------------------------------------------------------- */}
      {/* MODAL 3: ADMIN PROFILE & DESKTOP WEB NOTICE MODAL                */}
      {/* ---------------------------------------------------------------- */}
      <Modal
        visible={showAdminProfileModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowAdminProfileModal(false)}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => setShowAdminProfileModal(false)}
        >
          <Pressable style={styles.modalSheetCard} onPress={(e) => e.stopPropagation()}>
            <View style={styles.modalDragHandle} />

            <View style={styles.modalHeaderRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.modalTitle}>Administrator Workspace</Text>
                <Text style={styles.modalSubtitle}>Role credentials & web portal access</Text>
              </View>
              <TouchableOpacity
                onPress={() => setShowAdminProfileModal(false)}
                style={styles.modalCloseButton}
              >
                <Ionicons name="close" size={20} color="#142748" />
              </TouchableOpacity>
            </View>

            <View style={styles.modalBody}>
              <View style={styles.detailCard}>
                <View style={styles.detailAvatar}>
                  <Text style={styles.detailAvatarText}>
                    {(user?.displayName?.[0] || user?.email?.[0] || "A").toUpperCase()}
                  </Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.detailName}>{user?.displayName || "Field Administrator"}</Text>
                  <Text style={styles.detailEmail}>{user?.email}</Text>
                  <Text style={styles.detailDept}>
                    Workspace: {organization?.churchName} ({organization?.branchName})
                  </Text>
                </View>
              </View>

              {/* Web Portal Notice (Explicit requirement from audio) */}
              <View style={styles.webNoticeCard}>
                <View style={styles.webNoticeHeader}>
                  <Ionicons name="desktop-outline" size={20} color="#142748" />
                  <Text style={styles.webNoticeTitle}>DESKTOP & WEB ADMIN PORTAL</Text>
                </View>
                <Text style={styles.webNoticeText}>
                  Organization policies, custom shifts, and comprehensive monthly audit metric reports
                  are managed exclusively on the Desktop / Web portal.
                </Text>
                <TouchableOpacity
                  style={styles.copyWebUrlBtn}
                  onPress={copyWebUrl}
                  activeOpacity={0.8}
                >
                  <Ionicons name="link-outline" size={16} color="#142748" />
                  <Text style={styles.copyWebUrlBtnText}>COPY WEB PORTAL URL</Text>
                </TouchableOpacity>
              </View>

              {/* Test AI Face Scanner Button */}
              <TouchableOpacity
                style={styles.adminFaceTestBtn}
                onPress={() => {
                  setShowAdminProfileModal(false);
                  setShowAdminFaceTestModal(true);
                }}
                activeOpacity={0.85}
              >
                <View style={styles.adminFaceTestBtnIcon}>
                  <Ionicons name="scan-circle" size={20} color="#ffffff" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.adminFaceTestBtnTitle}>Test AI Face Scanner</Text>
                  <Text style={styles.adminFaceTestBtnSub}>
                    Preview OPay-style circular biometric portal
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color="#64748b" />
              </TouchableOpacity>

              {/* Sign Out Button */}
              <TouchableOpacity
                style={styles.adminSignOutBtn}
                onPress={() => {
                  setShowAdminProfileModal(false);
                  Alert.alert("Sign Out", "Sign out of your Administrator session?", [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Sign Out",
                      style: "destructive",
                      onPress: () => signOut(),
                    },
                  ]);
                }}
              >
                <Ionicons name="log-out-outline" size={18} color="#d92d20" />
                <Text style={styles.adminSignOutBtnText}>SIGN OUT OF ADMIN HUB</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
};

// ----------------------------------------------------------------------
// STYLES (ArtCraft Design System: #142748, #f2f1ee, #2d81ff, #e5e7eb)
// ----------------------------------------------------------------------
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: C.canvas,
  },
  topHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: S.screenX,
    paddingTop: S.sm,
    paddingBottom: S.sm,
    backgroundColor: C.canvas,
  },
  headerLeftCol: {
    flex: 1,
    gap: 4,
  },
  telemetryTagRow: {
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
  telemetryTagText: {
    ...T.labelSm,
    color: C.ink,
  },
  orgCodePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.lineCard,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: R.pill,
  },
  orgCodeText: {
    ...T.labelSm,
    fontSize: 9,
    color: C.ink,
  },
  organizationName: {
    ...T.title,
    fontSize: 19,
  },
  adminAvatarButton: {
    padding: 2,
  },
  adminAvatarCircle: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: C.ink,
    alignItems: "center",
    justifyContent: "center",
    ...shadow.card,
  },
  adminAvatarText: {
    color: C.white,
    fontSize: 15,
    fontWeight: "800",
  },
  pagerContainer: {
    flex: 1,
  },
  askPresentiFab: {
    position: "absolute",
    bottom: Platform.OS === "ios" ? 98 : 84,
    right: S.screenX,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: C.ink,
    borderWidth: 2,
    borderColor: C.accent,
    alignItems: "center",
    justifyContent: "center",
    ...shadow.raised,
    zIndex: 40,
  },
  askPresentiSparkBadge: {
    position: "absolute",
    top: -2,
    right: -2,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: C.accent,
    borderWidth: 2,
    borderColor: C.white,
    alignItems: "center",
    justifyContent: "center",
  },
  bottomTabBar: {
    flexDirection: "row",
    width: "100%",
    alignItems: "center",
    justifyContent: "space-around",
    backgroundColor: C.card,
    borderTopWidth: 1,
    borderTopColor: C.lineCard,
    paddingBottom: Platform.OS === "ios" ? 22 : 12,
    paddingTop: 10,
    ...shadow.sheet,
  },
  bottomTabItem: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 2,
  },
  bottomTabIconContainer: {
    position: "relative",
    alignItems: "center",
    justifyContent: "center",
    width: 32,
    height: 28,
    borderRadius: R.pill,
  },
  bottomTabLabel: {
    fontSize: 11.5,
    fontWeight: "600",
    color: C.muted,
    letterSpacing: -0.1,
    marginTop: 4,
  },
  bottomTabLabelActive: {
    color: C.accent,
    fontWeight: "800",
  },
  bottomBadge: {
    position: "absolute",
    top: -4,
    right: -10,
    backgroundColor: C.line,
    minWidth: 17,
    height: 17,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  bottomBadgeActive: {
    backgroundColor: C.accent,
  },
  bottomBadgeText: {
    ...T.labelSm,
    fontSize: 9,
    color: C.ink2,
  },
  bottomBadgeTextActive: {
    color: C.white,
  },
  bottomStatusDot: {
    position: "absolute",
    top: 0,
    right: -2,
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: C.white,
  },
  scrollArea: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: S.screenX,
    paddingTop: S.xs,
    paddingBottom: 116,
  },
  timeScopeToggle: {
    flexDirection: "row",
    backgroundColor: C.card,
    borderRadius: R.pill,
    borderWidth: 1,
    borderColor: C.lineCard,
    padding: 3,
    gap: 2,
  },
  timeScopeBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: R.pill,
  },
  timeScopeBtnActive: {
    backgroundColor: C.ink,
  },
  timeScopeText: {
    ...T.labelSm,
    fontSize: 9,
    color: C.muted,
  },
  timeScopeTextActive: {
    color: C.white,
  },
  switchScopeBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: C.accent,
    borderRadius: R.pill,
    paddingVertical: 11,
    paddingHorizontal: 18,
    marginTop: 14,
  },
  switchScopeBtnText: {
    ...T.labelSm,
    color: C.white,
  },
  pullHintRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 14,
  },
  pullHintText: {
    ...T.caption,
    fontSize: 12,
    fontWeight: "600",
  },
  tabContent: {
    gap: S.md,
  },
  kpiRow: {
    flexDirection: "row",
    gap: 10,
  },
  kpiCard: {
    flex: 1,
    ...ui.card,
    padding: 14,
    gap: 4,
  },
  kpiLabel: {
    ...T.labelSm,
    fontSize: 9,
    color: C.muted,
  },
  kpiValue: {
    ...T.metric,
    fontSize: 26,
  },
  kpiSub: {
    ...T.caption,
    fontSize: 11,
  },
  searchRow: {
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
  },
  searchBox: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: C.card,
    borderRadius: R.md,
    paddingHorizontal: 14,
    height: 48,
    gap: 8,
    ...shadow.card,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: C.ink,
    paddingVertical: 8,
  },
  actionIconBtn: {
    width: 48,
    height: 48,
    borderRadius: R.md,
    backgroundColor: C.card,
    alignItems: "center",
    justifyContent: "center",
    ...shadow.card,
  },
  chipsScroll: {
    gap: 8,
    paddingVertical: 2,
  },
  chipItem: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: R.pill,
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.lineCard,
  },
  chipItemActive: {
    backgroundColor: C.ink,
    borderColor: C.ink,
  },
  chipText: {
    ...T.labelSm,
    color: C.muted,
  },
  chipTextActive: {
    color: C.white,
  },
  loadingBox: {
    padding: 32,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  loadingText: {
    ...T.caption,
  },
  emptyCard: {
    ...ui.card,
    padding: 32,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  emptyIconCircle: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: C.cardAlt,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  emptyTitle: {
    ...T.heading,
  },
  emptySub: {
    ...T.caption,
    textAlign: "center",
    maxWidth: 280,
  },
  feedCardList: {
    gap: 12,
  },
  feedCard: {
    ...ui.card,
    gap: 12,
  },
  suspendedCard: {
    opacity: 0.72,
    borderWidth: 1,
    borderColor: C.dangerSoft,
  },
  feedCardTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  workerAvatarCircle: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: C.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  workerAvatarText: {
    color: C.white,
    fontSize: 15,
    fontWeight: "800",
  },
  memberPhotoThumb: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 1,
    borderColor: C.lineCard,
  },
  feedCardInfo: {
    flex: 1,
    gap: 2,
  },
  feedWorkerName: {
    ...T.bodyStrong,
  },
  feedWorkerDept: {
    ...T.caption,
    fontSize: 12,
  },
  feedCardMeta: {
    alignItems: "flex-end",
    gap: 4,
  },
  feedTimeText: {
    ...T.labelSm,
    color: C.ink,
  },
  punctualityPill: {
    ...ui.pill,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  pillOnTime: {
    backgroundColor: C.successSoft,
  },
  pillLate: {
    backgroundColor: C.warnSoft,
  },
  punctualityText: {
    ...T.labelSm,
    fontSize: 9,
  },
  pillTextOnTime: {
    color: C.success,
  },
  pillTextLate: {
    color: C.warn,
  },
  feedCardDivider: {
    ...ui.divider,
  },
  feedCardBottom: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  verificationBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  verificationBadgeText: {
    ...T.caption,
    fontSize: 12,
    fontWeight: "500",
  },
  signedOutBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  signedOutBadgeText: {
    fontSize: 12,
    color: C.success,
    fontWeight: "600",
  },
  activeOnSiteBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  activeDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: C.success,
  },
  activeOnSiteText: {
    fontSize: 12,
    color: C.success,
    fontWeight: "600",
  },
  deviceBindingTag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  deviceBindingText: {
    ...T.caption,
    fontSize: 12,
  },
  card: {
    ...ui.card,
    gap: 12,
  },
  cardHeaderRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 8,
  },
  cardSectionTitle: {
    ...T.labelSm,
    color: C.ink,
  },
  cardSectionSub: {
    ...T.caption,
    fontSize: 12.5,
  },
  statusHeroCard: {
    ...ui.card,
    gap: 12,
  },
  statusHeroTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  statusHeroIconBox: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  statusHeroTitle: {
    ...T.heading,
  },
  statusHeroSub: {
    ...T.caption,
    fontSize: 12,
  },
  liveTagBadge: {
    ...ui.pill,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  liveTagText: {
    ...T.labelSm,
    fontSize: 9,
  },
  addressBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: C.cardAlt,
    borderRadius: R.md,
    padding: 12,
  },
  addressText: {
    ...T.caption,
    color: C.ink2,
    flex: 1,
  },
  modeCardsRow: {
    gap: 10,
  },
  modeChoiceCard: {
    backgroundColor: C.cardAlt,
    borderRadius: R.md,
    borderWidth: 1.5,
    borderColor: "transparent",
    padding: 14,
    gap: 4,
  },
  modeChoiceCardActive: {
    borderColor: C.ink,
    backgroundColor: C.card,
  },
  modeChoiceHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  modeChoiceTitle: {
    ...T.bodyStrong,
    fontSize: 14,
  },
  modeChoiceSub: {
    ...T.caption,
    fontSize: 12,
  },
  coordsBox: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    backgroundColor: C.cardAlt,
    borderRadius: R.md,
    padding: 14,
  },
  coordCol: {
    alignItems: "center",
    gap: 2,
  },
  coordLabel: {
    ...T.labelSm,
    fontSize: 9,
    color: C.muted,
  },
  coordVal: {
    fontSize: 14,
    fontWeight: "800",
    color: C.ink,
    fontFamily: MONO,
  },
  coordDivider: {
    width: 1,
    height: 24,
    backgroundColor: C.line,
  },
  radiusGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  radiusItem: {
    width: "31%",
    backgroundColor: C.cardAlt,
    borderRadius: R.md,
    borderWidth: 1.5,
    borderColor: "transparent",
    paddingVertical: 11,
    paddingHorizontal: 8,
    alignItems: "center",
    gap: 2,
  },
  radiusItemActive: {
    borderColor: C.ink,
    backgroundColor: C.ink,
  },
  radiusLabel: {
    fontSize: 13,
    fontWeight: "800",
    color: C.ink,
    fontFamily: MONO,
  },
  radiusLabelActive: {
    color: C.white,
  },
  radiusDesc: {
    fontSize: 10,
    color: C.muted,
  },
  radiusDescActive: {
    color: "rgba(255,255,255,0.75)",
  },
  inputGroup: {
    gap: 6,
  },
  inputLabel: {
    ...T.labelSm,
    color: C.ink,
  },
  textInput: {
    ...ui.input,
    height: 48,
    backgroundColor: C.cardAlt,
  },
  monoInput: {
    fontFamily: MONO,
  },
  secondaryScanBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: R.pill,
    backgroundColor: C.accentSoft,
  },
  secondaryScanBtnText: {
    ...T.labelSm,
    color: C.accent,
  },
  networkListContainer: {
    gap: 6,
  },
  networkListHeader: {
    ...T.labelSm,
    fontSize: 9,
    color: C.muted,
  },
  networkScroll: {
    maxHeight: 190,
  },
  networkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 12,
    borderRadius: R.sm,
    borderBottomWidth: 1,
    borderBottomColor: C.lineCard,
  },
  networkRowSelected: {
    backgroundColor: C.accentSoft,
  },
  networkSsid: {
    fontSize: 13,
    fontWeight: "700",
    color: C.ink,
  },
  networkSsidActive: {
    color: C.accent,
  },
  networkBssid: {
    ...T.labelSm,
    fontSize: 10,
    color: C.muted,
  },
  mapFrame: {
    borderRadius: R.md,
    borderWidth: 1,
    borderColor: C.lineCard,
    overflow: "hidden",
  },
  primaryActionBtn: {
    ...ui.btnPrimary,
    ...shadow.raised,
  },
  primaryActionBtnText: {
    ...ui.btnPrimaryText,
  },
  btnDisabled: {
    opacity: 0.6,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: C.overlay,
    justifyContent: "flex-end",
  },
  modalSheetCard: {
    ...ui.sheet,
    padding: S.lg,
    paddingBottom: Platform.OS === "ios" ? 36 : 24,
    maxHeight: "86%",
  },
  modalDragHandle: {
    ...ui.grabber,
    marginBottom: 14,
  },
  modalHeaderRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    marginBottom: S.md,
  },
  modalTitle: {
    ...T.title,
    fontSize: 18,
  },
  modalSubtitle: {
    ...T.caption,
  },
  modalCloseButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: C.cardAlt,
    alignItems: "center",
    justifyContent: "center",
  },
  modalBody: {
    gap: S.md,
  },
  detailCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: C.cardAlt,
    borderRadius: R.md,
    padding: 14,
  },
  detailAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: C.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  detailAvatarText: {
    color: C.white,
    fontSize: 17,
    fontWeight: "800",
  },
  memberPhotoModal: {
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: C.lineCard,
  },
  detailName: {
    ...T.heading,
  },
  detailDept: {
    ...T.caption,
  },
  detailEmail: {
    ...T.caption,
    fontSize: 12,
  },
  auditGrid: {
    backgroundColor: C.cardAlt,
    borderRadius: R.md,
    overflow: "hidden",
  },
  auditRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: C.lineCard,
  },
  auditLabel: {
    ...T.labelSm,
    color: C.muted,
  },
  auditValue: {
    fontSize: 13,
    fontWeight: "700",
    color: C.ink,
  },
  monoText: {
    fontFamily: MONO,
  },
  modalDismissBtn: {
    ...ui.btnPrimary,
  },
  modalDismissText: {
    ...ui.btnPrimaryText,
  },
  workerActionCol: {
    gap: 10,
  },
  workerActionBtn: {
    ...ui.btnSecondary,
    justifyContent: "flex-start",
    paddingHorizontal: 16,
    height: 50,
  },
  workerActionBtnWarning: {
    borderColor: C.warn,
    backgroundColor: C.warnSoft,
  },
  workerActionBtnDestructive: {
    borderColor: "rgba(217,45,32,0.25)",
    backgroundColor: C.dangerSoft,
  },
  workerActionBtnText: {
    ...T.labelSm,
    color: C.ink,
  },
  webNoticeCard: {
    backgroundColor: C.cardAlt,
    borderRadius: R.md,
    padding: 14,
    gap: 8,
  },
  webNoticeHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  webNoticeTitle: {
    ...T.labelSm,
    color: C.ink,
  },
  webNoticeText: {
    ...T.caption,
    fontSize: 12.5,
  },
  copyWebUrlBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 6,
  },
  copyWebUrlBtnText: {
    ...T.labelSm,
    color: C.accent,
  },
  adminSignOutBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: R.md,
    height: 50,
    backgroundColor: C.dangerSoft,
  },
  adminSignOutBtnText: {
    ...T.labelSm,
    color: C.danger,
  },
  adminFaceTestBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: C.cardAlt,
    borderRadius: R.md,
    padding: 14,
  },
  adminFaceTestBtnIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: C.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  adminFaceTestBtnTitle: {
    ...T.heading,
    fontSize: 14,
  },
  adminFaceTestBtnSub: {
    ...T.caption,
    fontSize: 12,
    marginTop: 2,
  },
  workforceFaceBanner: {
    ...ui.card,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 14,
  },
  workforceFaceBannerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    flex: 1,
  },
  workforceFaceIconBox: {
    ...ui.iconBubble,
  },
  workforceFaceTitle: {
    ...T.heading,
    fontSize: 14,
  },
  workforceFaceSub: {
    ...T.caption,
    fontSize: 12,
    marginTop: 2,
  },
  workforceFaceBadge: {
    backgroundColor: C.accent,
    borderRadius: R.pill,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  workforceFaceBadgeText: {
    ...T.labelSm,
    color: C.white,
  },
});
