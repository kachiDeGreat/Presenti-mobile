import * as LocalAuthentication from 'expo-local-authentication';

export interface BiometricCapabilities {
  hasHardware: boolean;
  isEnrolled: boolean;
  supportedTypes: LocalAuthentication.AuthenticationType[];
  biometricLabel: string;
}

export interface BiometricAuthResult {
  success: boolean;
  method: 'BIOMETRIC' | 'DEVICE_PASSCODE';
  biometricType?: string;
  errorTitle?: string;
  error?: string;
  instruction?: string;
  needsSetup?: boolean;
}

/**
 * Checks the device's physical biometric capabilities
 */
export async function getBiometricCapabilities(): Promise<BiometricCapabilities> {
  try {
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    const isEnrolled = await LocalAuthentication.isEnrolledAsync();
    const supportedTypes = await LocalAuthentication.supportedAuthenticationTypesAsync();

    let biometricLabel = 'Device Security';
    if (supportedTypes.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) {
      biometricLabel = 'Face ID';
    } else if (supportedTypes.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) {
      biometricLabel = 'Fingerprint';
    } else if (hasHardware) {
      biometricLabel = 'Biometrics';
    }

    return {
      hasHardware,
      isEnrolled,
      supportedTypes,
      biometricLabel,
    };
  } catch (error) {
    console.warn('Error checking biometric capabilities:', error);
    return {
      hasHardware: false,
      isEnrolled: false,
      supportedTypes: [],
      biometricLabel: 'Device Security',
    };
  }
}

/**
 * Mandatory presence identity verification on Clock-In:
 * - If phone has physical biometric hardware (Face ID / Fingerprint) & enrolled:
 *   STRICTLY forces biometric scan with disableDeviceFallback: true (passcode blocked).
 * - If phone has biometric hardware but nothing enrolled:
 *   Instructs worker to register fingerprint in phone settings.
 * - If phone physically lacks biometric sensor (budget phone):
 *   Falls back to phone's secure device PIN / pattern / password.
 */
export async function verifyIdentityForClockIn(): Promise<BiometricAuthResult> {
  try {
    const capabilities = await getBiometricCapabilities();

    // Case 1: Phone has physical biometric hardware AND user has enrolled biometrics
    if (capabilities.hasHardware && capabilities.isEnrolled) {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: `Scan your ${capabilities.biometricLabel} to confirm attendance`,
        cancelLabel: 'Cancel',
        disableDeviceFallback: true, // Forces physical biometrics ONLY! Blocks phone passcode sharing!
      });

      if (result.success) {
        return {
          success: true,
          method: 'BIOMETRIC',
          biometricType: capabilities.biometricLabel,
        };
      }

      if (result.error === 'user_cancel' || result.error === 'system_cancel') {
        return {
          success: false,
          method: 'BIOMETRIC',
          errorTitle: `Scan ${capabilities.biometricLabel} to Clock In`,
          error: `Identity verification is required to confirm your attendance.`,
          instruction: `Tap 'Tap to Clock In' again and hold your registered finger on the sensor (or look at the camera) when prompted.`,
        };
      }

      if (result.error === 'authentication_failed') {
        return {
          success: false,
          method: 'BIOMETRIC',
          errorTitle: `${capabilities.biometricLabel} Not Recognized`,
          error: `The scan did not match the registered profile on this phone.`,
          instruction: `Tap 'Tap to Clock In' again and place your registered finger firmly and squarely on the scanner.`,
        };
      }

      if (result.error === 'lockout') {
        return {
          success: false,
          method: 'BIOMETRIC',
          errorTitle: `${capabilities.biometricLabel} Sensor Locked`,
          error: `Too many unsuccessful scan attempts.`,
          instruction: `Lock your phone and unlock it with your PIN/Password, wait 30 seconds, then tap 'Tap to Clock In' again.`,
        };
      }

      return {
        success: false,
        method: 'BIOMETRIC',
        errorTitle: `Verify ${capabilities.biometricLabel}`,
        error: `Physical presence verification is required to clock in.`,
        instruction: `Tap 'Tap to Clock In' again and complete the biometric scan to confirm you are on-premise.`,
      };
    }

    // Case 2: Phone has biometric sensor hardware, but user hasn't enrolled any fingerprints
    if (capabilities.hasHardware && !capabilities.isEnrolled) {
      return {
        success: false,
        method: 'BIOMETRIC',
        errorTitle: `${capabilities.biometricLabel} Setup Required`,
        error: `Your phone has a ${capabilities.biometricLabel.toLowerCase()} sensor, but no biometric profiles are registered in your device settings.`,
        instruction: `Go to your Phone Settings > Security & Biometrics, register your ${capabilities.biometricLabel.toLowerCase()}, then return here to clock in.`,
        needsSetup: true,
      };
    }

    // Case 3: Phone physically lacks biometric scanner -> Fallback to device PIN / Pattern
    const fallbackResult = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Confirm attendance with device PIN / Password',
      cancelLabel: 'Cancel',
      disableDeviceFallback: false,
    });

    if (fallbackResult.success) {
      return {
        success: true,
        method: 'DEVICE_PASSCODE',
      };
    }

    if (fallbackResult.error === 'user_cancel' || fallbackResult.error === 'system_cancel') {
      return {
        success: false,
        method: 'DEVICE_PASSCODE',
        errorTitle: 'Device PIN Verification Required',
        error: 'Screen lock verification is required to confirm attendance.',
        instruction: "Tap 'Tap to Clock In' again and enter your phone screen lock PIN, pattern, or password when prompted.",
      };
    }

    if (fallbackResult.error === 'passcode_not_set' || fallbackResult.error === 'not_enrolled') {
      return {
        success: false,
        method: 'DEVICE_PASSCODE',
        errorTitle: 'Screen Lock Required',
        error: 'Your phone does not have a screen lock or PIN set up.',
        instruction: 'Go to your Phone Settings > Security, set up a Screen Lock (PIN, Pattern, or Password), then return here to clock in.',
        needsSetup: true,
      };
    }

    return {
      success: false,
      method: 'DEVICE_PASSCODE',
      errorTitle: 'Identity Verification Required',
      error: 'Device screen lock verification failed.',
      instruction: "Tap 'Tap to Clock In' again and enter your phone PIN or password to verify attendance.",
    };
  } catch (err: any) {
    console.warn('Biometric authentication error:', err);
    return {
      success: false,
      method: 'DEVICE_PASSCODE',
      errorTitle: 'Security Verification Required',
      error: 'Could not access device biometric sensors.',
      instruction: "Please check your phone's security settings and tap 'Tap to Clock In' again.",
    };
  }
}
