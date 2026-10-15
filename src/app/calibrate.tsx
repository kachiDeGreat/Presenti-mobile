import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  TextInput,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import * as Location from 'expo-location';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { PresenceMapMobile } from '../components/PresenceMapMobile';
import { scanPhysicalWifiNetworks, ScannedWifiNetwork } from '../services/wifiScanService';
import { AdminCalibrationModal } from '../components/AdminCalibrationModal';

const RADIUS_OPTIONS = [10, 20, 30, 50, 80, 100];

export default function CalibrateScreen() {
  const { organization, updateAnchors } = useAuth();
  const toast = useToast();

  const [showQrModal, setShowQrModal] = useState(false);

  // Tier 1: Wi-Fi Anchor State
  const [availableNetworks, setAvailableNetworks] = useState<ScannedWifiNetwork[]>([]);
  const [isScanningWifi, setIsScanningWifi] = useState(false);
  const [selectedSsid, setSelectedSsid] = useState<string>('');
  const [selectedBssid, setSelectedBssid] = useState<string>('');
  const [showManualWifi, setShowManualWifi] = useState(false);

  // Tier 2: Geofence State
  const [latitude, setLatitude] = useState<number>(4.975);
  const [longitude, setLongitude] = useState<number>(8.3417);
  const [radiusMeters, setRadiusMeters] = useState<number>(10);
  const [isLocating, setIsLocating] = useState(false);

  // Form Submission
  const [isSaving, setIsSaving] = useState(false);

  // Load existing organization configuration on mount
  useEffect(() => {
    if (organization) {
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

  // Scan Real Wi-Fi Networks
  const handleScanWifi = useCallback(async () => {
    setIsScanningWifi(true);
    try {
      const res = await scanPhysicalWifiNetworks();
      if (res.success && res.networks) {
        setAvailableNetworks(res.networks);
        if (res.networks.length > 0 && !selectedBssid) {
          // If none selected yet, hint the first network
          toast.info(`Found ${res.networks.length} nearby wireless networks. Tap to select.`);
        }
      } else if (res.error) {
        toast.warn(res.error);
      }
    } catch (err: any) {
      toast.error('Could not scan Wi-Fi signals.');
    } finally {
      setIsScanningWifi(false);
    }
  }, [selectedBssid, toast]);

  // Initial Wi-Fi scan on mount
  useEffect(() => {
    handleScanWifi();
  }, [handleScanWifi]);

  // Fetch Current Phone GPS Location
  const handleGetCurrentLocation = async () => {
    setIsLocating(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        toast.warn('Location permission was denied. Please allow location access.');
        setIsLocating(false);
        return;
      }

      const loc = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });

      const lat = parseFloat(loc.coords.latitude.toFixed(6));
      const lng = parseFloat(loc.coords.longitude.toFixed(6));
      setLatitude(lat);
      setLongitude(lng);
      toast.success(`Acquired GPS coordinates (±${Math.round(loc.coords.accuracy || 5)}m accuracy).`);
    } catch (err: any) {
      toast.error('Could not acquire current GPS location.');
    } finally {
      setIsLocating(false);
    }
  };

  const handleSelectNetwork = (net: ScannedWifiNetwork) => {
    setSelectedSsid(net.ssid);
    setSelectedBssid(net.bssid);
    toast.info(`Selected router: ${net.ssid} (${net.bssid})`);
  };

  const handleSaveCalibration = async () => {
    if (!selectedBssid.trim()) {
      toast.warn('Please select or enter your premises Wi-Fi router BSSID (MAC).');
      return;
    }
    if (!selectedSsid.trim()) {
      toast.warn('Please enter a router SSID label.');
      return;
    }
    if (!latitude || !longitude) {
      toast.warn('Please set a valid geolocation coordinate.');
      return;
    }

    setIsSaving(true);
    try {
      await updateAnchors({
        ssidHint: selectedSsid.trim(),
        targetBssid: selectedBssid.trim().toLowerCase(),
        latitude,
        longitude,
        radiusMeters,
      });
      toast.success('Organization anchors calibrated and saved successfully!');
      router.back();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to save calibration settings.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => router.back()}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="chevron-back" size={24} color="#0F172A" />
        </TouchableOpacity>
        <View style={styles.headerTitleGroup}>
          <Text style={styles.headerTitle}>Calibrate Premises</Text>
          <Text style={styles.headerSubtitle}>
            {organization?.churchName || 'Organization'} • {organization?.branchName || 'Premises'}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.refreshHeaderBtn}
          onPress={handleScanWifi}
          disabled={isScanningWifi}
        >
          <Ionicons
            name="refresh"
            size={20}
            color={isScanningWifi ? '#94A3B8' : '#0284C7'}
          />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Quick QR Scanner Link */}
        <TouchableOpacity
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: '#0284C7',
            padding: 14,
            borderRadius: 12,
            gap: 12,
            shadowColor: '#0284C7',
            shadowOffset: { width: 0, height: 3 },
            shadowOpacity: 0.2,
            shadowRadius: 6,
            elevation: 3,
          }}
          onPress={() => setShowQrModal(true)}
        >
          <View
            style={{
              width: 36,
              height: 36,
              borderRadius: 8,
              backgroundColor: 'rgba(255,255,255,0.2)',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Ionicons name="qr-code-outline" size={20} color="#FFFFFF" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 14, fontWeight: '700', color: '#FFFFFF' }}>
              Scan Web Portal QR Code
            </Text>
            <Text style={{ fontSize: 11, color: '#E0F2FE', marginTop: 1 }}>
              Point camera at Admin Web to pair and calibrate
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color="#FFFFFF" />
        </TouchableOpacity>

        {/* Tier 1: Wi-Fi Anchor Section */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={[styles.cardIconBox, { backgroundColor: '#EFF6FF' }]}>
              <Ionicons name="wifi" size={20} color="#0284C7" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>1. Premises Wi-Fi Router (Anchor)</Text>
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

          {/* Scanned Networks List */}
          <View style={styles.wifiListContainer}>
            {isScanningWifi && availableNetworks.length === 0 ? (
              <View style={styles.emptyState}>
                <ActivityIndicator size="small" color="#0284C7" />
                <Text style={styles.emptyStateText}>Scanning nearby radio airwaves...</Text>
              </View>
            ) : availableNetworks.length > 0 ? (
              availableNetworks.map((net) => {
                const isSelected =
                  Boolean(selectedBssid) &&
                  selectedBssid.toLowerCase() === net.bssid.toLowerCase();
                return (
                  <TouchableOpacity
                    key={net.bssid}
                    style={[styles.wifiItem, isSelected && styles.wifiItemActive]}
                    onPress={() => handleSelectNetwork(net)}
                  >
                    <View style={styles.wifiItemLeft}>
                      <Ionicons
                        name="wifi"
                        size={18}
                        color={isSelected ? '#0284C7' : '#64748B'}
                      />
                      <View>
                        <Text
                          style={[
                            styles.wifiItemSsid,
                            isSelected && styles.wifiItemSsidActive,
                          ]}
                        >
                          {net.ssid}
                        </Text>
                        <Text style={styles.wifiItemBssid}>{net.bssid}</Text>
                      </View>
                    </View>
                    <View style={styles.wifiItemRight}>
                      <Text style={styles.wifiBandBadge}>{net.band}</Text>
                      {isSelected && (
                        <Ionicons name="checkmark-circle" size={20} color="#0284C7" />
                      )}
                    </View>
                  </TouchableOpacity>
                );
              })
            ) : (
              <View style={styles.emptyState}>
                <Text style={styles.emptyStateText}>
                  No networks detected. Make sure Wi-Fi and Location are turned on.
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
              {showManualWifi ? 'Hide Manual Inputs' : 'Manual Router MAC / Hidden SSID Entry'}
            </Text>
            <Ionicons
              name={showManualWifi ? 'chevron-up' : 'chevron-down'}
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
                <Text style={styles.fieldLabel}>Router Hardware MAC (BSSID) *</Text>
                <TextInput
                  style={[styles.input, { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }]}
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

        {/* Tier 2: Interactive Geolocation Map */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={[styles.cardIconBox, { backgroundColor: '#F0FDF4' }]}>
              <Ionicons name="location" size={20} color="#16A34A" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>2. Geofence Perimeter (GPS)</Text>
              <Text style={styles.cardSubtitle}>
                Drag the marker or tap the map to set workplace center
              </Text>
            </View>
            <TouchableOpacity
              style={[styles.scanActionBtn, { backgroundColor: '#F0FDF4', borderColor: '#BBF7D0' }]}
              onPress={handleGetCurrentLocation}
              disabled={isLocating}
            >
              {isLocating ? (
                <ActivityIndicator size="small" color="#16A34A" />
              ) : (
                <Text style={[styles.scanActionText, { color: '#16A34A' }]}>🎯 Phone GPS</Text>
              )}
            </TouchableOpacity>
          </View>

          {/* Interactive Satellite Hybrid Map */}
          <PresenceMapMobile
            latitude={latitude}
            longitude={longitude}
            radiusMeters={radiusMeters}
            onCoordinatesChange={(lat, lng) => {
              setLatitude(lat);
              setLongitude(lng);
            }}
            height={260}
          />

          {/* Coordinates readout */}
          <View style={styles.coordsRow}>
            <View style={styles.coordBox}>
              <Text style={styles.coordLabel}>Latitude</Text>
              <Text style={styles.coordVal}>{latitude.toFixed(6)}</Text>
            </View>
            <View style={styles.coordBox}>
              <Text style={styles.coordLabel}>Longitude</Text>
              <Text style={styles.coordVal}>{longitude.toFixed(6)}</Text>
            </View>
          </View>

          {/* Radius Selector */}
          <View style={styles.radiusSection}>
            <Text style={styles.radiusTitle}>
              Geofence Radius: <Text style={{ color: '#0284C7', fontWeight: '700' }}>{radiusMeters} meters</Text>
            </Text>
            <View style={styles.radiusGrid}>
              {RADIUS_OPTIONS.map((r) => {
                const isActive = radiusMeters === r;
                return (
                  <TouchableOpacity
                    key={r}
                    style={[styles.radiusBtn, isActive && styles.radiusBtnActive]}
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

        {/* Calibration Summary */}
        <View style={styles.summaryBox}>
          <Text style={styles.summaryTitle}>Configured Anchors Summary</Text>
          <View style={styles.summaryRow}>
            <Ionicons name="wifi-outline" size={16} color="#64748B" />
            <Text style={styles.summaryLabel}>Router:</Text>
            <Text style={styles.summaryVal}>
              {selectedSsid || 'None'} {selectedBssid ? `(${selectedBssid})` : ''}
            </Text>
          </View>
          <View style={styles.summaryRow}>
            <Ionicons name="navigate-outline" size={16} color="#64748B" />
            <Text style={styles.summaryLabel}>Geofence:</Text>
            <Text style={styles.summaryVal}>
              {latitude.toFixed(4)}, {longitude.toFixed(4)} ({radiusMeters}m radius)
            </Text>
          </View>
        </View>

        <TouchableOpacity
          style={[styles.saveBtn, isSaving && styles.saveBtnDisabled]}
          onPress={handleSaveCalibration}
          disabled={isSaving}
        >
          {isSaving ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <>
              <Ionicons name="checkmark-done" size={20} color="#FFFFFF" />
              <Text style={styles.saveBtnText}>Save Organization Calibration</Text>
            </>
          )}
        </TouchableOpacity>
      </ScrollView>

      {/* Admin QR Code Scanner Modal */}
      <AdminCalibrationModal
        visible={showQrModal}
        onClose={() => setShowQrModal(false)}
        onSuccess={() => {
          router.back();
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#F8FAFC',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
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
    fontWeight: '700',
    color: '#0F172A',
  },
  headerSubtitle: {
    fontSize: 12,
    color: '#64748B',
    marginTop: 1,
  },
  refreshHeaderBtn: {
    padding: 8,
    borderRadius: 8,
    backgroundColor: '#F1F5F9',
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 40,
    gap: 16,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
    gap: 14,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  cardIconBox: {
    width: 38,
    height: 38,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#0F172A',
  },
  cardSubtitle: {
    fontSize: 12,
    color: '#64748B',
    marginTop: 2,
  },
  scanActionBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#EFF6FF',
    borderWidth: 1,
    borderColor: '#BFDBFE',
  },
  scanActionText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#0284C7',
  },
  wifiListContainer: {
    backgroundColor: '#F8FAFC',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    overflow: 'hidden',
  },
  wifiItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
  },
  wifiItemActive: {
    backgroundColor: '#F0F9FF',
    borderLeftWidth: 3,
    borderLeftColor: '#0284C7',
  },
  wifiItemLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
  },
  wifiItemSsid: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1E293B',
  },
  wifiItemSsidActive: {
    color: '#0284C7',
    fontWeight: '700',
  },
  wifiItemBssid: {
    fontSize: 11,
    color: '#94A3B8',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginTop: 2,
  },
  wifiItemRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  wifiBandBadge: {
    fontSize: 11,
    fontWeight: '600',
    color: '#64748B',
    backgroundColor: '#E2E8F0',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  emptyState: {
    padding: 20,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  emptyStateText: {
    fontSize: 13,
    color: '#94A3B8',
    textAlign: 'center',
  },
  manualToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 4,
  },
  manualToggleText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#0284C7',
  },
  manualInputsGroup: {
    gap: 12,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#F1F5F9',
  },
  field: {
    gap: 6,
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#475569',
  },
  input: {
    height: 42,
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 8,
    paddingHorizontal: 12,
    fontSize: 14,
    color: '#0F172A',
  },
  coordsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  coordBox: {
    flex: 1,
    backgroundColor: '#F8FAFC',
    borderRadius: 8,
    padding: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  coordLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: '#64748B',
    textTransform: 'uppercase',
  },
  coordVal: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0F172A',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginTop: 2,
  },
  radiusSection: {
    gap: 8,
  },
  radiusTitle: {
    fontSize: 13,
    color: '#475569',
    fontWeight: '500',
  },
  radiusGrid: {
    flexDirection: 'row',
    gap: 6,
    flexWrap: 'wrap',
  },
  radiusBtn: {
    flex: 1,
    minWidth: 44,
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F8FAFC',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  radiusBtnActive: {
    backgroundColor: '#0284C7',
    borderColor: '#0284C7',
  },
  radiusBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748B',
  },
  radiusBtnTextActive: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  summaryBox: {
    backgroundColor: '#F1F5F9',
    borderRadius: 12,
    padding: 14,
    gap: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  summaryTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#1E293B',
    marginBottom: 2,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  summaryLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#475569',
  },
  summaryVal: {
    fontSize: 12,
    color: '#0F172A',
    flex: 1,
  },
  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#059669',
    height: 48,
    borderRadius: 12,
    shadowColor: '#059669',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 3,
  },
  saveBtnDisabled: {
    opacity: 0.7,
  },
  saveBtnText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
});
