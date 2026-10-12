import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface AppPermissionsStatus {
  locationGranted: boolean;
  canAskAgain: boolean;
  gpsEnabled: boolean;
}

const STORAGE_KEY_PERMISSIONS_PROMPTED = '@sanctuary_permissions_prompted_v1';

/**
 * Checks current location permission without prompting the user.
 */
export async function checkLocationPermission(): Promise<boolean> {
  try {
    const { status } = await Location.getForegroundPermissionsAsync();
    return status === 'granted';
  } catch (err) {
    console.warn('Error checking location permission:', err);
    return false;
  }
}

/**
 * Checks full permissions and hardware GPS sensor status.
 */
export async function getAppPermissionsStatus(): Promise<AppPermissionsStatus> {
  try {
    const { status, canAskAgain } = await Location.getForegroundPermissionsAsync();
    let gpsEnabled = true;
    try {
      gpsEnabled = await Location.hasServicesEnabledAsync();
    } catch {
      // Best-effort check
    }

    return {
      locationGranted: status === 'granted',
      canAskAgain: canAskAgain ?? true,
      gpsEnabled,
    };
  } catch (err) {
    console.warn('Error getting full permission status:', err);
    return {
      locationGranted: false,
      canAskAgain: true,
      gpsEnabled: false,
    };
  }
}

/**
 * Prompts the user for all necessary app permissions (Foreground Location).
 * Automatically invoked on first app launch and accessible from onboarding / settings.
 */
export async function requestAllAppPermissions(forcePrompt: boolean = false): Promise<AppPermissionsStatus> {
  try {
    const alreadyPrompted = await AsyncStorage.getItem(STORAGE_KEY_PERMISSIONS_PROMPTED);

    // If already granted, return status immediately
    const current = await Location.getForegroundPermissionsAsync();
    if (current.status === 'granted') {
      let gps = true;
      try {
        gps = await Location.hasServicesEnabledAsync();
      } catch {}
      return {
        locationGranted: true,
        canAskAgain: false,
        gpsEnabled: gps,
      };
    }

    // If not forced and user was previously prompted and denied with 'never ask again'
    if (!forcePrompt && alreadyPrompted && !current.canAskAgain) {
      return {
        locationGranted: false,
        canAskAgain: false,
        gpsEnabled: false,
      };
    }

    // Request native OS foreground location permission
    const { status, canAskAgain } = await Location.requestForegroundPermissionsAsync();
    await AsyncStorage.setItem(STORAGE_KEY_PERMISSIONS_PROMPTED, 'true');

    let gpsEnabled = true;
    try {
      gpsEnabled = await Location.hasServicesEnabledAsync();
    } catch {}

    return {
      locationGranted: status === 'granted',
      canAskAgain: canAskAgain ?? true,
      gpsEnabled,
    };
  } catch (err) {
    console.warn('Error requesting permissions:', err);
    return {
      locationGranted: false,
      canAskAgain: false,
      gpsEnabled: false,
    };
  }
}
