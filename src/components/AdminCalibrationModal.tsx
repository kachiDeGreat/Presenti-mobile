import React, { useState, useEffect, useRef } from "react";
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  TextInput,
  Platform,
  Alert,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Location from "expo-location";
import { doc, updateDoc, setDoc } from "firebase/firestore";
import { db } from "../config/firebase";
import { PresenceMapMobile } from "./PresenceMapMobile";
import {
  searchGlobalLocations,
  reverseGeocodeCoords,
  GeocodedLocation,
} from "../services/geocodingService";
import { acquireDeviceCoordinates } from "../services/locationService";
import { C, MONO, R, S, T, shadow, ui } from "../constants/premium";

interface CalibrationPayload {
  type: string;
  churchId: string;
  churchCode: string;
  churchName?: string;
}

interface DetectedWifi {
  ssid: string;
  bssid: string;
  level?: number;
}

interface AdminCalibrationModalProps {
  visible: boolean;
  onClose: () => void;
  onSuccess?: (details: { ssid: string; bssid: string; lat: number; lng: number }) => void;
}

export const AdminCalibrationModal: React.FC<AdminCalibrationModalProps> = ({
  visible,
  onClose,
  onSuccess,
}) => {
  const [permission, requestPermission] = useCameraPermissions();
  const [mode, setMode] = useState<"SCANNER" | "CALIBRATE">("SCANNER");
  const [targetOrg, setTargetOrg] = useState<CalibrationPayload | null>(null);
  const [calibrationMode, setCalibrationMode] = useState<"HYBRID" | "GEOFENCE_ONLY">("HYBRID");

  // Calibration Form State
  const [selectedSsid, setSelectedSsid] = useState("");
  const [selectedBssid, setSelectedBssid] = useState("");
  const [latitude, setLatitude] = useState<number | null>(null);
  const [longitude, setLongitude] = useState<number | null>(null);
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [radiusMeters, setRadiusMeters] = useState<number>(10);

  // Scanning & Progress
  const [isScanningWifi, setIsScanningWifi] = useState(false);
  const [detectedNetworks, setDetectedNetworks] = useState<DetectedWifi[]>([]);
  const [isLocatingGps, setIsLocatingGps] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [scanCooldown, setScanCooldown] = useState(false);
  const hasHandshakedRef = useRef(false);

  // Search & Venue States
  const [wifiFilterQuery, setWifiFilterQuery] = useState("");
  const [addressSearchQuery, setAddressSearchQuery] = useState("");
  const [isSearchingAddress, setIsSearchingAddress] = useState(false);
  const [locationName, setLocationName] = useState("");

  // Reset modal state on open
  useEffect(() => {
    if (visible) {
      setMode("SCANNER");
      setTargetOrg(null);
      setCalibrationMode("HYBRID");
      setSelectedSsid("");
      setSelectedBssid("");
      setLatitude(null);
      setLongitude(null);
      setAccuracy(null);
      setRadiusMeters(10);
      setDetectedNetworks([]);
      hasHandshakedRef.current = false;
      setScanCooldown(false);
      setWifiFilterQuery("");
      setAddressSearchQuery("");
      setLocationName("");
    }
  }, [visible]);

  // Reverse geocode lat/lng into human readable venue name
  const reverseGeocode = async (lat: number, lng: number) => {
    try {
      const info = await reverseGeocodeCoords(lat, lng);
      if (info && info.displayName) {
        setLocationName(info.displayName);
      }
    } catch (e) {
      console.warn("Reverse geocode failed:", e);
    }
  };

  // Search address or venue by text
  const handleSearchAddress = async () => {
    if (!addressSearchQuery.trim()) return;
    setIsSearchingAddress(true);
    try {
      const results = await searchGlobalLocations(addressSearchQuery.trim());
      if (results && results.length > 0) {
        const first = results[0];
        setLatitude(first.lat);
        setLongitude(first.lng);
        setAccuracy(10);
        setLocationName(first.displayName || first.name);
        Alert.alert("Venue Located", `Pinned: ${first.name}\n(${first.lat}, ${first.lng})`);
      } else {
        Alert.alert("Address Not Found", "Could not locate this address or venue. Please try another search or acquire current GPS.");
      }
    } catch (e: any) {
      Alert.alert("Search Error", e?.message || "Failed to search location.");
    } finally {
      setIsSearchingAddress(false);
    }
  };

  // Handle QR Code Scan
  const handleBarcodeScanned = async ({ data }: { data: string }) => {
    if (hasHandshakedRef.current || mode !== "SCANNER") return;

    try {
      let parsed: any = null;
      try {
        parsed = JSON.parse(data);
      } catch {
        // Maybe raw code
        if (data.includes("CALIBRATE_ANCHORS")) {
          parsed = { type: "CALIBRATE_ANCHORS", churchId: data, churchCode: "ORG" };
        }
      }

      const targetId = parsed?.id || parsed?.churchId;
      const targetCode = parsed?.c || parsed?.code || parsed?.churchCode || "ORG";
      const targetName = parsed?.n || parsed?.name || parsed?.churchName || "Organization";
      const targetMode: "HYBRID" | "GEOFENCE_ONLY" =
        (parsed?.mode === "GEOFENCE_ONLY" || parsed?.m === "GEOFENCE_ONLY") ? "GEOFENCE_ONLY" : "HYBRID";
      setCalibrationMode(targetMode);

      if (targetId) {
        hasHandshakedRef.current = true;
        setTargetOrg({
          type: "CALIBRATE_ANCHORS",
          churchId: targetId,
          churchCode: targetCode,
          churchName: targetName,
        });

        // Send instant handshake ping to BOTH church doc and session subcollection
        const sessionPayload = {
          status: "CONNECTED",
          connectedAt: new Date().toISOString(),
          platform: Platform.OS,
          mode: targetMode,
        };

        updateDoc(doc(db, "churches", targetId), {
          "calibrationSession.status": "CONNECTED",
          "calibrationSession.connectedAt": sessionPayload.connectedAt,
          "calibrationSession.platform": sessionPayload.platform,
          "calibrationSession.mode": targetMode,
        }).catch((e) => console.warn("Could not write handshake to church doc:", e));

        setDoc(
          doc(db, "churches", targetId, "calibration", "session"),
          sessionPayload,
          { merge: true }
        ).catch((e) => {
          console.warn("Could not write handshake ping to session doc:", e);
        });

        setMode("CALIBRATE");

        if (targetMode === "GEOFENCE_ONLY") {
          setSelectedSsid("Office Geofence Zone");
          setSelectedBssid("");
          acquireGps();
        } else {
          acquireGps();
          scanPhysicalWifi();
        }
      }
    } catch (err) {
      console.warn("QR code parsing error:", err);
    }
  };

  // Acquire high accuracy GPS location from physical device
  const acquireGps = async () => {
    setIsLocatingGps(true);
    try {
      const coords = await acquireDeviceCoordinates({
        onInstantFix: (instant) => {
          setLatitude(instant.latitude);
          setLongitude(instant.longitude);
          setAccuracy(instant.accuracy);
          reverseGeocode(instant.latitude, instant.longitude);
        },
      });

      setLatitude(coords.latitude);
      setLongitude(coords.longitude);
      setAccuracy(coords.accuracy);
      reverseGeocode(coords.latitude, coords.longitude);
    } catch (err: any) {
      console.warn("GPS lock error:", err);
      Alert.alert(
        "Location Unavailable",
        err?.message || "Unable to acquire GPS fix. Ensure device location is turned on."
      );
    } finally {
      setIsLocatingGps(false);
    }
  };

  // Scan physical Wi-Fi hardware from phone
  const scanPhysicalWifi = async () => {
    setIsScanningWifi(true);
    try {
      if (Platform.OS === "android") {
        try {
          const wifiModule = require("react-native-wifi-reborn");
          const WifiManager = wifiModule?.default || wifiModule;

          if (WifiManager) {
            let list: any[] = [];
            try {
              if (typeof WifiManager.reScanAndLoadWifiList === "function") {
                list = await WifiManager.reScanAndLoadWifiList();
              } else if (typeof WifiManager.loadWifiList === "function") {
                list = await WifiManager.loadWifiList();
              }
            } catch {
              if (typeof WifiManager.loadWifiList === "function") {
                list = await WifiManager.loadWifiList();
              }
            }

            if (Array.isArray(list) && list.length > 0) {
              const formatted: DetectedWifi[] = list
                .filter((item) => item.SSID && item.BSSID)
                .map((item) => ({
                  ssid: String(item.SSID || "Unknown Network"),
                  bssid: String(item.BSSID || "").toLowerCase(),
                  level: item.level,
                }));

              setDetectedNetworks(formatted);
              if (formatted.length > 0 && !selectedSsid) {
                setSelectedSsid(formatted[0].ssid);
                setSelectedBssid(formatted[0].bssid);
              }
              return;
            }
          }
        } catch (e) {
          console.warn("Native Wi-Fi scan notice:", e);
        }
      }

      // Fallback: If on iOS or web or no native scan, populate fallback
      if (detectedNetworks.length === 0) {
        setDetectedNetworks([
          { ssid: "Premises_Office_5G", bssid: "0c:61:f9:65:8f:07" },
          { ssid: "Premises_Main_Hall", bssid: "b4:fb:e4:81:9d:22" },
        ]);
        if (!selectedSsid) {
          setSelectedSsid("Premises_Office_5G");
          setSelectedBssid("0c:61:f9:65:8f:07");
        }
      }
    } catch (err) {
      console.warn("Error scanning Wi-Fi:", err);
    } finally {
      setIsScanningWifi(false);
    }
  };

  // Commit Calibration to Firestore
  const handleSaveCalibration = async () => {
    if (!targetOrg) return;

    if (calibrationMode === "HYBRID") {
      if (!selectedSsid.trim()) {
        Alert.alert("Missing Router SSID", "Please select or enter the premises router name.");
        return;
      }

      if (!selectedBssid.trim()) {
        Alert.alert("Missing Router MAC", "Please enter or select the hardware MAC address (BSSID).");
        return;
      }
    }

    if (latitude === null || longitude === null) {
      Alert.alert("Missing GPS Pin", "Please acquire current GPS coordinates first.");
      return;
    }

    setIsSubmitting(true);
    try {
      const cleanBssid = calibrationMode === "HYBRID" ? selectedBssid.trim().toLowerCase() : "";
      const cleanSsid = calibrationMode === "HYBRID" ? selectedSsid.trim() : "Office Geofence Zone";

      // 1. Update main church document
      await updateDoc(doc(db, "churches", targetOrg.churchId), {
        beaconConfig: {
          ssidHint: cleanSsid,
          targetBssid: cleanBssid,
          verificationMode: calibrationMode,
        },
        geoFallback: {
          latitude: Number(latitude),
          longitude: Number(longitude),
          radiusMeters: Number(radiusMeters),
          locationLabel: locationName || undefined,
          isConfigured: true,
          isCalibrated: true,
        },
        isCalibrated: true,
        "calibrationSession.status": "COMPLETED",
        "calibrationSession.completedAt": new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // 2. Mark calibration session as completed for web portal real-time listener
      await setDoc(
        doc(db, "churches", targetOrg.churchId, "calibration", "session"),
        {
          status: "COMPLETED",
          completedAt: new Date().toISOString(),
          beaconConfig: {
            ssidHint: cleanSsid,
            targetBssid: cleanBssid,
            verificationMode: calibrationMode,
          },
          geoFallback: {
            latitude: Number(latitude),
            longitude: Number(longitude),
            radiusMeters: Number(radiusMeters),
            locationLabel: locationName || undefined,
            isConfigured: true,
            isCalibrated: true,
          },
        },
        { merge: true }
      );

      Alert.alert(
        "Anchors Successfully Calibrated!",
        calibrationMode === "GEOFENCE_ONLY"
          ? `Premises Geofence boundaries have been synchronized to the Web Portal.\n\n• Mode: GPS Geofence Only\n• Coordinates: ${latitude}, ${longitude}\n• Perimeter: ${radiusMeters}m`
          : `Premises Wi-Fi and Geofence boundaries have been synchronized to the Web Portal.\n\n• Router: ${cleanSsid}\n• Coordinates: ${latitude}, ${longitude}\n• Perimeter: ${radiusMeters}m`,
        [
          {
            text: "Done",
            onPress: () => {
              onSuccess?.({
                ssid: cleanSsid,
                bssid: cleanBssid,
                lat: latitude,
                lng: longitude,
              });
              onClose();
            },
          },
        ]
      );
    } catch (error: any) {
      console.error("Save calibration error:", error);
      Alert.alert("Sync Error", error?.message || "Failed to commit calibration to database.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    if (targetOrg?.churchId && !isSubmitting) {
      updateDoc(doc(db, "churches", targetOrg.churchId), {
        "calibrationSession.status": "DISCONNECTED",
        "calibrationSession.disconnectedAt": new Date().toISOString(),
      }).catch(() => {});
      setDoc(
        doc(db, "churches", targetOrg.churchId, "calibration", "session"),
        {
          status: "DISCONNECTED",
          disconnectedAt: new Date().toISOString(),
        },
        { merge: true },
      ).catch(() => {});
    }
    onClose();
  };

  const filteredNetworks = detectedNetworks.filter((net) => {
    if (!wifiFilterQuery.trim()) return true;
    const q = wifiFilterQuery.toLowerCase();
    return net.ssid.toLowerCase().includes(q) || net.bssid.toLowerCase().includes(q);
  });

  return (
    <Modal visible={visible} animationType="slide" transparent={false} onRequestClose={handleClose}>
      <View style={styles.container}>
        {/* Header Bar */}
        <View style={styles.topBar}>
          <TouchableOpacity onPress={handleClose} style={styles.closeBtn}>
            <Ionicons name="close" size={24} color="#142748" />
          </TouchableOpacity>
          <View style={styles.headerInfo}>
            <Text style={styles.headerTitle}>Premises Calibration</Text>
            <Text style={styles.headerSubtitle}>
              {mode === "SCANNER" ? "Scan Web Portal QR Code" : `Anchoring: ${targetOrg?.churchName || targetOrg?.churchCode}`}
            </Text>
          </View>
          <View style={{ width: 40 }} />
        </View>

        {/* Mode A: QR camera scanner */}
        {mode === "SCANNER" ? (
          <View style={styles.scannerWrapper}>
            {!permission ? (
              <View style={styles.permContainer}>
                <ActivityIndicator size="large" color="#0284C7" />
                <Text style={styles.permText}>Checking camera access...</Text>
              </View>
            ) : !permission.granted ? (
              <View style={styles.permContainer}>
                <Ionicons name="camera-outline" size={54} color="#64748B" />
                <Text style={styles.permTitle}>Camera Permission Required</Text>
                <Text style={styles.permText}>
                  Presenti needs camera access to scan the calibration QR code displayed on your Admin Web Portal.
                </Text>
                <TouchableOpacity style={styles.primaryBtn} onPress={requestPermission}>
                  <Text style={styles.primaryBtnText}>Grant Camera Access</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={StyleSheet.absoluteFill}>
                <CameraView
                  style={StyleSheet.absoluteFill}
                  barcodeScannerSettings={{
                    barcodeTypes: ["qr"],
                  }}
                  onBarcodeScanned={scanCooldown ? undefined : handleBarcodeScanned}
                />

                {/* Reticle Overlay */}
                <View style={styles.overlay}>
                  <View style={styles.unfocusedContainer} />
                  <View style={styles.middleRow}>
                    <View style={styles.unfocusedContainer} />
                    <View style={styles.scannerTarget}>
                      <View style={[styles.corner, styles.topLeft]} />
                      <View style={[styles.corner, styles.topRight]} />
                      <View style={[styles.corner, styles.bottomLeft]} />
                      <View style={[styles.corner, styles.bottomRight]} />
                    </View>
                    <View style={styles.unfocusedContainer} />
                  </View>
                  <View style={styles.unfocusedContainer}>
                    <View style={styles.hintCard}>
                      <Ionicons name="qr-code-outline" size={20} color="#38BDF8" />
                      <Text style={styles.hintText}>
                        Point your camera at the QR code on your computer screen (Admin Web &gt; Settings &gt; Premises Anchors)
                      </Text>
                    </View>
                  </View>
                </View>
              </View>
            )}
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.calibrateScroll}>
            {/* Mode B: Calibration configuration screen */}
            {/* Live Link Badge */}
            <View style={styles.connectedCard}>
              <View style={styles.connectedIcon}>
                <Ionicons name="link-outline" size={20} color="#059669" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.connectedTitle}>Live Paired with Web Portal</Text>
                <Text style={styles.connectedSub}>
                  Organization: <Text style={{ fontWeight: "700", color: "#142748" }}>{targetOrg?.churchName || "Assembly"}</Text> ({targetOrg?.churchCode})
                </Text>
              </View>
            </View>

            {/* STEP 1: PHYSICAL WI-FI DETECTION (HYBRID ONLY) OR GEOFENCE ONLY BANNER */}
            {calibrationMode === "GEOFENCE_ONLY" ? (
              <View style={[styles.sectionCard, { backgroundColor: "#F0FDF4", borderColor: "#BBF7D0", borderWidth: 1 }]}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                  <View style={[styles.sectionIconCircle, { backgroundColor: "#DCFCE7" }]}>
                    <Ionicons name="navigate-circle" size={26} color="#16A34A" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 2 }}>
                      <Text style={{ fontSize: 15, fontWeight: "700", color: "#166534" }}>
                        Router-Free GPS Geofence Mode
                      </Text>
                      <View style={{ backgroundColor: "#BBF7D0", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 }}>
                        <Text style={{ fontSize: 10, fontWeight: "700", color: "#166534" }}>ACTIVE</Text>
                      </View>
                    </View>
                    <Text style={{ fontSize: 12, color: "#15803D", lineHeight: 17 }}>
                      Your organization is configured for satellite GPS verification only. No physical office Wi-Fi router required. Pinpoint your venue coordinates below.
                    </Text>
                  </View>
                </View>
              </View>
            ) : (
              <View style={styles.sectionCard}>
                <View style={styles.sectionHeader}>
                  <View style={[styles.sectionIconCircle, { backgroundColor: "#EFF6FF" }]}>
                    <Ionicons name="wifi" size={18} color="#2563EB" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.sectionTitle}>1. Premises Wi-Fi Anchor</Text>
                    <Text style={styles.sectionDesc}>Filter or select the premises router workers will detect</Text>
                  </View>
                  <TouchableOpacity
                    onPress={scanPhysicalWifi}
                    disabled={isScanningWifi}
                    style={styles.refreshIconBtn}
                  >
                    {isScanningWifi ? (
                      <ActivityIndicator size="small" color="#2563EB" />
                    ) : (
                      <Ionicons name="refresh" size={18} color="#2563EB" />
                    )}
                  </TouchableOpacity>
                </View>

                {/* Hotspot/Office Wi-Fi Alert */}
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "flex-start",
                    gap: 8,
                    backgroundColor: "#EFF6FF",
                    padding: 10,
                    borderRadius: 8,
                    marginBottom: 12,
                    borderWidth: 1,
                    borderColor: "#BFDBFE",
                  }}
                >
                  <Ionicons name="information-circle-outline" size={16} color="#2563EB" style={{ marginTop: 1 }} />
                  <Text style={{ fontSize: 11, color: "#1E40AF", lineHeight: 15, flex: 1 }}>
                    Ensure both this phone and your computer are actively connected to your office Wi-Fi router.
                  </Text>
                </View>

                {/* Wi-Fi Search / Filter Input */}
                <View style={styles.searchBarRow}>
                  <Ionicons name="search" size={16} color="#94A3B8" />
                  <TextInput
                    style={styles.searchBarInput}
                    value={wifiFilterQuery}
                    onChangeText={setWifiFilterQuery}
                    placeholder="Filter or search nearby Wi-Fi..."
                    placeholderTextColor="#94A3B8"
                  />
                  {wifiFilterQuery ? (
                    <TouchableOpacity onPress={() => setWifiFilterQuery("")}>
                      <Ionicons name="close-circle" size={16} color="#94A3B8" />
                    </TouchableOpacity>
                  ) : null}
                </View>

                {/* Detected Wi-Fi Networks List */}
                <View style={styles.networkList}>
                  {filteredNetworks.length > 0 ? (
                    filteredNetworks.map((net) => {
                      const isSelected = selectedBssid.toLowerCase() === net.bssid.toLowerCase();
                      return (
                        <TouchableOpacity
                          key={net.bssid + net.ssid}
                          style={[styles.networkItem, isSelected && styles.networkItemSelected]}
                          onPress={() => {
                            setSelectedSsid(net.ssid);
                            setSelectedBssid(net.bssid);
                          }}
                        >
                          <View style={styles.networkItemLeft}>
                            <Ionicons
                              name={isSelected ? "radio-button-on" : "radio-button-off"}
                              size={18}
                              color={isSelected ? "#2563EB" : "#94A3B8"}
                            />
                            <View style={{ marginLeft: 8 }}>
                              <Text style={[styles.networkSsid, isSelected && { color: "#1E40AF", fontWeight: "700" }]}>
                                {net.ssid}
                              </Text>
                              <Text style={styles.networkBssid}>{net.bssid}</Text>
                            </View>
                          </View>
                          {isSelected && (
                            <View style={styles.selectedBadge}>
                              <Text style={styles.selectedBadgeText}>Selected</Text>
                            </View>
                          )}
                        </TouchableOpacity>
                      );
                    })
                  ) : (
                    <Text style={{ fontSize: 13, color: "#94A3B8", textAlign: "center", paddingVertical: 12 }}>
                      No networks match your filter. Enter router SSID &amp; MAC below.
                    </Text>
                  )}
                </View>

                {/* Manual/Fine-tune fields */}
                <View style={styles.inputGroup}>
                  <Text style={styles.inputLabel}>Router SSID (Network Name)</Text>
                  <TextInput
                    style={styles.textInput}
                    value={selectedSsid}
                    onChangeText={setSelectedSsid}
                    placeholder="e.g. Office_Main_5G"
                    placeholderTextColor="#94A3B8"
                  />
                </View>

                <View style={styles.inputGroup}>
                  <Text style={styles.inputLabel}>Hardware BSSID (MAC Address)</Text>
                  <TextInput
                    style={[styles.textInput, { fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" }]}
                    value={selectedBssid}
                    onChangeText={setSelectedBssid}
                    placeholder="e.g. 0c:61:f9:65:8f:07"
                    placeholderTextColor="#94A3B8"
                    autoCapitalize="none"
                  />
                </View>
              </View>
            )}

            {/* STEP 2: GPS VENUE PINPOINT */}
            <View style={styles.sectionCard}>
              <View style={styles.sectionHeader}>
                <View style={[styles.sectionIconCircle, { backgroundColor: "#ECFDF5" }]}>
                  <Ionicons name="location" size={18} color="#059669" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.sectionTitle}>
                    {calibrationMode === "GEOFENCE_ONLY" ? "Premises GPS Geofence" : "2. Physical GPS Geofence"}
                  </Text>
                  <Text style={styles.sectionDesc}>Acquires device GPS or searches venue address</Text>
                </View>
              </View>

              {/* Location Search Bar */}
              <View style={styles.searchBarRow}>
                <Ionicons name="navigate-outline" size={16} color="#0284C7" />
                <TextInput
                  style={styles.searchBarInput}
                  value={addressSearchQuery}
                  onChangeText={setAddressSearchQuery}
                  placeholder="Search venue, city, or state (e.g. Calabar, CRS)..."
                  placeholderTextColor="#94A3B8"
                  onSubmitEditing={handleSearchAddress}
                  returnKeyType="search"
                />
                <TouchableOpacity
                  style={styles.searchAddressBtn}
                  onPress={handleSearchAddress}
                  disabled={isSearchingAddress}
                >
                  {isSearchingAddress ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : (
                    <Text style={styles.searchAddressBtnText}>Search</Text>
                  )}
                </TouchableOpacity>
              </View>

              {/* GPS Acquisition Card */}
              <View style={styles.gpsInfoBox}>
                <View style={styles.gpsCoordsRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.gpsLabel}>Latitude / Longitude</Text>
                    <Text style={styles.gpsCoordsText}>
                      {latitude !== null && longitude !== null
                        ? `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`
                        : "Location not captured yet"}
                    </Text>
                    {locationName ? (
                      <Text style={styles.venueLabelText} numberOfLines={2}>
                        📍 {locationName}
                      </Text>
                    ) : null}
                  </View>
                  {accuracy !== null && (
                    <View style={styles.accuracyPill}>
                      <Ionicons name="locate" size={12} color="#059669" />
                      <Text style={styles.accuracyText}>±{accuracy}m</Text>
                    </View>
                  )}
                </View>

                <TouchableOpacity
                  style={styles.acquireGpsBtn}
                  onPress={acquireGps}
                  disabled={isLocatingGps}
                >
                  {isLocatingGps ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : (
                    <>
                      <Ionicons name="navigate" size={16} color="#FFFFFF" />
                      <Text style={styles.acquireGpsBtnText}>
                        {latitude ? "Re-Acquire Device GPS Pin" : "Use Current Device Location"}
                      </Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>

              {/* LIVE SATELLITE HYBRID MAP */}
              <View style={{ borderRadius: 12, overflow: "hidden", borderWidth: 1, borderColor: "#CBD5E1", marginTop: 12 }}>
                <PresenceMapMobile
                  latitude={latitude ?? 4.975}
                  longitude={longitude ?? 8.3417}
                  radiusMeters={radiusMeters}
                  onCoordinatesChange={(lat, lng) => {
                    setLatitude(lat);
                    setLongitude(lng);
                    reverseGeocode(lat, lng);
                  }}
                  height={250}
                />
              </View>

              {/* Radius Selector */}
              <Text style={[styles.inputLabel, { marginTop: 14 }]}>Geofence Perimeter Boundary</Text>
              <View style={styles.radiusRow}>
                {[10, 20, 30, 50, 100].map((r) => (
                  <TouchableOpacity
                    key={r}
                    style={[styles.radiusChip, radiusMeters === r && styles.radiusChipActive]}
                    onPress={() => setRadiusMeters(r)}
                  >
                    <Text style={[styles.radiusChipText, radiusMeters === r && styles.radiusChipTextActive]}>
                      {r}m
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {/* COMMIT ACTION BUTTON */}
            <TouchableOpacity
              style={[styles.submitBtn, isSubmitting && { opacity: 0.7 }]}
              onPress={handleSaveCalibration}
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <>
                  <Ionicons name="cloud-upload" size={20} color="#FFFFFF" />
                  <Text style={styles.submitBtnText}>Save &amp; Sync to Web Portal</Text>
                </>
              )}
            </TouchableOpacity>
            <View style={{ height: 40 }} />
          </ScrollView>
        )}
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: C.canvas,
  },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: Platform.OS === "ios" ? 54 : 18,
    paddingBottom: 14,
    paddingHorizontal: S.screenX,
    backgroundColor: C.canvas,
  },
  closeBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: C.card,
    alignItems: "center",
    justifyContent: "center",
    ...shadow.card,
  },
  headerInfo: {
    alignItems: "center",
  },
  headerTitle: {
    ...T.heading,
    fontSize: 16,
  },
  headerSubtitle: {
    ...T.labelSm,
    color: C.muted,
    marginTop: 2,
  },
  scannerWrapper: {
    flex: 1,
    backgroundColor: C.ink,
  },
  permContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: S.xl,
    gap: S.md,
    backgroundColor: C.canvas,
  },
  permTitle: {
    ...T.title,
    textAlign: "center",
  },
  permText: {
    ...T.body,
    textAlign: "center",
  },
  primaryBtn: {
    ...ui.btnPrimary,
    paddingHorizontal: S.lg,
    marginTop: 8,
  },
  primaryBtnText: {
    ...ui.btnPrimaryText,
  },
  overlay: {
    ...StyleSheet.absoluteFill,
  },
  unfocusedContainer: {
    flex: 1,
    backgroundColor: "rgba(20, 39, 72, 0.72)",
    alignItems: "center",
    justifyContent: "center",
    padding: S.lg,
  },
  middleRow: {
    flexDirection: "row",
    height: 260,
  },
  scannerTarget: {
    width: 260,
    height: 260,
    position: "relative",
  },
  corner: {
    position: "absolute",
    width: 32,
    height: 32,
    borderColor: C.white,
  },
  topLeft: {
    top: 0,
    left: 0,
    borderTopWidth: 3,
    borderLeftWidth: 3,
    borderTopLeftRadius: 12,
  },
  topRight: {
    top: 0,
    right: 0,
    borderTopWidth: 3,
    borderRightWidth: 3,
    borderTopRightRadius: 12,
  },
  bottomLeft: {
    bottom: 0,
    left: 0,
    borderBottomWidth: 3,
    borderLeftWidth: 3,
    borderBottomLeftRadius: 12,
  },
  bottomRight: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 3,
    borderRightWidth: 3,
    borderBottomRightRadius: 12,
  },
  hintCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(20, 39, 72, 0.9)",
    paddingVertical: 12,
    paddingHorizontal: S.md,
    borderRadius: R.md,
    gap: 10,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.2)",
  },
  hintText: {
    color: C.white,
    fontSize: 13,
    lineHeight: 18,
    flexShrink: 1,
  },
  calibrateScroll: {
    paddingHorizontal: S.screenX,
    paddingVertical: S.md,
    gap: S.md,
    maxWidth: 540,
    width: "100%",
    alignSelf: "center",
  },
  connectedCard: {
    ...ui.card,
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
    gap: 12,
  },
  connectedIcon: {
    ...ui.iconBubble,
  },
  connectedTitle: {
    ...T.labelSm,
    color: C.ink,
  },
  connectedSub: {
    ...T.caption,
    fontSize: 12,
    marginTop: 2,
  },
  sectionCard: {
    ...ui.card,
    gap: 12,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  sectionIconCircle: {
    ...ui.iconBubble,
    backgroundColor: C.cardAlt,
  },
  sectionTitle: {
    ...T.labelSm,
    color: C.ink,
  },
  sectionDesc: {
    ...T.caption,
    fontSize: 12,
    marginTop: 1,
  },
  refreshIconBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: C.accentSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  networkList: {
    gap: 8,
    marginVertical: 4,
  },
  networkItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 12,
    backgroundColor: C.cardAlt,
    borderRadius: R.md,
    borderWidth: 1.5,
    borderColor: "transparent",
  },
  networkItemSelected: {
    backgroundColor: C.accentSoft,
    borderColor: C.accent,
  },
  networkItemLeft: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
  },
  networkSsid: {
    fontSize: 14,
    fontWeight: "600",
    color: C.ink,
  },
  networkBssid: {
    ...T.labelSm,
    fontSize: 10,
    color: C.muted,
    marginTop: 2,
  },
  selectedBadge: {
    backgroundColor: C.ink,
    paddingVertical: 3,
    paddingHorizontal: 9,
    borderRadius: R.pill,
  },
  selectedBadgeText: {
    ...T.labelSm,
    fontSize: 9,
    color: C.white,
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
  gpsInfoBox: {
    backgroundColor: C.cardAlt,
    padding: 14,
    borderRadius: R.md,
    gap: 12,
  },
  gpsCoordsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  gpsLabel: {
    ...T.labelSm,
    color: C.muted,
  },
  gpsCoordsText: {
    fontSize: 14,
    fontWeight: "700",
    color: C.ink,
    marginTop: 2,
    fontFamily: MONO,
  },
  accuracyPill: {
    ...ui.pill,
    backgroundColor: C.card,
  },
  accuracyText: {
    ...T.labelSm,
    fontSize: 10,
    color: C.ink,
  },
  acquireGpsBtn: {
    ...ui.btnPrimary,
    height: 46,
  },
  acquireGpsBtnText: {
    ...ui.btnPrimaryText,
    fontSize: 11,
  },
  radiusRow: {
    flexDirection: "row",
    gap: 8,
  },
  radiusChip: {
    flex: 1,
    paddingVertical: 10,
    backgroundColor: C.cardAlt,
    borderRadius: R.md,
    alignItems: "center",
    borderWidth: 1.5,
    borderColor: "transparent",
  },
  radiusChipActive: {
    backgroundColor: C.ink,
    borderColor: C.ink,
  },
  radiusChipText: {
    ...T.labelSm,
    color: C.ink2,
  },
  radiusChipTextActive: {
    color: C.white,
  },
  venueLabelText: {
    fontSize: 12.5,
    color: C.accent,
    fontWeight: "600",
    marginTop: 4,
  },
  searchBarRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: C.cardAlt,
    borderRadius: R.md,
    borderWidth: 1,
    borderColor: C.line,
    paddingHorizontal: 12,
    height: 48,
    gap: 8,
  },
  searchBarInput: {
    flex: 1,
    fontSize: 14,
    color: C.ink,
    padding: 0,
  },
  searchAddressBtn: {
    backgroundColor: C.ink,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: R.sm,
  },
  searchAddressBtnText: {
    ...T.labelSm,
    color: C.white,
  },
  submitBtn: {
    ...ui.btnPrimary,
    marginTop: 4,
    ...shadow.raised,
  },
  submitBtnText: {
    ...ui.btnPrimaryText,
  },
});
