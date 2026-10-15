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
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import * as Location from "expo-location";
import { CameraView, useCameraPermissions } from "expo-camera";
import { doc, setDoc } from "firebase/firestore";
import { db } from "../config/firebase";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { PresenceMapMobile } from "../components/PresenceMapMobile";
import {
  scanPhysicalWifiNetworks,
  ScannedWifiNetwork,
} from "../services/wifiScanService";
import { updateOrganizationAnchors as updateAnchorsService } from "../services/organizationService";

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

  // Tier 1: Wi-Fi Anchor State
  const [availableNetworks, setAvailableNetworks] = useState<
    ScannedWifiNetwork[]
  >([]);
  const [isScanningWifi, setIsScanningWifi] = useState(false);
  const [selectedSsid, setSelectedSsid] = useState<string>("");
  const [selectedBssid, setSelectedBssid] = useState<string>("");
  const [showManualWifi, setShowManualWifi] = useState(false);
  const [wifiFilterQuery, setWifiFilterQuery] = useState("");

  // Tier 2: Geofence State
  const [latitude, setLatitude] = useState<number>(4.975);
  const [longitude, setLongitude] = useState<number>(8.3417);
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [radiusMeters, setRadiusMeters] = useState<number>(10);
  const [locationName, setLocationName] = useState<string>("");
  const [isLocating, setIsLocating] = useState(false);
  const [addressSearchQuery, setAddressSearchQuery] = useState("");
  const [isSearchingAddress, setIsSearchingAddress] = useState(false);

  // Form Submission
  const [isSaving, setIsSaving] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  const isSavedSuccessfullyRef = useRef(false);
  const pairedOrgIdRef = useRef<string>("");

  useEffect(() => {
    pairedOrgIdRef.current = pairedOrgId || organization?.id || "";
  }, [pairedOrgId, organization?.id]);

  // Kill signal: notify web portal immediately that mobile device has disconnected
  const sendDisconnectSignal = useCallback((orgId?: string) => {
    const target = orgId || pairedOrgIdRef.current || pairedOrgId || organization?.id;
    if (!target) return;
    setDoc(
      doc(db, "churches", target, "calibration", "session"),
      {
        status: "DISCONNECTED",
        disconnectedAt: new Date().toISOString(),
      },
      { merge: true },
    ).catch((err) => console.warn("Could not send disconnect kill signal:", err));
  }, [pairedOrgId, organization?.id]);

  // Safe navigation handler (with instant kill signal if leaving before saving)
  const handleGoBack = useCallback(() => {
    if (!isSavedSuccessfullyRef.current) {
      sendDisconnectSignal();
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
      if (!isSavedSuccessfullyRef.current) {
        sendDisconnectSignal();
      }
    };
  }, [sendDisconnectSignal]);

  // Reverse geocode to display address name
  const reverseGeocode = async (lat: number, lng: number) => {
    try {
      const results = await Location.reverseGeocodeAsync({
        latitude: lat,
        longitude: lng,
      });
      if (results && results.length > 0) {
        const item = results[0];
        const parts = [
          item.name,
          item.street,
          item.city || item.subregion,
          item.region,
        ].filter(Boolean);
        setLocationName(parts.join(", "));
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
        toast.warn(res.error, { duration: 5000 });
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

  // Search address/venue and fly map to located position
  const handleSearchAddress = async () => {
    if (!addressSearchQuery.trim()) return;
    setIsSearchingAddress(true);
    try {
      const results = await Location.geocodeAsync(addressSearchQuery.trim());
      if (results && results.length > 0) {
        const first = results[0];
        const lat = parseFloat(first.latitude.toFixed(6));
        const lng = parseFloat(first.longitude.toFixed(6));
        setLatitude(lat);
        setLongitude(lng);
        setAccuracy(10);
        setLocationName(addressSearchQuery.trim());
        reverseGeocode(lat, lng);
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
        // INSTANT: Dismiss camera immediately and display loading transition overlay
        setIsConnectingSession(true);
        setPairedOrgId(targetId);
        setPairedOrgName(targetName);
        setPairedOrgCode(targetCode);

        // Send instant handshake ping to Firestore in background (non-blocking)
        setDoc(
          doc(db, "churches", targetId, "calibration", "session"),
          {
            status: "CONNECTED",
            connectedAt: new Date().toISOString(),
            platform: Platform.OS,
          },
          { merge: true },
        ).catch((e) => {
          console.warn("Could not write handshake ping:", e);
        });

        // Scan nearby Wi-Fi networks in background
        handleScanWifi();

        // Smooth transition to calibration workspace
        setTimeout(() => {
          setIsQrPaired(true);
          setIsConnectingSession(false);
          toast.success(`Live paired with ${targetName}!`);
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
    if (!selectedBssid.trim()) {
      toast.warn(
        "Please select or enter your premises Wi-Fi router BSSID (MAC).",
      );
      return;
    }
    if (!selectedSsid.trim()) {
      toast.warn("Please enter a router SSID label.");
      return;
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
      await updateAnchorsService(targetOrgId, {
        ssidHint: selectedSsid.trim(),
        targetBssid: selectedBssid.trim().toLowerCase(),
        latitude,
        longitude,
        radiusMeters,
      });

      if (organization?.id === targetOrgId) {
        updateAnchors({
          ssidHint: selectedSsid.trim(),
          targetBssid: selectedBssid.trim().toLowerCase(),
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
                  <View style={styles.hintCard}>
                    <Ionicons
                      name="qr-code-outline"
                      size={20}
                      color="#38BDF8"
                    />
                    <Text style={styles.hintText}>
                      Point your camera at the QR code on your computer screen
                      (Admin Web &gt; Settings &gt; Premises Anchors)
                    </Text>
                  </View>
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
              <Ionicons name="chevron-back" size={24} color="#0F172A" />
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
                  sendDisconnectSignal();
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
                  <Text style={{ fontWeight: "700", color: "#0F172A" }}>
                    {pairedOrgName}
                  </Text>{" "}
                  ({pairedOrgCode})
                </Text>
              </View>
              <TouchableOpacity
                style={styles.rescanBtn}
                onPress={() => {
                  sendDisconnectSignal();
                  hasHandshakedRef.current = false;
                  setScanCooldown(false);
                  setIsQrPaired(false);
                }}
              >
                <Ionicons name="scan-outline" size={13} color="#0284C7" />
                <Text style={styles.rescanBtnText}>Rescan</Text>
              </TouchableOpacity>
            </View>

            {/* Section 1: Premises Wi-Fi Router (Anchor) */}
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <View
                  style={[styles.cardIconBox, { backgroundColor: "#EFF6FF" }]}
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
                      selectedBssid.toLowerCase() === net.bssid.toLowerCase();
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
                            <Text style={styles.wifiBandBadge}>{net.band}</Text>
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
                    <Text style={styles.emptyStateText}>
                      No networks detected. Make sure Wi-Fi and Location are
                      turned on.
                    </Text>
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
                    <Text style={styles.fieldLabel}>Router SSID Name *</Text>
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
                    2. Geofence Perimeter (GPS)
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
                  onChangeText={setAddressSearchQuery}
                  placeholder="Search venue or address (e.g. Calabar)..."
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
                    {/* {locationName ? (
                      <Text style={styles.gpsReadoutAddress} numberOfLines={2}>
                        📍 {locationName}
                      </Text>
                    ) : null} */}
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

                  {/* Router */}
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
    backgroundColor: "#F8FAFC",
  },
  scannerWrapper: {
    flex: 1,
    backgroundColor: "#0F172A",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#E2E8F0",
    backgroundColor: "#FFFFFF",
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
    fontSize: 18,
    fontWeight: "800",
    color: "#0F172A",
    letterSpacing: -0.3,
  },
  headerSubtitle: {
    fontSize: 12,
    color: "#64748B",
    marginTop: 1,
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
  },
  permissionBox: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
    backgroundColor: "#0F172A",
    gap: 14,
  },
  permTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#FFFFFF",
    textAlign: "center",
  },
  permText: {
    fontSize: 13,
    color: "#94A3B8",
    textAlign: "center",
    lineHeight: 20,
  },
  primaryBtn: {
    backgroundColor: "#0284C7",
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 10,
    marginTop: 8,
  },
  primaryBtnText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "700",
  },
  reticleOverlay: {
    ...StyleSheet.absoluteFill,
    justifyContent: "space-between",
  },
  reticleUnfocused: {
    flex: 1,
    backgroundColor: "rgba(15, 23, 42, 0.65)",
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
    width: 36,
    height: 36,
    borderColor: "#38BDF8",
  },
  topLeft: {
    top: 0,
    left: 0,
    borderTopWidth: 4,
    borderLeftWidth: 4,
    borderTopLeftRadius: 10,
  },
  topRight: {
    top: 0,
    right: 0,
    borderTopWidth: 4,
    borderRightWidth: 4,
    borderTopRightRadius: 10,
  },
  bottomLeft: {
    bottom: 0,
    left: 0,
    borderBottomWidth: 4,
    borderLeftWidth: 4,
    borderBottomLeftRadius: 10,
  },
  bottomRight: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 4,
    borderRightWidth: 4,
    borderBottomRightRadius: 10,
  },
  hintCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "rgba(30, 41, 59, 0.92)",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.15)",
  },
  hintText: {
    color: "#F8FAFC",
    fontSize: 12,
    fontWeight: "500",
    flex: 1,
    lineHeight: 17,
  },
  connectedCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#ECFDF5",
    borderWidth: 1,
    borderColor: "#A7F3D0",
    padding: 12,
    borderRadius: 12,
  },
  connectedIcon: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: "#D1FAE5",
    alignItems: "center",
    justifyContent: "center",
  },
  connectedTitle: {
    fontSize: 12,
    fontWeight: "700",
    color: "#065F46",
  },
  connectedSub: {
    fontSize: 11,
    color: "#047857",
    marginTop: 1,
  },
  rescanBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#BAE6FD",
  },
  rescanBtnText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#0284C7",
  },
  card: {
    backgroundColor: "#FFFFFF",
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    shadowColor: "#0F172A",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
    gap: 12,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  cardIconBox: {
    width: 38,
    height: 38,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: "#0F172A",
  },
  cardSubtitle: {
    fontSize: 12,
    color: "#64748B",
    marginTop: 1,
  },
  scanActionBtn: {
    backgroundColor: "#F0F9FF",
    borderWidth: 1,
    borderColor: "#BAE6FD",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  scanActionText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#0284C7",
  },
  wifiFilterBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#F8FAFC",
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 10,
    paddingHorizontal: 12,
    height: 40,
  },
  wifiFilterInput: {
    flex: 1,
    fontSize: 13,
    color: "#0F172A",
  },
  wifiListContainer: {
    gap: 8,
  },
  wifiItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 12,
    backgroundColor: "#F8FAFC",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#E2E8F0",
  },
  wifiItemActive: {
    backgroundColor: "#F0F9FF",
    borderColor: "#0284C7",
  },
  wifiItemLeft: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
  },
  wifiItemSsid: {
    fontSize: 14,
    fontWeight: "600",
    color: "#0F172A",
  },
  wifiItemSsidActive: {
    color: "#0284C7",
    fontWeight: "700",
  },
  wifiItemBssid: {
    fontSize: 11,
    color: "#64748B",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    marginTop: 2,
  },
  wifiItemRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  wifiBandBadge: {
    fontSize: 10,
    fontWeight: "700",
    color: "#475569",
    backgroundColor: "#E2E8F0",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  selectedPill: {
    backgroundColor: "#E0F2FE",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  selectedPillText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#0284C7",
  },
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 18,
    gap: 8,
  },
  emptyStateText: {
    fontSize: 12,
    color: "#64748B",
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
    fontSize: 12,
    fontWeight: "600",
    color: "#0284C7",
  },
  manualInputsGroup: {
    gap: 10,
    paddingTop: 4,
    borderTopWidth: 1,
    borderTopColor: "#F1F5F9",
  },
  field: {
    gap: 4,
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: "#334155",
  },
  input: {
    backgroundColor: "#F8FAFC",
    borderWidth: 1,
    borderColor: "#CBD5E1",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 13,
    color: "#0F172A",
  },
  venueSearchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#F8FAFC",
    borderWidth: 1,
    borderColor: "#CBD5E1",
    borderRadius: 10,
    paddingHorizontal: 10,
    height: 42,
  },
  venueSearchInput: {
    flex: 1,
    fontSize: 13,
    color: "#0F172A",
  },
  venueSearchBtn: {
    backgroundColor: "#0284C7",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 7,
  },
  venueSearchBtnText: {
    color: "#FFFFFF",
    fontSize: 12,
    fontWeight: "700",
  },
  gpsReadoutCard: {
    backgroundColor: "#F8FAFC",
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: "#E2E8F0",
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
    color: "#64748B",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  gpsReadoutCoords: {
    fontSize: 15,
    fontWeight: "800",
    color: "#0F172A",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    marginTop: 2,
  },
  gpsReadoutAddress: {
    fontSize: 12,
    color: "#0284C7",
    fontWeight: "600",
    marginTop: 2,
  },
  accuracyPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#D1FAE5",
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 12,
  },
  accuracyPillText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#065F46",
  },
  reacquireBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: "#059669",
    paddingVertical: 10,
    borderRadius: 8,
  },
  reacquireBtnText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "700",
  },
  mapContainer: {
    borderRadius: 12,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#CBD5E1",
  },
  radiusSection: {
    gap: 8,
    marginTop: 4,
  },
  radiusTitle: {
    fontSize: 13,
    color: "#475569",
    fontWeight: "500",
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
    backgroundColor: "#F8FAFC",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#E2E8F0",
  },
  radiusBtnActive: {
    backgroundColor: "#0284C7",
    borderColor: "#0284C7",
  },
  radiusBtnText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#64748B",
  },
  radiusBtnTextActive: {
    color: "#FFFFFF",
    fontWeight: "700",
  },
  summaryBox: {
    backgroundColor: "#F1F5F9",
    borderRadius: 12,
    padding: 14,
    gap: 8,
    borderWidth: 1,
    borderColor: "#E2E8F0",
  },
  summaryTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#1E293B",
    marginBottom: 2,
  },
  summaryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  summaryLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: "#475569",
  },
  summaryVal: {
    fontSize: 12,
    color: "#0F172A",
    flex: 1,
  },
  saveBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#0284C7",
    height: 48,
    borderRadius: 12,
    shadowColor: "#0284C7",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 3,
  },
  saveBtnDisabled: {
    opacity: 0.7,
  },
  saveBtnText: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "700",
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(15, 23, 42, 0.65)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  modalCard: {
    width: "100%",
    maxWidth: 400,
    backgroundColor: "#FFFFFF",
    borderRadius: 20,
    padding: 22,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.2,
    shadowRadius: 20,
    elevation: 10,
  },
  modalHeader: {
    alignItems: "center",
    marginBottom: 16,
  },
  modalIconBox: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "#E0F2FE",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 10,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#0F172A",
    textAlign: "center",
  },
  modalSubtitle: {
    fontSize: 12,
    color: "#64748B",
    marginTop: 4,
    textAlign: "center",
  },
  modalBody: {
    backgroundColor: "#F8FAFC",
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    gap: 12,
    marginBottom: 18,
  },
  modalSection: {
    gap: 2,
  },
  modalSectionLabel: {
    fontSize: 10,
    fontWeight: "800",
    color: "#64748B",
    letterSpacing: 0.5,
  },
  modalSectionValue: {
    fontSize: 14,
    fontWeight: "700",
    color: "#0F172A",
  },
  modalSubValue: {
    fontSize: 12,
    color: "#64748B",
  },
  modalActions: {
    flexDirection: "row",
    gap: 10,
  },
  modalCancelBtn: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: "#E2E8F0",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FFFFFF",
  },
  modalCancelBtnText: {
    fontSize: 14,
    fontWeight: "600",
    color: "#64748B",
  },
  modalConfirmBtn: {
    flex: 2,
    flexDirection: "row",
    gap: 8,
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#0284C7",
  },
  modalConfirmBtnText: {
    fontSize: 14,
    fontWeight: "700",
    color: "#FFFFFF",
  },
  loadingTransitionOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "#0F172A",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    zIndex: 99,
  },
  loadingTransitionCard: {
    alignItems: "center",
    maxWidth: 320,
  },
  loadingIconBox: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "rgba(2, 132, 199, 0.15)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(2, 132, 199, 0.3)",
  },
  loadingTransitionTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#FFFFFF",
    textAlign: "center",
  },
  loadingTransitionSubtitle: {
    fontSize: 13,
    color: "#94A3B8",
    textAlign: "center",
    marginTop: 8,
    lineHeight: 18,
  },
});
