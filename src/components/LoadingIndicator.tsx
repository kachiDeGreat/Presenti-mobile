import React from 'react';
import { View, Text, ActivityIndicator, StyleSheet, Modal, Image } from 'react-native';

const APP_ICON = require('../image/app-icon.png');

interface LoadingIndicatorProps {
  message?: string;
  size?: 'small' | 'large';
  color?: string;
  overlay?: boolean;
  fullScreen?: boolean;
}

export const LoadingIndicator: React.FC<LoadingIndicatorProps> = ({
  message,
  size = 'large',
  color = '#2563EB',
  overlay = false,
  fullScreen = false,
}) => {
  if (overlay) {
    return (
      <Modal transparent animationType="fade" visible statusBarTranslucent>
        <View style={styles.overlayBackdrop}>
          <View style={styles.card}>
            <ActivityIndicator size={size} color={color} />
            {message ? <Text style={styles.messageText}>{message}</Text> : null}
          </View>
        </View>
      </Modal>
    );
  }

  if (fullScreen) {
    return (
      <View style={styles.fullScreenContainer}>
        <Image source={APP_ICON} style={styles.splashIcon} resizeMode="contain" />
        <View style={styles.inlineCluster}>
          <ActivityIndicator size={size} color={color} />
          {message ? <Text style={styles.messageText}>{message}</Text> : null}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.inlineCluster}>
      <ActivityIndicator size={size} color={color} />
      {message ? <Text style={styles.messageText}>{message}</Text> : null}
    </View>
  );
};

const styles = StyleSheet.create({
  fullScreenContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#0F2042',
    padding: 24,
    gap: 20,
  },
  splashIcon: {
    width: 100,
    height: 100,
    borderRadius: 22,
  },
  inlineCluster: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 16,
  },
  overlayBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    paddingHorizontal: 28,
    paddingVertical: 24,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    minWidth: 180,
    maxWidth: 320,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 16,
    elevation: 8,
  },
  messageText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1E293B',
    textAlign: 'center',
    lineHeight: 20,
  },
});
