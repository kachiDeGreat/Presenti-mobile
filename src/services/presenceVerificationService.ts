import { Platform } from 'react-native';
import * as Location from 'expo-location';
import type { CachedAnchors } from '../types';

export interface PresenceVerificationResult {
  isVerified: boolean;
  method: 'WIFI_BSSID' | 'GEO_FALLBACK';
  distanceMeters?: number;
  bssidDetected?: string;
  coordinates?: {
    latitude: number;
    longitude: number;
    accuracy?: number;
  };
  failureReason?: string;
  details: string;
}

/**
 * Standard Haversine distance formula (in meters) between two WGS-84 coordinates.
 * Matches Leaflet and Google Maps pinpoint calculation on Admin Web.
 */
export function calculateDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000; // Radius of Earth in meters
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

export interface PresenceAnchorConfig {
  targetBssid?: string;
  ssidHint?: string;
  latitude?: number;
  longitude?: number;
  radiusMeters?: number;
}

/**
 * Verifies that the worker is physically on-premise:
 * 1. Ambient Wi-Fi Beacon Scan (Android only):
 *    Silently listens for the church router's unique hardware MAC/BSSID in the air.
 *    The phone does NOT need to connect to the Wi-Fi.
 * 2. High-Accuracy GPS Geofencing (Fallback):
 *    Used if router is powered off, out of range, or on iOS.
 *    Rejects sign-in if outside the premises perimeter.
 */
export async function verifyPresenceAnchors(
  anchors?: PresenceAnchorConfig | null
): Promise<PresenceVerificationResult> {
  const targetBssid = anchors?.targetBssid?.trim();
  const targetLat = Number(anchors?.latitude ?? 0);
  const targetLng = Number(anchors?.longitude ?? 0);
  const targetRadius = Number(anchors?.radiusMeters ?? 30);
  const hasGeofence = targetLat !== 0 && targetLng !== 0;

  // -------------------------------------------------------------
  // STEP 1: Ambient Wi-Fi Beacon Scan (Android only)
  // Searches ambient radio waves for the router's hardware BSSID (MAC).
  // The worker's phone does NOT need to be connected to the router.
  // -------------------------------------------------------------
  if (Platform.OS === 'android' && targetBssid) {
    try {
      // Dynamically require native module with safe fallback
      const wifiModule = require('react-native-wifi-reborn');
      const WifiManager = wifiModule?.default || wifiModule;

      if (WifiManager) {
        let wifiList: any[] = [];
        try {
          if (typeof WifiManager.reScanAndLoadWifiList === 'function') {
            wifiList = await WifiManager.reScanAndLoadWifiList();
          } else if (typeof WifiManager.loadWifiList === 'function') {
            wifiList = await WifiManager.loadWifiList();
          }
        } catch (scanErr) {
          // If fresh scan is throttled by Android OS (max 4 scans / 2 min), read cached scan results
          if (typeof WifiManager.loadWifiList === 'function') {
            try {
              wifiList = await WifiManager.loadWifiList();
            } catch (_) {}
          }
        }

        if (Array.isArray(wifiList) && wifiList.length > 0) {
          const cleanTarget = targetBssid.toLowerCase().replace(/[^a-f0-9]/g, '');

          const matchedBeacon = wifiList.find((entry: any) => {
            const rawBssid = String(entry.BSSID || '').toLowerCase().replace(/[^a-f0-9]/g, '');
            return rawBssid && rawBssid === cleanTarget;
          });

          if (matchedBeacon) {
            const signalLevel = matchedBeacon.level ? ` (${matchedBeacon.level} dBm)` : '';
            return {
              isVerified: true,
              method: 'WIFI_BSSID',
              bssidDetected: matchedBeacon.BSSID || targetBssid,
              details: `Confirmed on-premise via ambient hardware beacon [${matchedBeacon.BSSID}]${signalLevel}.`,
            };
          }
        }
      }
    } catch (wifiErr) {
      console.warn('Ambient Wi-Fi scan skipped (native module pending rebuild):', wifiErr);
    }
  }

  // -------------------------------------------------------------
  // STEP 2: High-Accuracy GPS Geofencing (Fallback)
  // Used if beacon is off, out of range, phone Wi-Fi toggle is off,
  // or on iOS (Apple restricts ambient Wi-Fi BSSID scanning).
  // -------------------------------------------------------------
  if (!hasGeofence) {
    return {
      isVerified: false,
      method: 'GEO_FALLBACK',
      failureReason:
        'Target Wi-Fi anchor was not detected in range, and no Geofence GPS coordinates are calibrated for this organization.',
      details: 'No GPS coordinates configured.',
    };
  }

  try {
    // 1. Request location permissions if not already granted
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      return {
        isVerified: false,
        method: 'GEO_FALLBACK',
        failureReason:
          'Location permission was denied. Please allow location access in your device settings to verify physical presence on-premise.',
        details: 'Location permission denied.',
      };
    }

    // 2. Check if hardware GPS toggle is enabled on the device
    const isGpsEnabled = await Location.hasServicesEnabledAsync().catch(() => true);
    if (!isGpsEnabled) {
      return {
        isVerified: false,
        method: 'GEO_FALLBACK',
        failureReason:
          'Your device location (GPS) is turned off. Please turn on Location in your phone swipe-down quick settings.',
        details: 'Device GPS toggle is off.',
      };
    }

    // 3. Acquire current high-accuracy GPS fix from hardware sensor
    const location = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
    });

    const userLat = location.coords.latitude;
    const userLng = location.coords.longitude;
    const gpsAccuracy = location.coords.accuracy || 15;

    // 4. Calculate exact physical distance in meters using Haversine formula
    const distance = calculateDistanceMeters(
      userLat,
      userLng,
      targetLat,
      targetLng
    );

    // Dynamic radius buffer to account for indoor GPS drift
    const configuredRadius = targetRadius || 30;
    // Allow configured radius + real GPS hardware accuracy tolerance (max 35m tolerance)
    const effectiveRadius = Math.max(configuredRadius, 20) + Math.min(gpsAccuracy, 35);

    // If outside premises perimeter, strictly reject check-in
    if (distance > effectiveRadius) {
      return {
        isVerified: false,
        method: 'GEO_FALLBACK',
        distanceMeters: distance,
        failureReason: `You are currently outside the organization premises (${distance}m away). The maximum allowed perimeter is ${configuredRadius}m. Physical presence is required to clock in.`,
        details: `Outside geofence: ${distance}m away (limit: ${configuredRadius}m).`,
      };
    }

    // 5. Confirmed on premises via GPS Geofence!
    return {
      isVerified: true,
      method: 'GEO_FALLBACK',
      distanceMeters: distance,
      coordinates: {
        latitude: userLat,
        longitude: userLng,
        accuracy: gpsAccuracy,
      },
      details: `Confirmed on-premise via GPS Geofence (${distance}m from center, perimeter: ${configuredRadius}m).`,
    };
  } catch (geoErr: any) {
    console.error('Geolocation verification error:', geoErr);
    return {
      isVerified: false,
      method: 'GEO_FALLBACK',
      failureReason:
        geoErr?.message ||
        'Unable to acquire GPS lock. Please ensure location services are enabled on your device.',
      details: 'GPS error.',
    };
  }
}
