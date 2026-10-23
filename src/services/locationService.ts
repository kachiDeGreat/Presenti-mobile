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

  // 3. Instant Last Known Position (super fast cached fix for instant UI feedback)
  let cachedCoords: LocationCoords | null = null;
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

  // 4. Fresh Location with Fast Indoor-Friendly Fallback
  // First attempt: High Accuracy with 3.5-second race timeout
  const timeoutMs = options?.timeoutMs ?? 3500;
  let liveLocation: Location.LocationObject | null = null;

  try {
    const highPromise = Location.getCurrentPositionAsync({
      accuracy: options?.preferredAccuracy ?? Location.Accuracy.High,
    });
    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), timeoutMs)
    );

    liveLocation = (await Promise.race([
      highPromise,
      timeoutPromise,
    ])) as Location.LocationObject | null;
  } catch (highErr) {
    console.warn("High-accuracy GPS attempt failed/timed out indoors:", highErr);
    liveLocation = null;
  }

  // If High Accuracy timed out or failed (very common indoors under ceilings)
  // Fall back immediately to Balanced (Google Fused Location: Wi-Fi + Cell + GPS)
  if (!liveLocation || !liveLocation.coords) {
    try {
      liveLocation = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
    } catch (balancedErr) {
      console.warn("Balanced location attempt error:", balancedErr);
      liveLocation = null;
    }
  }

  // If we got a live position, return it
  if (liveLocation?.coords) {
    return {
      latitude: parseFloat(liveLocation.coords.latitude.toFixed(6)),
      longitude: parseFloat(liveLocation.coords.longitude.toFixed(6)),
      accuracy: Math.round(liveLocation.coords.accuracy || 10),
    };
  }

  // If live location failed but we had a cached position, use cached
  if (cachedCoords) {
    return cachedCoords;
  }

  // If all attempts failed, throw a clear actionable message
  throw new Error(
    "Could not acquire GPS fix. Please ensure your phone has Location / Google Location Accuracy enabled and try again."
  );
}
