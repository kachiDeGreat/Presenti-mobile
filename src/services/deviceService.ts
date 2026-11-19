import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Device from 'expo-device';

const STORAGE_KEY_DEVICE_ID = '@sanctuary_device_fingerprint';

function deterministicHardwareHash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

export function getHardwarePrefix(deviceId?: string): string {
  const clean = (deviceId || '').trim().toUpperCase();
  if (!clean || clean === 'UNBOUND') return '';
  const parts = clean.split('-');
  if (parts.length >= 2) {
    return `${parts[0]}-${parts[1]}`;
  }
  return clean;
}

/**
 * Checks if two device IDs belong to the same physical phone hardware
 * (including across APK reinstalls where an older build used a random 8-char suffix).
 */
export function isSamePhysicalPhone(boundDeviceId?: string, currentDeviceId?: string): boolean {
  const a = (boundDeviceId || '').trim().toUpperCase();
  const b = (currentDeviceId || '').trim().toUpperCase();
  if (!a || !b || a === 'UNBOUND' || b === 'UNBOUND') return false;
  if (a === b) return true;
  const prefixA = getHardwarePrefix(a);
  const prefixB = getHardwarePrefix(b);
  return Boolean(prefixA && prefixB && prefixA === prefixB);
}

export async function adoptDeviceFingerprint(deviceId: string): Promise<void> {
  if (!deviceId || deviceId === 'UNBOUND') return;
  try {
    await AsyncStorage.setItem(STORAGE_KEY_DEVICE_ID, deviceId);
  } catch {}
}

export async function getDeviceFingerprint(): Promise<string> {
  try {
    const stored = await AsyncStorage.getItem(STORAGE_KEY_DEVICE_ID);
    if (stored) {
      return stored;
    }

    const brand = (Device.brand || 'PHONE').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    const model = (Device.modelName || 'DEVICE').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    const hwSignature = [
      brand,
      model,
      Device.modelId || '',
      Device.designName || '',
      Device.productName || '',
      String(Device.totalMemory || ''),
      Device.osInternalBuildId || Device.osBuildId || '',
    ].join('|');
    const hwHash = deterministicHardwareHash(hwSignature);

    const generatedId = `${brand}-${model}-${hwHash}`;
    await AsyncStorage.setItem(STORAGE_KEY_DEVICE_ID, generatedId);
    return generatedId;
  } catch (error) {
    console.warn('Failed to read device fingerprint:', error);
    return 'PHONE-DEVICE-00000000';
  }
}
