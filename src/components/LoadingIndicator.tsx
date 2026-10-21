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
  color = '#142748',
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
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f2f1ee',
    padding: 24,
    gap: 20,
  },
  splashIcon: {
    width: 90,
    height: 90,
    borderRadius: 0,
  },
  inlineCluster: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 16,
  },
  overlayBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(20, 39, 72, 0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 0,
    paddingHorizontal: 28,
    paddingVertical: 24,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    minWidth: 180,
    maxWidth: 320,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    elevation: 0,
    shadowOpacity: 0,
  },
  messageText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#142748',
    textAlign: 'center',
    lineHeight: 18,
    letterSpacing: -0.1,
  },
});
