import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Device from 'expo-device';

const STORAGE_KEY_DEVICE_ID = '@sanctuary_device_fingerprint';

function generateEntropy(length: number = 8): string {
  const chars = '0123456789ABCDEF';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export async function getDeviceFingerprint(): Promise<string> {
  try {
    const stored = await AsyncStorage.getItem(STORAGE_KEY_DEVICE_ID);
    if (stored) {
      return stored;
    }

    const brand = (Device.brand || 'PHONE').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    const model = (Device.modelName || 'DEVICE').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    const entropy = generateEntropy(8);

    const generatedId = brand + '-' + model + '-' + entropy;
    await AsyncStorage.setItem(STORAGE_KEY_DEVICE_ID, generatedId);
    return generatedId;
  } catch (error) {
    console.warn('Failed to read device fingerprint:', error);
    return 'DEVICE-' + generateEntropy(8);
  }
}
