import * as Location from "expo-location";
import { Platform } from "react-native";

export interface LocationCoords {
  latitude: number;
  longitude: number;
  accuracy: number;
}

export interface AcquireLocationOptions {
  onInstantFix?: (coords: LocationCoords) => void;
  preferredAccuracy?: Location.Accuracy;
  timeoutMs?: number;
  /** When true (e.g. attendance punch), never use cached/stale fixes and block mock GPS */
  strictFresh?: boolean;
}

/**
 * Checks if location permissions are granted and device location hardware services (GPS) are on.
 */
export async function checkDeviceLocationStatus(): Promise<{
  permissionGranted: boolean;
  servicesEnabled: boolean;
}> {
  try {
    const { status } = await Location.getForegroundPermissionsAsync();
    let servicesEnabled = true;
    try {
      servicesEnabled = await Location.hasServicesEnabledAsync();
    } catch {
      // Best effort
    }
    return {
      permissionGranted: status === "granted",
      servicesEnabled,
    };
  } catch {
    return {
      permissionGranted: false,
      servicesEnabled: false,
    };
  }
}

/**
 * High-performance, robust GPS acquisition designed for Android & iOS:
 *
 * 1. Checks/requests foreground location permission.
 * 2. Verifies device location services (GPS) toggle.
 *    - On Android, triggers `enableNetworkProviderAsync()` if device location is off or in "Device only" mode.
 * 3. Immediately checks `getLastKnownPositionAsync()`:
 *    - Fires `onInstantFix` callback if cached coordinates are available (0ms latency UI response).
 * 4. Acquires fresh location with smart indoor-friendly fallback:
 *    - Attempts `Accuracy.High` with a 3.5s race timeout.
 *    - If high-accuracy times out (e.g. indoors where satellite lock is blocked) or errors,
 *      immediately falls back to `Accuracy.Balanced` (Google Fused / Wi-Fi / Cell network provider).
 *    - Falls back to `lastKnown` if both live attempts fail.
 */
export async function acquireDeviceCoordinates(
  options?: AcquireLocationOptions
): Promise<LocationCoords> {
  // 1. Permission check
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== "granted") {
    throw new Error(
      "Location permission denied. Please grant location access in your phone App Settings."
    );
  }

  // 2. Hardware GPS / Location Services toggle check
  const servicesEnabled = await Location.hasServicesEnabledAsync().catch(() => true);
  if (!servicesEnabled) {
    if (Platform.OS === "android") {
      try {
        await Location.enableNetworkProviderAsync();
      } catch {
        throw new Error(
          "Device Location is turned off. Please swipe down from your phone's notification bar and turn on the 'Location' (GPS) icon."
        );
      }
    } else {
      throw new Error(
        "Device Location Services are turned off. Please enable Location in your phone Settings."
      );
    }
  }

  const strictFresh = Boolean(options?.strictFresh);

  // 3. Instant Last Known Position (ONLY for non-strict UI previews, NEVER for attendance punches)
  let cachedCoords: LocationCoords | null = null;
  if (!strictFresh) {
    try {
      const lastKnown = await Location.getLastKnownPositionAsync();
      if (lastKnown?.coords) {
        cachedCoords = {
          latitude: parseFloat(lastKnown.coords.latitude.toFixed(6)),
          longitude: parseFloat(lastKnown.coords.longitude.toFixed(6)),
          accuracy: Math.round(lastKnown.coords.accuracy || 15),
        };
        if (options?.onInstantFix) {
          options.onInstantFix(cachedCoords);
        }
      }
    } catch {
      // Non-fatal, continue to live capture
    }
  }

  // Helper: validate freshness and anti-mock on a LocationObject
  const validateFix = (loc: Location.LocationObject | null): Location.LocationObject | null => {
    if (!loc?.coords) return null;
    if ((loc as any).mocked === true) {
      throw new Error(
        "Mock or fake GPS location detected. Please disable GPS spoofing apps to clock in."
      );
    }
    if (strictFresh && loc.timestamp) {
      const ageMs = Date.now() - loc.timestamp;
      if (ageMs > 120_000) {
        // Stale OS-cached location (>120s old) — discard so we force a live fix
        return null;
      }
    }
    return loc;
  };

  // 4. Fresh Location with Hardware-First Acquisition
  const timeoutMs = options?.timeoutMs ?? (strictFresh ? 5500 : 3500);
  let liveLocation: Location.LocationObject | null = null;

  try {
    const highPromise = Location.getCurrentPositionAsync({
      accuracy: options?.preferredAccuracy ?? Location.Accuracy.High,
    });
    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), timeoutMs)
    );

    const candidate = (await Promise.race([
      highPromise,
      timeoutPromise,
    ])) as Location.LocationObject | null;
    liveLocation = validateFix(candidate);
  } catch (highErr: any) {
    if (String(highErr?.message || "").includes("Mock or fake GPS")) {
      throw highErr;
    }
    console.warn("High-accuracy GPS attempt failed/timed out indoors:", highErr);
    liveLocation = null;
  }

  // If strictFresh didn't get a fresh fix yet, subscribe briefly to watchPositionAsync
  // to force Android/iOS location hardware to emit a brand-new reading instead of a stale OS cache
  if (strictFresh && !liveLocation) {
    liveLocation = await new Promise<Location.LocationObject | null>((resolve, reject) => {
      let settled = false;
      let sub: Location.LocationSubscription | null = null;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          sub?.remove();
          resolve(null);
        }
      }, 4500);

      Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.Balanced,
          timeInterval: 500,
          distanceInterval: 0,
        },
        (loc) => {
          if (settled) return;
          try {
            const valid = validateFix(loc);
            if (valid) {
              settled = true;
              clearTimeout(timer);
              sub?.remove();
              resolve(valid);
            }
          } catch (mockErr) {
            settled = true;
            clearTimeout(timer);
            sub?.remove();
            reject(mockErr);
          }
        }
      )
        .then((subscription) => {
          if (settled) {
            subscription.remove();
          } else {
            sub = subscription;
          }
        })
        .catch(() => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(null);
          }
        });
    });
  }

  // Non-strict indoor fallback to Balanced (never used as stale fallback in strictFresh)
  if (!strictFresh && (!liveLocation || !liveLocation.coords)) {
    try {
      liveLocation = validateFix(
        await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        })
      );
    } catch (balancedErr) {
      console.warn("Balanced location attempt error:", balancedErr);
      liveLocation = null;
    }
  }

  // If we got a valid live position, return it
  if (liveLocation?.coords) {
    return {
      latitude: parseFloat(liveLocation.coords.latitude.toFixed(6)),
      longitude: parseFloat(liveLocation.coords.longitude.toFixed(6)),
      accuracy: Math.round(liveLocation.coords.accuracy || 10),
    };
  }

  // Only allow cached fallback when NOT in strictFresh mode
  if (!strictFresh && cachedCoords) {
    return cachedCoords;
  }

  throw new Error(
    strictFresh
      ? "Could not acquire a fresh live GPS fix. Ensure Location Accuracy is on and step near an open area or connect to the office Wi-Fi."
      : "Could not acquire GPS fix. Please ensure your phone has Location / Google Location Accuracy enabled and try again."
  );
}
