import React, { useState, useEffect, useCallback, useRef } from "react";
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
  Modal,
  BackHandler,
  Keyboard,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import * as Location from "expo-location";
import { CameraView, useCameraPermissions } from "expo-camera";
import { doc, setDoc, updateDoc, onSnapshot } from "firebase/firestore";
import { db } from "../config/firebase";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { PresenceMapMobile } from "../components/PresenceMapMobile";
import {
  scanPhysicalWifiNetworks,
  ScannedWifiNetwork,
} from "../services/wifiScanService";
import { updateOrganizationAnchors as updateAnchorsService } from "../services/organizationService";
import {
  searchGlobalLocations,
  reverseGeocodeCoords,
  GeocodedLocation,
} from "../services/geocodingService";

const RADIUS_OPTIONS = [10, 20, 30, 50, 80, 100];

export default function CalibrateScreen() {
  const { organization, updateAnchors, signOut } = useAuth();
  const toast = useToast();

  // Camera permissions
  const [permission, requestPermission] = useCameraPermissions();

  // QR Pairing Gate: Admin must scan the active Web Portal QR code to unlock calibration
  const [isQrPaired, setIsQrPaired] = useState(false);
  const [isConnectingSession, setIsConnectingSession] = useState(false);
  const [scanCooldown, setScanCooldown] = useState(false);
  const hasHandshakedRef = useRef(false);

  // Paired organization info (from QR payload or active session)
  const [pairedOrgId, setPairedOrgId] = useState<string>("");
  const [pairedOrgName, setPairedOrgName] = useState<string>("");
  const [pairedOrgCode, setPairedOrgCode] = useState<string>("");

  // Verification Architecture Mode: HYBRID (Wi-Fi + GPS) vs GEOFENCE_ONLY (Router-free)
  const [calibrationMode, setCalibrationMode] = useState<
    "HYBRID" | "GEOFENCE_ONLY"
  >("HYBRID");

  // Tier 1: Wi-Fi Anchor State
  const [availableNetworks, setAvailableNetworks] = useState<
    ScannedWifiNetwork[]
  >([]);
  const [isScanningWifi, setIsScanningWifi] = useState(false);
  const [selectedSsid, setSelectedSsid] = useState<string>("");
  const [selectedBssid, setSelectedBssid] = useState<string>("");
  const [showManualWifi, setShowManualWifi] = useState(false);
  const [wifiFilterQuery, setWifiFilterQuery] = useState("");
  const [wifiScanNotice, setWifiScanNotice] = useState<string | null>(null);

  // Tier 2: Geofence State
  const [latitude, setLatitude] = useState<number>(4.975);
  const [longitude, setLongitude] = useState<number>(8.3417);
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [radiusMeters, setRadiusMeters] = useState<number>(10);
  const [locationName, setLocationName] = useState<string>("");
  const [isLocating, setIsLocating] = useState(false);
  const [addressSearchQuery, setAddressSearchQuery] = useState("");
  const [isSearchingAddress, setIsSearchingAddress] = useState(false);
  const [searchResults, setSearchResults] = useState<GeocodedLocation[]>([]);
  const [showSearchResults, setShowSearchResults] = useState(false);

  // Form Submission
  const [isSaving, setIsSaving] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  const isSavedSuccessfullyRef = useRef(false);
  const hasSentDisconnectRef = useRef(false);
  const sessionOrgIdRef = useRef<string>("");
  const pairedOrgIdRef = useRef<string>("");

  useEffect(() => {
    const id = pairedOrgId || organization?.id || "";
    if (id) {
      pairedOrgIdRef.current = id;
      sessionOrgIdRef.current = id;
    }
  }, [pairedOrgId, organization?.id]);

  // Kill signal: notify web portal immediately that mobile device has disconnected
  const sendDisconnectSignal = useCallback(
    async (orgId?: string) => {
      if (hasSentDisconnectRef.current || isSavedSuccessfullyRef.current) return;
      hasSentDisconnectRef.current = true;
      const target =
        orgId ||
        sessionOrgIdRef.current ||
        pairedOrgIdRef.current ||
        pairedOrgId ||
        organization?.id;
      if (!target) return;
      try {
        await Promise.all([
          setDoc(
            doc(db, "churches", target),
            {
              calibrationSession: {
                status: "DISCONNECTED",
                disconnectedAt: new Date().toISOString(),
                source: "MOBILE_APP",
              },
            },
            { merge: true },
          ).catch(() => {}),
          setDoc(
            doc(db, "churches", target, "calibration", "session"),
            {
              status: "DISCONNECTED",
              disconnectedAt: new Date().toISOString(),
              source: "MOBILE_APP",
            },
            { merge: true },
          ).catch(() => {}),
        ]);
      } catch (err) {
        console.warn("Could not send disconnect kill signal:", err);
      }
    },
    [],
  );

  // Safe navigation handler (with instant kill signal if leaving before saving)
  const handleGoBack = useCallback(async () => {
    if (!isSavedSuccessfullyRef.current) {
      await sendDisconnectSignal();
    }
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace("/login");
    }
  }, [sendDisconnectSignal]);

  // Listen for Android hardware back button
  useEffect(() => {
    const backSub = BackHandler.addEventListener("hardwareBackPress", () => {
      handleGoBack();
      return true;
    });
    return () => backSub.remove();
  }, [handleGoBack]);

  // Cleanup on unmount: if user exits screen without saving, kill the session
  useEffect(() => {
    return () => {
      if (!isSavedSuccessfullyRef.current && sessionOrgIdRef.current) {
        sendDisconnectSignal(sessionOrgIdRef.current);
      }
    };
  }, [sendDisconnectSignal]);

  // Listen for remote disconnect signal from Admin Web Portal
  useEffect(() => {
    const targetOrgId = pairedOrgId || sessionOrgIdRef.current;
    if (!targetOrgId || !isQrPaired) return;

    const sessionRef = doc(db, "churches", targetOrgId, "calibration", "session");
    let isInitial = true;

    const unsubscribe = onSnapshot(
      sessionRef,
      (snap) => {
        if (isInitial) {
          isInitial = false;
          return;
        }
        if (snap.exists()) {
          const data = snap.data();
          // Only show Web Admin alert if the Web Admin terminated the session
          if (
            !isSavedSuccessfullyRef.current &&
            !hasSentDisconnectRef.current &&
            (data?.status === "DISCONNECTED" || data?.status === "CANCELLED") &&
            (data?.source === "WEB_PORTAL" || data?.reason === "ADMIN_LEFT_PAGE")
          ) {
            toast.warn("Calibration session ended by Web Admin.");
            setIsQrPaired(false);
            setPairedOrgId("");
            sessionOrgIdRef.current = "";
            pairedOrgIdRef.current = "";
            hasHandshakedRef.current = false;
            setScanCooldown(false);
          }
        }
      },
      (err) => {
        console.warn("Mobile session listener warning:", err);
      },
    );

    return () => unsubscribe();
  }, [pairedOrgId, isQrPaired]);

  // Reverse geocode to display address name
  const reverseGeocode = async (lat: number, lng: number) => {
    try {
      const info = await reverseGeocodeCoords(lat, lng);
      if (info && info.displayName) {
        setLocationName(info.displayName);
      }
    } catch {
      // ignore
    }
  };

  // Load existing organization configuration if available
  useEffect(() => {
    if (organization) {
      setPairedOrgId(organization.id);
      setPairedOrgName(
        organization.churchName || organization.branchName || "Organization",
      );
      setPairedOrgCode(organization.churchCode || "ORG");

      if (organization.beaconConfig?.ssidHint) {
        setSelectedSsid(organization.beaconConfig.ssidHint);
      }
      if (organization.beaconConfig?.targetBssid) {
        setSelectedBssid(organization.beaconConfig.targetBssid);
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

  // Scan Real Wi-Fi Networks & Mobile Hotspots
  const handleScanWifi = useCallback(async () => {
    setIsScanningWifi(true);
    setWifiScanNotice(null);
    try {
      const res = await scanPhysicalWifiNetworks();
      if (res.success && res.networks) {
        setAvailableNetworks(res.networks);
        // If an active connected network or hotspot is detected, auto-select it if none selected yet
        const inUse = res.networks.find((n) => n.inUse);
        if (inUse && !selectedBssid) {
          setSelectedSsid(inUse.ssid);
          setSelectedBssid(inUse.bssid);
        }
      }
      if (res.error) {
        setWifiScanNotice(res.error);
        toast.warn(res.error, { duration: 6000 });
      }
    } catch (err: any) {
      console.warn("Could not scan Wi-Fi signals:", err);
      toast.error("Could not scan wireless signals.");
    } finally {
      setIsScanningWifi(false);
    }
  }, [selectedBssid, toast]);

  // Fetch Current Phone GPS Location (Fast cached lookup + high accuracy refinement)
  const handleGetCurrentLocation = async () => {
    setIsLocating(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        toast.warn(
          "Location permission is required to acquire GPS coordinates.",
        );
        setIsLocating(false);
        return;
      }

      // 1. Immediately read last known location for near-instant response (< 50ms)
      const lastKnown = await Location.getLastKnownPositionAsync().catch(
        () => null,
      );
      if (lastKnown && lastKnown.coords) {
        const lat = parseFloat(lastKnown.coords.latitude.toFixed(6));
        const lng = parseFloat(lastKnown.coords.longitude.toFixed(6));
        setLatitude(lat);
        setLongitude(lng);
        setAccuracy(Math.round(lastKnown.coords.accuracy || 15));
        reverseGeocode(lat, lng);
      }

      // 2. Fetch fresh high-accuracy position with 12s timeout
      const locPromise = Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });
      const timeoutPromise = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), 12000),
      );
      const loc = (await Promise.race([
        locPromise,
        timeoutPromise,
      ])) as Location.LocationObject | null;

      if (loc && loc.coords) {
        const lat = parseFloat(loc.coords.latitude.toFixed(6));
        const lng = parseFloat(loc.coords.longitude.toFixed(6));
        setLatitude(lat);
        setLongitude(lng);
        setAccuracy(Math.round(loc.coords.accuracy || 5));
        reverseGeocode(lat, lng);
      }
    } catch (err: any) {
      console.warn("Could not acquire current GPS location:", err);
      toast.error("Could not acquire current device location.");
    } finally {
      setIsLocating(false);
    }
  };

  const selectLocationResult = (loc: GeocodedLocation) => {
    setLatitude(loc.lat);
    setLongitude(loc.lng);
    setAccuracy(10);
    setLocationName(loc.displayName || loc.name);
    setAddressSearchQuery(loc.name || loc.displayName);
    setShowSearchResults(false);
    toast.success(`Pinned: ${loc.name}`);
  };

  // Search address/venue and fly map to located position
  const handleSearchAddress = async () => {
    if (!addressSearchQuery.trim()) return;
    setIsSearchingAddress(true);
    Keyboard.dismiss();
    try {
      const results = await searchGlobalLocations(addressSearchQuery.trim());
      if (results && results.length > 0) {
        setSearchResults(results);
        selectLocationResult(results[0]);
        if (results.length > 1 && results[0].category !== "coordinates") {
          setShowSearchResults(true);
        }
      } else {
        toast.warn(
          "Address not found. Please try another search or drag the pin on the map.",
        );
      }
    } catch (e: any) {
      toast.error(e?.message || "Failed to search location.");
    } finally {
      setIsSearchingAddress(false);
    }
  };

  // Rapid QR Barcode Scanner (<50ms recognition like WhatsApp/Xender)
  const handleBarcodeScanned = async ({ data }: { data: string }) => {
    if (scanCooldown || hasHandshakedRef.current) return;
    setScanCooldown(true);
    hasHandshakedRef.current = true;

    try {
      let parsed: any = null;
      try {
        parsed = JSON.parse(data);
      } catch {
        if (data.includes("CALIBRATE_ANCHORS")) {
          parsed = {
            type: "CALIBRATE_ANCHORS",
            churchId: data,
            churchCode: "ORG",
          };
        }
      }

      const targetId = parsed?.id || parsed?.churchId;
      const targetCode =
        parsed?.c || parsed?.code || parsed?.churchCode || "ORG";
      const targetName =
        parsed?.n || parsed?.name || parsed?.churchName || "Organization";

      if (targetId) {
        sessionOrgIdRef.current = targetId;
        pairedOrgIdRef.current = targetId;
        hasSentDisconnectRef.current = false;
        isSavedSuccessfullyRef.current = false;
        // INSTANT: Dismiss camera immediately and display loading transition overlay
        setIsConnectingSession(true);
        setPairedOrgId(targetId);
        setPairedOrgName(targetName);
        setPairedOrgCode(targetCode);

        // Extract QR calibration mode (defaults to HYBRID for backward compatibility)
        const targetMode: "HYBRID" | "GEOFENCE_ONLY" =
          parsed?.mode === "GEOFENCE_ONLY" || parsed?.m === "GEOFENCE_ONLY"
            ? "GEOFENCE_ONLY"
            : "HYBRID";
        setCalibrationMode(targetMode);

        // Send instant handshake ping to Firestore in background (both main doc and subcollection doc)
        const sessionPayload = {
          status: "CONNECTED",
          connectedAt: new Date().toISOString(),
          platform: Platform.OS,
          mode: targetMode,
        };

        setDoc(
          doc(db, "churches", targetId),
          {
            calibrationSession: sessionPayload,
          },
          { merge: true },
        ).catch((e) =>
          console.warn("Could not write handshake to church doc:", e),
        );

        setDoc(
          doc(db, "churches", targetId, "calibration", "session"),
          sessionPayload,
          { merge: true },
        ).catch((e) => {
          console.warn("Could not write handshake ping to session doc:", e);
        });

        // Trigger appropriate sensors based on selected mode
        if (targetMode === "GEOFENCE_ONLY") {
          setSelectedSsid("Office Geofence Zone");
          setSelectedBssid("");
          handleGetCurrentLocation();
        } else {
          handleScanWifi();
          handleGetCurrentLocation();
        }

        // Smooth transition to calibration workspace
        setTimeout(() => {
          setIsQrPaired(true);
          setIsConnectingSession(false);
          toast.success(
            targetMode === "GEOFENCE_ONLY"
              ? `Paired in GPS-Only Mode with ${targetName}!`
              : `Live paired with ${targetName}!`,
          );
        }, 350);
      } else {
        setScanCooldown(false);
        hasHandshakedRef.current = false;
        toast.warn(
          "Unrecognized QR code. Please scan the QR code from the Admin Web Portal.",
        );
      }
    } catch {
      setScanCooldown(false);
      hasHandshakedRef.current = false;
    }
  };

  const handleSelectNetwork = (net: ScannedWifiNetwork) => {
    setSelectedSsid(net.ssid);
    setSelectedBssid(net.bssid);
    // Silent selection: visual highlights update instantly without toast popup
  };

  const handleInitiateSave = () => {
    const targetOrgId = pairedOrgId || organization?.id;
    if (!targetOrgId) {
      toast.warn(
        "Please scan the Admin Web QR code first to identify the organization.",
      );
      return;
    }

    // Only validate Wi-Fi router in HYBRID mode
    if (calibrationMode === "HYBRID") {
      if (!selectedBssid.trim()) {
        toast.warn(
          "Please select or enter your premises Wi-Fi router BSSID (MAC). If you do not have a router, switch to 'GPS Geofence Only' mode above.",
        );
        return;
      }
      if (!selectedSsid.trim()) {
        toast.warn("Please enter a router SSID label.");
        return;
      }
    }

    if (!latitude || !longitude) {
      toast.warn("Please set a valid geolocation coordinate.");
      return;
    }

    setShowConfirmModal(true);
  };

  const handleConfirmSave = async () => {
    setShowConfirmModal(false);
    const targetOrgId = pairedOrgId || organization?.id;
    if (!targetOrgId) return;

    setIsSaving(true);
    try {
      const finalSsid =
        calibrationMode === "GEOFENCE_ONLY"
          ? selectedSsid.trim() || "Office Geofence Zone"
          : selectedSsid.trim();
      const finalBssid =
        calibrationMode === "GEOFENCE_ONLY"
          ? ""
          : selectedBssid.trim().toLowerCase();

      await updateAnchorsService(targetOrgId, {
        verificationMode: calibrationMode,
        ssidHint: finalSsid,
        targetBssid: finalBssid,
        latitude,
        longitude,
        radiusMeters,
      });

      if (organization?.id === targetOrgId) {
        updateAnchors({
          verificationMode: calibrationMode,
          ssidHint: finalSsid,
          targetBssid: finalBssid,
          latitude,
          longitude,
          radiusMeters,
        }).catch(() => {});
      }

      // Notify web portal calibration session is completed in real-time
      try {
        await setDoc(
          doc(db, "churches", targetOrgId, "calibration", "session"),
          {
            status: "COMPLETED",
            completedAt: new Date().toISOString(),
            platform: Platform.OS,
          },
          { merge: true },
        );
      } catch (e) {
        console.warn("Could not write completed status to Firestore:", e);
      }

      isSavedSuccessfullyRef.current = true;
      toast.success("Organization anchors calibrated and saved successfully!");
      handleGoBack();
    } catch (err: any) {
      toast.error(err?.message || "Failed to save calibration settings.");
    } finally {
      setIsSaving(false);
    }
  };

  // Filter available Wi-Fi networks by search query
  const filteredNetworks = availableNetworks.filter(
    (n) =>
      !wifiFilterQuery.trim() ||
      n.ssid.toLowerCase().includes(wifiFilterQuery.toLowerCase()) ||
      n.bssid.toLowerCase().includes(wifiFilterQuery.toLowerCase()),
  );

  return (
    <SafeAreaView style={styles.safeArea}>
      {/* ========================================================
          MODE 1: QR CODE AUTHENTICATION SCANNER
          Locked until the admin scans the active Web Portal QR code
          ======================================================== */}
      {!isQrPaired ? (
        <View style={styles.scannerWrapper}>
          {/* Header */}
          <View style={styles.header}>
            <TouchableOpacity
              style={styles.backButton}
              onPress={handleGoBack}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Ionicons name="chevron-back" size={24} color="#FFFFFF" />
            </TouchableOpacity>
            <View style={styles.headerTitleGroup}>
              <Text style={[styles.headerTitle, { color: "#FFFFFF" }]}>
                Scan Web Portal QR Code
              </Text>
              <Text style={[styles.headerSubtitle, { color: "#94A3B8" }]}>
                Point camera at Admin Web to pair and calibrate
              </Text>
            </View>
            <TouchableOpacity
              style={{
                padding: 7,
                borderRadius: 8,
                backgroundColor: "rgba(239, 68, 68, 0.25)",
              }}
              onPress={async () => {
                const target =
                  sessionOrgIdRef.current || pairedOrgId || organization?.id;
                await sendDisconnectSignal(target);
                await signOut();
                toast.info("Signed out.");
                router.replace("/login");
              }}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Ionicons name="log-out-outline" size={20} color="#EF4444" />
            </TouchableOpacity>
          </View>

          {/* Camera View or Loading Transition */}
          {isConnectingSession ? (
            <View style={styles.loadingTransitionOverlay}>
              <View style={styles.loadingTransitionCard}>
                <View style={styles.loadingIconBox}>
                  <Ionicons name="qr-code" size={32} color="#0284C7" />
                </View>
                <ActivityIndicator
                  size="large"
                  color="#0284C7"
                  style={{ marginVertical: 18 }}
                />
                <Text style={styles.loadingTransitionTitle}>
                  QR Code Linked!
                </Text>
                <Text style={styles.loadingTransitionSubtitle}>
                  Connecting to Web Portal & loading calibration workspace...
                </Text>
              </View>
            </View>
          ) : !permission?.granted ? (
            <View style={styles.permissionBox}>
              <Ionicons name="camera-outline" size={48} color="#94A3B8" />
              <Text style={styles.permTitle}>Camera Permission Required</Text>
              <Text style={styles.permText}>
                Presenti needs camera access to scan the calibration QR code
                displayed on your Admin Web Portal.
              </Text>
              <TouchableOpacity
                style={styles.primaryBtn}
                onPress={requestPermission}
              >
                <Text style={styles.primaryBtnText}>Grant Camera Access</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={StyleSheet.absoluteFill}>
              <CameraView
                style={StyleSheet.absoluteFill}
                facing="back"
                barcodeScannerSettings={{
                  barcodeTypes: ["qr"],
                }}
                onBarcodeScanned={
                  scanCooldown ? undefined : handleBarcodeScanned
                }
              />

              {/* High-Contrast Scanner Reticle Overlay */}
              <View style={styles.reticleOverlay}>
                <View style={styles.reticleUnfocused} />
                <View style={styles.reticleMiddleRow}>
                  <View style={styles.reticleUnfocused} />
                  <View style={styles.reticleTarget}>
                    <View style={[styles.corner, styles.topLeft]} />
                    <View style={[styles.corner, styles.topRight]} />
                    <View style={[styles.corner, styles.bottomLeft]} />
                    <View style={[styles.corner, styles.bottomRight]} />
                  </View>
                  <View style={styles.reticleUnfocused} />
                </View>
                <View style={styles.reticleUnfocused}>
                  {/* <View style={styles.hintCard}>
                    <Ionicons
                      name="qr-code-outline"
                      size={20}
                      color="#38BDF8"
                    />
                    <View style={{ flex: 1, gap: 4 }}>
                      <Text style={styles.hintText}>
                        Point your camera at the QR code on your computer screen
                        (Admin Web &gt; Settings &gt; Premises Anchors)
                      </Text>
                      <View
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 5,
                          marginTop: 2,
                        }}
                      >
                        <Ionicons
                          name="information-circle-outline"
                          size={14}
                          color="#FBBF24"
                        />
                        <Text
                          style={{
                            color: "#FDE68A",
                            fontSize: 11,
                            fontWeight: "600",
                          }}
                        >
                          Ensure this phone's Wi-Fi &amp; GPS are turned ON
                        </Text>
                      </View>
                    </View> 
                  </View> */}
                </View>
              </View>
            </View>
          )}
        </View>
      ) : (
        /* ========================================================
            MODE 2: CALIBRATION CONFIGURATION SCREEN
            Unlocked after scanning the Admin Web Portal QR Code
            ======================================================== */
        <View style={{ flex: 1 }}>
          <View style={styles.header}>
            <TouchableOpacity
              style={styles.backButton}
              onPress={handleGoBack}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Ionicons name="chevron-back" size={24} color="#142748" />
            </TouchableOpacity>
            <View style={styles.headerTitleGroup}>
              <Text style={styles.headerTitle}>Calibrate Premises</Text>
              <Text style={styles.headerSubtitle}>
                {pairedOrgName || organization?.churchName || "Organization"} •{" "}
                {pairedOrgCode || organization?.churchCode || "ORG"}
              </Text>
            </View>
            <View
              style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
            >
              <TouchableOpacity
                style={styles.refreshHeaderBtn}
                onPress={handleScanWifi}
                disabled={isScanningWifi}
              >
                <Ionicons
                  name="refresh"
                  size={20}
                  color={isScanningWifi ? "#94A3B8" : "#0284C7"}
                />
              </TouchableOpacity>
              <TouchableOpacity
                style={{
                  padding: 7,
                  borderRadius: 8,
                  backgroundColor: "#FEE2E2",
                }}
                onPress={async () => {
                  const target =
                    sessionOrgIdRef.current || pairedOrgId || organization?.id;
                  await sendDisconnectSignal(target);
                  await signOut();
                  toast.info("Signed out.");
                  router.replace("/login");
                }}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Ionicons name="log-out-outline" size={20} color="#EF4444" />
              </TouchableOpacity>
            </View>
          </View>

          <ScrollView
            style={styles.scrollView}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            {/* Live Paired Status Banner */}
            <View style={styles.connectedCard}>
              <View style={styles.connectedIcon}>
                <Ionicons name="link-outline" size={18} color="#059669" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.connectedTitle}>
                  Live Paired with Web Portal
                </Text>
                <Text style={styles.connectedSub}>
                  Organization:{" "}
                  <Text style={{ fontWeight: "700", color: "#142748" }}>
                    {pairedOrgName}
                  </Text>{" "}
                  ({pairedOrgCode})
                </Text>
              </View>
              <TouchableOpacity
                style={styles.rescanBtn}
                onPress={async () => {
                  await sendDisconnectSignal();
                  hasHandshakedRef.current = false;
                  setScanCooldown(false);
                  setIsQrPaired(false);
                }}
              >
                <Ionicons name="scan-outline" size={13} color="#0284C7" />
                <Text style={styles.rescanBtnText}>Rescan</Text>
              </TouchableOpacity>
            </View>

            {/* Section 1: Premises Wi-Fi Router (HYBRID ONLY) OR Geofence-Only Banner */}
            {calibrationMode === "GEOFENCE_ONLY" ? (
              <View style={styles.geofenceOnlyCard}>
                <View style={styles.geofenceOnlyIconBox}>
                  <Ionicons name="navigate-circle" size={28} color="#16A34A" />
                </View>
                <View style={{ flex: 1 }}>
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 6,
                      marginBottom: 2,
                    }}
                  >
                    <Text style={styles.geofenceOnlyTitle}>
                      Router-Free GPS Geofence Mode
                    </Text>
                    <View
                      style={{
                        backgroundColor: "#DCFCE7",
                        paddingHorizontal: 6,
                        paddingVertical: 2,
                        borderRadius: 4,
                      }}
                    >
                      <Text
                        style={{
                          fontSize: 10,
                          fontWeight: "700",
                          color: "#16A34A",
                        }}
                      >
                        ACTIVE
                      </Text>
                    </View>
                  </View>
                  <Text style={styles.geofenceOnlyDesc}>
                    Your workplace attendance is configured for pure satellite
                    GPS verification. No physical office router required.
                    Pinpoint your venue and set your allowed perimeter radius
                    below.
                  </Text>
                </View>
              </View>
            ) : (
              <>
                <View style={styles.modeCard}>
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      justifyContent: "space-between",
                      marginBottom: 6,
                    }}
                  >
                    <Text style={styles.modeCardLabel}>
                      VERIFICATION ARCHITECTURE
                    </Text>
                    <View
                      style={{
                        backgroundColor: "#E0F2FE",
                        paddingHorizontal: 6,
                        paddingVertical: 2,
                        borderRadius: 4,
                      }}
                    >
                      <Text
                        style={{
                          fontSize: 10,
                          fontWeight: "700",
                          color: "#0369A1",
                        }}
                      >
                        HYBRID SECURITY
                      </Text>
                    </View>
                  </View>
                  <Text
                    style={{ fontSize: 13, color: "#475569", lineHeight: 18 }}
                  >
                    Dual-Tier Hybrid Security. Workers authenticate against your
                    physical office router MAC, backed by automated satellite
                    GPS failover.
                  </Text>
                </View>

                <View style={styles.card}>
                  <View style={styles.cardHeader}>
                    <View
                      style={[
                        styles.cardIconBox,
                        { backgroundColor: "#EFF6FF" },
                      ]}
                    >
                      <Ionicons name="wifi" size={20} color="#0284C7" />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.cardTitle}>
                        1. Premises Wi-Fi Router (Anchor)
                      </Text>
                      <Text style={styles.cardSubtitle}>
                        Select the physical router in your workplace premises
                      </Text>
                    </View>
                    <TouchableOpacity
                      style={styles.scanActionBtn}
                      onPress={handleScanWifi}
                      disabled={isScanningWifi}
                    >
                      {isScanningWifi ? (
                        <ActivityIndicator size="small" color="#0284C7" />
                      ) : (
                        <Text style={styles.scanActionText}>Rescan</Text>
                      )}
                    </TouchableOpacity>
                  </View>

                  {/* Phone Wi-Fi & GPS Mandatory Requirement Banner */}
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "flex-start",
                      gap: 10,
                      backgroundColor:
                        availableNetworks.length === 0 ? "#FEF3C7" : "#F0F9FF",
                      padding: 12,
                      borderRadius: 10,
                      borderWidth: 1,
                      borderColor:
                        availableNetworks.length === 0 ? "#FCD34D" : "#BAE6FD",
                      marginHorizontal: 16,
                      marginTop: 12,
                      marginBottom: 4,
                    }}
                  >
                    <Ionicons
                      name={
                        availableNetworks.length === 0
                          ? "warning-outline"
                          : "information-circle-outline"
                      }
                      size={18}
                      color={
                        availableNetworks.length === 0 ? "#D97706" : "#0284C7"
                      }
                    />
                    <View style={{ flex: 1 }}>
                      <Text
                        style={{
                          fontSize: 12,
                          fontWeight: "700",
                          color:
                            availableNetworks.length === 0
                              ? "#92400E"
                              : "#0369A1",
                          marginBottom: 2,
                        }}
                      >
                        Phone Wi-Fi Must Be Turned ON
                      </Text>
                      <Text
                        style={{
                          fontSize: 11,
                          color:
                            availableNetworks.length === 0
                              ? "#B45309"
                              : "#475569",
                          lineHeight: 16,
                        }}
                      >
                        {wifiScanNotice ||
                          "Swipe down from top of your phone screen to ensure both Wi-Fi and Location (GPS) toggles are turned ON to detect premises routers and mobile hotspots."}
                      </Text>
                    </View>
                  </View>

                  {/* Wi-Fi Filter Search Box */}
                  <View style={styles.wifiFilterBox}>
                    <Ionicons name="search" size={15} color="#94A3B8" />
                    <TextInput
                      style={styles.wifiFilterInput}
                      value={wifiFilterQuery}
                      onChangeText={setWifiFilterQuery}
                      placeholder="Filter or search nearby Wi-Fi..."
                      placeholderTextColor="#94A3B8"
                    />
                  </View>

                  {/* Scanned Networks List */}
                  <View style={styles.wifiListContainer}>
                    {isScanningWifi && availableNetworks.length === 0 ? (
                      <View style={styles.emptyState}>
                        <ActivityIndicator size="small" color="#0284C7" />
                        <Text style={styles.emptyStateText}>
                          Scanning nearby radio airwaves...
                        </Text>
                      </View>
                    ) : filteredNetworks.length > 0 ? (
                      filteredNetworks.map((net) => {
                        const isSelected =
                          Boolean(selectedBssid) &&
                          selectedBssid.toLowerCase() ===
                            net.bssid.toLowerCase();
                        return (
                          <TouchableOpacity
                            key={net.bssid + net.ssid}
                            style={[
                              styles.wifiItem,
                              isSelected && styles.wifiItemActive,
                            ]}
                            onPress={() => handleSelectNetwork(net)}
                          >
                            <View style={styles.wifiItemLeft}>
                              <Ionicons
                                name={
                                  isSelected
                                    ? "radio-button-on"
                                    : "radio-button-off"
                                }
                                size={18}
                                color={isSelected ? "#0284C7" : "#94A3B8"}
                              />
                              <View style={{ marginLeft: 8 }}>
                                <Text
                                  style={[
                                    styles.wifiItemSsid,
                                    isSelected && styles.wifiItemSsidActive,
                                  ]}
                                >
                                  {net.ssid}
                                </Text>
                                <Text style={styles.wifiItemBssid}>
                                  {net.bssid}
                                </Text>
                              </View>
                            </View>
                            <View style={styles.wifiItemRight}>
                              {net.inUse && (
                                <View
                                  style={{
                                    backgroundColor: "#ECFDF5",
                                    paddingHorizontal: 6,
                                    paddingVertical: 2,
                                    borderRadius: 4,
                                    marginRight: 4,
                                    borderWidth: 1,
                                    borderColor: "#A7F3D0",
                                  }}
                                >
                                  <Text
                                    style={{
                                      fontSize: 9,
                                      fontWeight: "700",
                                      color: "#059669",
                                    }}
                                  >
                                    CONNECTED
                                  </Text>
                                </View>
                              )}
                              {net.band && (
                                <Text style={styles.wifiBandBadge}>
                                  {net.band}
                                </Text>
                              )}
                              {isSelected && (
                                <View style={styles.selectedPill}>
                                  <Text style={styles.selectedPillText}>
                                    Selected
                                  </Text>
                                </View>
                              )}
                            </View>
                          </TouchableOpacity>
                        );
                      })
                    ) : (
                      <View style={styles.emptyState}>
                        <Ionicons
                          name="wifi-outline"
                          size={36}
                          color="#94A3B8"
                          style={{ marginBottom: 8 }}
                        />
                        <Text
                          style={[
                            styles.emptyStateText,
                            {
                              fontWeight: "700",
                              color: "#334155",
                              marginBottom: 4,
                            },
                          ]}
                        >
                          No Wireless Networks Detected
                        </Text>
                        <Text style={styles.emptyStateText}>
                          Please swipe down from the top of your phone screen to
                          make sure Wi-Fi and Location (GPS) are toggled ON.
                        </Text>
                        <TouchableOpacity
                          style={{
                            marginTop: 14,
                            backgroundColor: "#0284C7",
                            paddingHorizontal: 16,
                            paddingVertical: 9,
                            borderRadius: 8,
                            flexDirection: "row",
                            alignItems: "center",
                            gap: 6,
                          }}
                          onPress={handleScanWifi}
                          activeOpacity={0.8}
                        >
                          <Ionicons name="refresh" size={15} color="#FFFFFF" />
                          <Text
                            style={{
                              color: "#FFFFFF",
                              fontWeight: "700",
                              fontSize: 13,
                            }}
                          >
                            Rescan Wi-Fi &amp; Hotspots
                          </Text>
                        </TouchableOpacity>
                      </View>
                    )}
                  </View>

                  {/* Toggle for manual MAC input */}
                  <TouchableOpacity
                    style={styles.manualToggle}
                    onPress={() => setShowManualWifi(!showManualWifi)}
                  >
                    <Text style={styles.manualToggleText}>
                      {showManualWifi
                        ? "Hide Manual Inputs"
                        : "Manual Router MAC / Hidden SSID Entry"}
                    </Text>
                    <Ionicons
                      name={showManualWifi ? "chevron-up" : "chevron-down"}
                      size={14}
                      color="#0284C7"
                    />
                  </TouchableOpacity>

                  {showManualWifi && (
                    <View style={styles.manualInputsGroup}>
                      <View style={styles.field}>
                        <Text style={styles.fieldLabel}>
                          Router SSID Name *
                        </Text>
                        <TextInput
                          style={styles.input}
                          value={selectedSsid}
                          onChangeText={setSelectedSsid}
                          placeholder="e.g. Office_Guest_5G"
                          placeholderTextColor="#94A3B8"
                        />
                      </View>

                      <View style={styles.field}>
                        <Text style={styles.fieldLabel}>
                          Router Hardware MAC (BSSID) *
                        </Text>
                        <TextInput
                          style={[
                            styles.input,
                            {
                              fontFamily:
                                Platform.OS === "ios" ? "Menlo" : "monospace",
                            },
                          ]}
                          value={selectedBssid}
                          onChangeText={setSelectedBssid}
                          placeholder="0c:61:f9:65:8f:07"
                          placeholderTextColor="#94A3B8"
                          autoCapitalize="none"
                        />
                      </View>
                    </View>
                  )}
                </View>
              </>
            )}

            {/* Section 2: Interactive Geolocation Satellite Map */}
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <View
                  style={[styles.cardIconBox, { backgroundColor: "#F0FDF4" }]}
                >
                  <Ionicons name="location" size={20} color="#16A34A" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle}>
                    {calibrationMode === "GEOFENCE_ONLY"
                      ? "Premises Perimeter Geofence (GPS)"
                      : "2. Geofence Perimeter (GPS Fallback)"}
                  </Text>
                  <Text style={styles.cardSubtitle}>
                    Search venue, drag the marker, or tap Phone GPS
                  </Text>
                </View>
              </View>

              {/* Venue Search Bar */}
              <View style={styles.venueSearchRow}>
                <Ionicons name="navigate-outline" size={16} color="#0284C7" />
                <TextInput
                  style={styles.venueSearchInput}
                  value={addressSearchQuery}
                  onChangeText={(text) => {
                    setAddressSearchQuery(text);
                    if (showSearchResults) setShowSearchResults(false);
                  }}
                  placeholder="Search venue, city, or state (e.g. Calabar, CRS)..."
                  placeholderTextColor="#94A3B8"
                  onSubmitEditing={handleSearchAddress}
                  returnKeyType="search"
                />
                <TouchableOpacity
                  style={styles.venueSearchBtn}
                  onPress={handleSearchAddress}
                  disabled={isSearchingAddress}
                >
                  {isSearchingAddress ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : (
                    <Text style={styles.venueSearchBtnText}>Search</Text>
                  )}
                </TouchableOpacity>
              </View>

              {/* Autocomplete / Search Suggestions Dropdown */}
              {showSearchResults && searchResults.length > 1 && (
                <View style={styles.searchDropdown}>
                  <View style={styles.searchDropdownHeader}>
                    <Text style={styles.searchDropdownTitle}>
                      Matching Locations ({searchResults.length})
                    </Text>
                    <TouchableOpacity onPress={() => setShowSearchResults(false)}>
                      <Ionicons name="close" size={16} color="#64748B" />
                    </TouchableOpacity>
                  </View>
                  {searchResults.slice(0, 4).map((item) => (
                    <TouchableOpacity
                      key={item.id}
                      style={styles.searchResultItem}
                      onPress={() => selectLocationResult(item)}
                    >
                      <Ionicons name="location" size={15} color="#0284C7" />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.searchResultName} numberOfLines={1}>
                          {item.name}
                        </Text>
                        <Text style={styles.searchResultSub} numberOfLines={1}>
                          {item.sub || item.displayName}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  ))}
                </View>
              )}

              {/* Coordinates and Location Readout */}
              <View style={styles.gpsReadoutCard}>
                <View style={styles.gpsReadoutTop}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.gpsReadoutLabel}>
                      Latitude / Longitude
                    </Text>
                    <Text style={styles.gpsReadoutCoords}>
                      {latitude.toFixed(6)}, {longitude.toFixed(6)}
                    </Text>
                    {locationName ? (
                      <Text style={styles.gpsReadoutAddress} numberOfLines={2}>
                        📍 {locationName}
                      </Text>
                    ) : null}
                  </View>
                  {accuracy !== null && (
                    <View style={styles.accuracyPill}>
                      <Ionicons name="locate" size={12} color="#059669" />
                      <Text style={styles.accuracyPillText}>±{accuracy}m</Text>
                    </View>
                  )}
                </View>

                {/* Re-Acquire GPS Button */}
                <TouchableOpacity
                  style={styles.reacquireBtn}
                  onPress={handleGetCurrentLocation}
                  disabled={isLocating}
                >
                  {isLocating ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : (
                    <>
                      <Ionicons name="navigate" size={16} color="#FFFFFF" />
                      <Text style={styles.reacquireBtnText}>
                        Use Current Device Location
                      </Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>

              {/* THE LIVE SATELLITE MAP (with smooth flyTo!) */}
              <View style={styles.mapContainer}>
                <PresenceMapMobile
                  latitude={latitude}
                  longitude={longitude}
                  radiusMeters={radiusMeters}
                  onCoordinatesChange={(lat, lng) => {
                    setLatitude(lat);
                    setLongitude(lng);
                    reverseGeocode(lat, lng);
                  }}
                  height={280}
                />
              </View>

              {/* Radius Selector */}
              <View style={styles.radiusSection}>
                <Text style={styles.radiusTitle}>
                  Geofence Perimeter Boundary:{" "}
                  <Text style={{ color: "#0284C7", fontWeight: "700" }}>
                    {radiusMeters} meters
                  </Text>
                </Text>
                <View style={styles.radiusGrid}>
                  {RADIUS_OPTIONS.map((r) => {
                    const isActive = radiusMeters === r;
                    return (
                      <TouchableOpacity
                        key={r}
                        style={[
                          styles.radiusBtn,
                          isActive && styles.radiusBtnActive,
                        ]}
                        onPress={() => setRadiusMeters(r)}
                      >
                        <Text
                          style={[
                            styles.radiusBtnText,
                            isActive && styles.radiusBtnTextActive,
                          ]}
                        >
                          {r}m
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            </View>

            {/* Save & Sync Button */}
            <TouchableOpacity
              style={[styles.saveBtn, isSaving && styles.saveBtnDisabled]}
              onPress={handleInitiateSave}
              disabled={isSaving}
              activeOpacity={0.85}
            >
              {isSaving ? (
                <ActivityIndicator color="#FFFFFF" size="small" />
              ) : (
                <>
                  <Ionicons
                    name="cloud-upload-outline"
                    size={18}
                    color="#FFFFFF"
                  />
                  <Text style={styles.saveBtnText}>
                    Save &amp; Sync to Web Portal
                  </Text>
                </>
              )}
            </TouchableOpacity>
          </ScrollView>

          {/* Sync Confirmation Pop-up Dialog */}
          <Modal
            visible={showConfirmModal}
            transparent={true}
            animationType="fade"
            onRequestClose={() => setShowConfirmModal(false)}
          >
            <View style={styles.modalBackdrop}>
              <View style={styles.modalCard}>
                <View style={styles.modalHeader}>
                  <View style={styles.modalIconBox}>
                    <Ionicons
                      name="shield-checkmark"
                      size={24}
                      color="#0284C7"
                    />
                  </View>
                  <Text style={styles.modalTitle}>
                    Confirm Premises Anchors
                  </Text>
                  <Text style={styles.modalSubtitle}>
                    Review anchors before synchronizing with Web Portal
                  </Text>
                </View>

                <View style={styles.modalBody}>
                  {/* Organization */}
                  <View style={styles.modalSection}>
                    <Text style={styles.modalSectionLabel}>ORGANIZATION</Text>
                    <Text style={styles.modalSectionValue}>
                      {pairedOrgName || "Main Campus"}{" "}
                      <Text style={{ color: "#64748B", fontWeight: "500" }}>
                        ({pairedOrgCode})
                      </Text>
                    </Text>
                  </View>

                  {/* Mode */}
                  <View style={styles.modalSection}>
                    <Text style={styles.modalSectionLabel}>
                      VERIFICATION MODE
                    </Text>
                    <Text style={styles.modalSectionValue}>
                      {calibrationMode === "GEOFENCE_ONLY"
                        ? "GPS Geofence Only (Router-Free)"
                        : "Wi-Fi + GPS (Hybrid Security)"}
                    </Text>
                  </View>

                  {/* Router if Hybrid */}
                  {calibrationMode === "HYBRID" && (
                    <View style={styles.modalSection}>
                      <Text style={styles.modalSectionLabel}>
                        PREMISES ROUTER
                      </Text>
                      <Text style={styles.modalSectionValue}>
                        {selectedSsid || "Unnamed Router"}
                      </Text>
                      <Text style={styles.modalSubValue}>
                        MAC: {selectedBssid}
                      </Text>
                    </View>
                  )}

                  {/* Geofence */}
                  <View style={styles.modalSection}>
                    <Text style={styles.modalSectionLabel}>
                      GEOFENCE BOUNDARY
                    </Text>
                    <Text style={styles.modalSectionValue}>
                      {latitude.toFixed(6)}, {longitude.toFixed(6)}
                    </Text>
                    <Text style={styles.modalSubValue}>
                      Perimeter: {radiusMeters}m radius
                      {locationName ? ` • ${locationName}` : ""}
                    </Text>
                  </View>
                </View>

                {/* Modal Actions */}
                <View style={styles.modalActions}>
                  <TouchableOpacity
                    style={styles.modalCancelBtn}
                    onPress={() => setShowConfirmModal(false)}
                    disabled={isSaving}
                  >
                    <Text style={styles.modalCancelBtnText}>Edit</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.modalConfirmBtn}
                    onPress={handleConfirmSave}
                    disabled={isSaving}
                  >
                    {isSaving ? (
                      <ActivityIndicator size="small" color="#FFFFFF" />
                    ) : (
                      <>
                        <Ionicons
                          name="cloud-upload"
                          size={16}
                          color="#FFFFFF"
                        />
                        <Text style={styles.modalConfirmBtnText}>
                          Confirm &amp; Sync
                        </Text>
                      </>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          </Modal>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#f2f1ee",
  },
  scannerWrapper: {
    flex: 1,
    backgroundColor: "#142748",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#e5e7eb",
    backgroundColor: "#ffffff",
    zIndex: 10,
  },
  backButton: {
    padding: 6,
    marginRight: 8,
  },
  headerTitleGroup: {
    flex: 1,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: "#142748",
    letterSpacing: -0.3,
  },
  headerSubtitle: {
    fontSize: 11,
    color: "#52525b",
    marginTop: 1,
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
  },
  refreshHeaderBtn: {
    padding: 8,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    gap: 16,
    paddingBottom: 40,
    maxWidth: 540,
    width: "100%",
    alignSelf: "center",
  },
  permissionBox: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
    backgroundColor: "#ffffff",
    gap: 14,
    borderWidth: 1,
    borderColor: "#e5e7eb",
  },
  permTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: "#142748",
    textAlign: "center",
  },
  permText: {
    fontSize: 13,
    color: "#52525b",
    textAlign: "center",
    lineHeight: 20,
  },
  primaryBtn: {
    backgroundColor: "#142748",
    paddingVertical: 13,
    paddingHorizontal: 24,
    borderRadius: 0,
    marginTop: 8,
    elevation: 0,
    shadowOpacity: 0,
  },
  primaryBtnText: {
    color: "#f2f1ee",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
    textTransform: "uppercase",
  },
  reticleOverlay: {
    ...StyleSheet.absoluteFill,
    justifyContent: "space-between",
  },
  reticleUnfocused: {
    flex: 1,
    backgroundColor: "rgba(20, 39, 72, 0.7)",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 24,
  },
  reticleMiddleRow: {
    flexDirection: "row",
    height: 260,
  },
  reticleTarget: {
    width: 260,
    height: 260,
    position: "relative",
    backgroundColor: "transparent",
  },
  corner: {
    position: "absolute",
    width: 32,
    height: 32,
    borderColor: "#ffffff",
  },
  topLeft: {
    top: 0,
    left: 0,
    borderTopWidth: 3,
    borderLeftWidth: 3,
  },
  topRight: {
    top: 0,
    right: 0,
    borderTopWidth: 3,
    borderRightWidth: 3,
  },
  bottomLeft: {
    bottom: 0,
    left: 0,
    borderBottomWidth: 3,
    borderLeftWidth: 3,
  },
  bottomRight: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 3,
    borderRightWidth: 3,
  },
  hintCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "rgba(20, 39, 72, 0.9)",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 0,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.2)",
  },
  hintText: {
    color: "#f2f1ee",
    fontSize: 12,
    fontWeight: "500",
    flex: 1,
    lineHeight: 17,
  },
  connectedCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#142748",
    padding: 12,
    borderRadius: 0,
  },
  connectedIcon: {
    width: 32,
    height: 32,
    borderRadius: 0,
    backgroundColor: "#f2f1ee",
    alignItems: "center",
    justifyContent: "center",
  },
  connectedTitle: {
    fontSize: 11,
    fontWeight: "700",
    color: "#142748",
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
    textTransform: "uppercase",
  },
  connectedSub: {
    fontSize: 11,
    color: "#52525b",
    marginTop: 1,
  },
  rescanBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#ffffff",
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 0,
    borderWidth: 1,
    borderColor: "rgba(20, 39, 72, 0.3)",
  },
  rescanBtnText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#142748",
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
    textTransform: "uppercase",
  },
  modeCard: {
    backgroundColor: "#ffffff",
    borderRadius: 0,
    padding: 12,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    gap: 8,
  },
  modeCardLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: "#142748",
    letterSpacing: 0.8,
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
    textTransform: "uppercase",
  },
  modeTabsRow: {
    flexDirection: "row",
    gap: 8,
  },
  modeTabBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: 0,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e5e7eb",
  },
  modeTabBtnActive: {
    backgroundColor: "#142748",
    borderColor: "#142748",
  },
  modeTabBtnText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#52525b",
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  modeTabBtnTextActive: {
    color: "#f2f1ee",
  },
  geofenceOnlyCard: {
    backgroundColor: "#ffffff",
    borderRadius: 0,
    padding: 16,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  geofenceOnlyIconBox: {
    width: 40,
    height: 40,
    borderRadius: 0,
    backgroundColor: "#f2f1ee",
    alignItems: "center",
    justifyContent: "center",
  },
  geofenceOnlyTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#142748",
    marginBottom: 3,
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
    textTransform: "uppercase",
  },
  geofenceOnlyDesc: {
    fontSize: 12,
    color: "#52525b",
    lineHeight: 18,
  },
  card: {
    backgroundColor: "#ffffff",
    borderRadius: 0,
    padding: 16,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    elevation: 0,
    shadowOpacity: 0,
    gap: 12,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  cardIconBox: {
    width: 36,
    height: 36,
    borderRadius: 0,
    backgroundColor: "#f2f1ee",
    alignItems: "center",
    justifyContent: "center",
  },
  cardTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#142748",
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  cardSubtitle: {
    fontSize: 11,
    color: "#52525b",
    marginTop: 1,
  },
  scanActionBtn: {
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "rgba(20, 39, 72, 0.3)",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 0,
  },
  scanActionText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#142748",
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
    textTransform: "uppercase",
  },
  wifiFilterBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 0,
    paddingHorizontal: 12,
    height: 42,
  },
  wifiFilterInput: {
    flex: 1,
    fontSize: 13,
    color: "#142748",
  },
  wifiListContainer: {
    gap: 8,
  },
  wifiItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 12,
    backgroundColor: "#ffffff",
    borderRadius: 0,
    borderWidth: 1,
    borderColor: "#e5e7eb",
  },
  wifiItemActive: {
    backgroundColor: "#f2f1ee",
    borderColor: "#142748",
  },
  wifiItemLeft: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
  },
  wifiItemSsid: {
    fontSize: 13,
    fontWeight: "600",
    color: "#142748",
  },
  wifiItemSsidActive: {
    color: "#142748",
    fontWeight: "700",
  },
  wifiItemBssid: {
    fontSize: 10,
    color: "#52525b",
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
    marginTop: 2,
  },
  wifiItemRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  wifiBandBadge: {
    fontSize: 9,
    fontWeight: "700",
    color: "#52525b",
    backgroundColor: "#f2f1ee",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 0,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
  },
  selectedPill: {
    backgroundColor: "#142748",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 0,
  },
  selectedPillText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#f2f1ee",
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
    textTransform: "uppercase",
  },
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 18,
    gap: 8,
  },
  emptyStateText: {
    fontSize: 12,
    color: "#52525b",
    textAlign: "center",
  },
  manualToggle: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 8,
  },
  manualToggleText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#142748",
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
    textTransform: "uppercase",
  },
  manualInputsGroup: {
    gap: 10,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: "#e5e7eb",
  },
  field: {
    gap: 4,
  },
  fieldLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: "#142748",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
  },
  input: {
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 0,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13,
    color: "#142748",
  },
  venueSearchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 0,
    paddingHorizontal: 10,
    height: 42,
  },
  venueSearchInput: {
    flex: 1,
    fontSize: 13,
    color: "#142748",
  },
  venueSearchBtn: {
    backgroundColor: "#142748",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 0,
  },
  venueSearchBtnText: {
    color: "#f2f1ee",
    fontSize: 10,
    fontWeight: "700",
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  searchDropdown: {
    backgroundColor: "#ffffff",
    borderRadius: 0,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    marginTop: 6,
    overflow: "hidden",
    elevation: 0,
    shadowOpacity: 0,
  },
  searchDropdownHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: "#f2f1ee",
    borderBottomWidth: 1,
    borderBottomColor: "#e5e7eb",
  },
  searchDropdownTitle: {
    fontSize: 10,
    fontWeight: "700",
    color: "#142748",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
  },
  searchResultItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#e5e7eb",
    gap: 8,
  },
  searchResultName: {
    fontSize: 12,
    fontWeight: "700",
    color: "#142748",
  },
  searchResultSub: {
    fontSize: 11,
    color: "#52525b",
    marginTop: 1,
  },
  gpsReadoutCard: {
    backgroundColor: "#ffffff",
    borderRadius: 0,
    padding: 12,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    gap: 10,
  },
  gpsReadoutTop: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
  },
  gpsReadoutLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: "#52525b",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
  },
  gpsReadoutCoords: {
    fontSize: 14,
    fontWeight: "700",
    color: "#142748",
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
    marginTop: 2,
  },
  gpsReadoutAddress: {
    fontSize: 12,
    color: "#2d81ff",
    fontWeight: "500",
    marginTop: 2,
  },
  accuracyPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#142748",
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 0,
  },
  accuracyPillText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#142748",
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
  },
  reacquireBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: "#142748",
    paddingVertical: 10,
    borderRadius: 0,
  },
  reacquireBtnText: {
    color: "#f2f1ee",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.8,
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
    textTransform: "uppercase",
  },
  mapContainer: {
    borderRadius: 0,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#e5e7eb",
  },
  radiusSection: {
    gap: 8,
    marginTop: 4,
  },
  radiusTitle: {
    fontSize: 11,
    color: "#142748",
    fontWeight: "700",
    textTransform: "uppercase",
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
  },
  radiusGrid: {
    flexDirection: "row",
    gap: 6,
    flexWrap: "wrap",
  },
  radiusBtn: {
    flex: 1,
    minWidth: 44,
    paddingVertical: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#ffffff",
    borderRadius: 0,
    borderWidth: 1,
    borderColor: "#e5e7eb",
  },
  radiusBtnActive: {
    backgroundColor: "#142748",
    borderColor: "#142748",
  },
  radiusBtnText: {
    fontSize: 11,
    fontWeight: "600",
    color: "#52525b",
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
  },
  radiusBtnTextActive: {
    color: "#f2f1ee",
    fontWeight: "700",
  },
  summaryBox: {
    backgroundColor: "#ffffff",
    borderRadius: 0,
    padding: 14,
    gap: 8,
    borderWidth: 1,
    borderColor: "#e5e7eb",
  },
  summaryTitle: {
    fontSize: 11,
    fontWeight: "700",
    color: "#142748",
    marginBottom: 2,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
  },
  summaryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  summaryLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: "#52525b",
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
  },
  summaryVal: {
    fontSize: 11,
    color: "#142748",
    flex: 1,
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
  },
  saveBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#142748",
    height: 48,
    borderRadius: 0,
    borderWidth: 1,
    borderColor: "#142748",
    elevation: 0,
    shadowOpacity: 0,
  },
  saveBtnDisabled: {
    opacity: 0.65,
  },
  saveBtnText: {
    color: "#f2f1ee",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
    textTransform: "uppercase",
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(20, 39, 72, 0.6)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  modalCard: {
    width: "100%",
    maxWidth: 400,
    backgroundColor: "#ffffff",
    borderRadius: 0,
    padding: 22,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    elevation: 0,
    shadowOpacity: 0,
  },
  modalHeader: {
    alignItems: "center",
    marginBottom: 16,
  },
  modalIconBox: {
    width: 44,
    height: 44,
    borderRadius: 0,
    backgroundColor: "#f2f1ee",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 10,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: "#142748",
    textAlign: "center",
    letterSpacing: -0.2,
  },
  modalSubtitle: {
    fontSize: 12,
    color: "#52525b",
    marginTop: 4,
    textAlign: "center",
  },
  modalBody: {
    backgroundColor: "#f2f1ee",
    borderRadius: 0,
    padding: 14,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    gap: 12,
    marginBottom: 18,
  },
  modalSection: {
    gap: 2,
  },
  modalSectionLabel: {
    fontSize: 9,
    fontWeight: "700",
    color: "#52525b",
    letterSpacing: 0.8,
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
    textTransform: "uppercase",
  },
  modalSectionValue: {
    fontSize: 13,
    fontWeight: "700",
    color: "#142748",
  },
  modalSubValue: {
    fontSize: 11,
    color: "#52525b",
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
  },
  modalActions: {
    flexDirection: "row",
    gap: 10,
  },
  modalCancelBtn: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 0,
    borderWidth: 1,
    borderColor: "rgba(20, 39, 72, 0.3)",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#ffffff",
  },
  modalCancelBtnText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#142748",
    letterSpacing: 0.6,
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
    textTransform: "uppercase",
  },
  modalConfirmBtn: {
    flex: 2,
    flexDirection: "row",
    gap: 8,
    paddingVertical: 13,
    borderRadius: 0,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#142748",
  },
  modalConfirmBtnText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#f2f1ee",
    letterSpacing: 0.6,
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
    textTransform: "uppercase",
  },
  loadingTransitionOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "#f2f1ee",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    zIndex: 99,
  },
  loadingTransitionCard: {
    alignItems: "center",
    maxWidth: 320,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e5e7eb",
    padding: 24,
    borderRadius: 0,
  },
  loadingIconBox: {
    width: 52,
    height: 52,
    borderRadius: 0,
    backgroundColor: "#f2f1ee",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  loadingTransitionTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: "#142748",
    textAlign: "center",
  },
  loadingTransitionSubtitle: {
    fontSize: 12,
    color: "#52525b",
    textAlign: "center",
    marginTop: 6,
    lineHeight: 17,
  },
});
