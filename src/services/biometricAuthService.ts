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
  error?: string;
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
 * - If phone physically lacks biometric sensor (budget phone) or biometrics not enrolled:
 *   Falls back to phone's secure device PIN / pattern / password.
 */
export async function verifyIdentityForClockIn(): Promise<BiometricAuthResult> {
  try {
    const capabilities = await getBiometricCapabilities();

    // Case 1: Phone has physical biometric hardware AND user has enrolled biometrics
    if (capabilities.hasHardware && capabilities.isEnrolled) {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: `Verify your ${capabilities.biometricLabel} to confirm attendance`,
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

      return {
        success: false,
        method: 'BIOMETRIC',
        error:
          result.error === 'user_cancel'
            ? 'Biometric verification was cancelled.'
            : 'Biometric verification failed. Please scan with your registered finger or face.',
      };
    }

    // Case 2: Phone physically lacks biometric scanner or not enrolled -> Fallback to device PIN / Pattern
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

    return {
      success: false,
      method: 'DEVICE_PASSCODE',
      error:
        fallbackResult.error === 'user_cancel'
          ? 'Identity verification was cancelled.'
          : 'Device passcode verification failed.',
    };
  } catch (err: any) {
    console.warn('Biometric authentication error:', err);
    return {
      success: false,
      method: 'DEVICE_PASSCODE',
      error: err?.message || 'Authentication error occurred.',
    };
  }
}
