import { Platform } from 'react-native';
import * as Location from 'expo-location';
import type { CachedAnchors } from '../types';
import { acquireDeviceCoordinates } from './locationService';

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
  verificationMode?: 'HYBRID' | 'GEOFENCE_ONLY';
}

/**
 * Verifies that the worker is physically on-premise:
 * 1. Ambient Wi-Fi Beacon Scan (Android only - HYBRID mode only):
 *    Silently listens for the church/company router's unique hardware MAC/BSSID in the air.
 *    The phone does NOT need to connect to the Wi-Fi.
 *    If the company is configured as GEOFENCE_ONLY, this step is completely skipped.
 * 2. High-Accuracy GPS Geofencing:
 *    Always active for GEOFENCE_ONLY companies, and acts as instant fail-safe
 *    fallback in HYBRID mode if router is out of range or phone Wi-Fi toggle is off.
 */
export async function verifyPresenceAnchors(
  anchors?: PresenceAnchorConfig | null
): Promise<PresenceVerificationResult> {
  const targetBssid = anchors?.targetBssid?.trim();
  const targetLat = Number(anchors?.latitude ?? 0);
  const targetLng = Number(anchors?.longitude ?? 0);
  const targetRadius = Number(anchors?.radiusMeters ?? 30);
  const hasGeofence = targetLat !== 0 && targetLng !== 0;

  // Determine verification mode: explicit or inferred from targetBssid presence
  const mode: 'HYBRID' | 'GEOFENCE_ONLY' =
    anchors?.verificationMode || (targetBssid ? 'HYBRID' : 'GEOFENCE_ONLY');
  const isHybrid = mode === 'HYBRID' && Boolean(targetBssid);

  // Step 1: Ambient Wi-Fi scan on Android for hybrid mode
  if (Platform.OS === 'android' && isHybrid && targetBssid) {
    try {
      // Dynamically require native module with safe fallback
      const wifiModule = require('react-native-wifi-reborn');
      const WifiManager = wifiModule?.default || wifiModule;

      if (WifiManager) {
        let wifiList: any[] = [];
        try {
          const scanPromise = (async () => {
            if (typeof WifiManager.reScanAndLoadWifiList === 'function') {
              return await WifiManager.reScanAndLoadWifiList();
            } else if (typeof WifiManager.loadWifiList === 'function') {
              return await WifiManager.loadWifiList();
            }
            return [];
          })();

          // Fast 3.5-second timeout on primary Wi-Fi scan before falling back to geofence
          const timeoutPromise = new Promise<any[]>((resolve) =>
            setTimeout(() => resolve([]), 3500)
          );

          wifiList = await Promise.race([scanPromise, timeoutPromise]).catch(() => []);
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

  // Step 2: GPS geofence check (used for geofence mode, iOS, or Wi-Fi fallback)
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
    // Acquire current GPS fix using robust tiered acquisition (instant cached + live + indoor fallback)
    const location = await acquireDeviceCoordinates();

    const userLat = location.latitude;
    const userLng = location.longitude;
    const gpsAccuracy = location.accuracy || 15;

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
