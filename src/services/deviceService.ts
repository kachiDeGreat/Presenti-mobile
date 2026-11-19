import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import * as Device from 'expo-device';

const STORAGE_KEY_DEVICE_ID = '@sanctuary_device_fingerprint';

function deterministicHash(input: string): string {
  let h1 = 2166136261;
  let h2 = 3735928559;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 ^= ch;
    h1 = Math.imul(h1, 16777619);
    h2 ^= ch + i;
    h2 = Math.imul(h2, 2246822519);
  }
  const p1 = (h1 >>> 0).toString(16).toUpperCase().padStart(8, '0');
  const p2 = (h2 >>> 0).toString(16).toUpperCase().padStart(8, '0');
  return `${p1}${p2}`.slice(0, 12);
}

/**
 * Generates a deterministic hardware fingerprint that SURVIVES Android "Clear App Data"
 * and app reinstalls, so clearing local storage cannot bypass the 1-Worker-1-Phone lock.
 */
export async function getDeviceFingerprint(): Promise<string> {
  try {
    const brand = (Device.brand || 'PHONE').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    const model = (Device.modelName || 'DEVICE').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();

    const platformConsts = (Platform.constants || {}) as Record<string, any>;
    const hwSignature = [
      Platform.OS,
      brand,
      (Device.manufacturer || '').toUpperCase(),
      model,
      Device.modelId || '',
      Device.designName || '',
      Device.productName || '',
      Device.deviceName || '',
      String(Device.totalMemory || ''),
      Device.osBuildFingerprint || platformConsts.Fingerprint || '',
      Device.osInternalBuildId || '',
      Device.osBuildId || '',
    ].join('|');

    const hwHash = deterministicHash(hwSignature);
    const generatedId = `${brand}-${model}-${hwHash}`;

    await AsyncStorage.setItem(STORAGE_KEY_DEVICE_ID, generatedId).catch(() => {});
    return generatedId;
  } catch (error) {
    console.warn('Failed to read device fingerprint:', error);
    const cached = await AsyncStorage.getItem(STORAGE_KEY_DEVICE_ID).catch(() => null);
    return cached || 'PHONE-DEVICE-000000000000';
  }
}
