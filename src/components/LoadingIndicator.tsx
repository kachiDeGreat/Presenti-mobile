import React from 'react';
import { View, Text, ActivityIndicator, StyleSheet, Modal, Image } from 'react-native';
import { C, R, S, T, shadow } from '../constants/premium';

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
    backgroundColor: C.canvas,
    padding: S.xl,
    gap: S.lg,
  },
  splashIcon: {
    width: 84,
    height: 84,
    borderRadius: R.xl,
  },
  inlineCluster: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: S.sm,
    padding: S.md,
  },
  overlayBackdrop: {
    flex: 1,
    backgroundColor: C.overlay,
    justifyContent: 'center',
    alignItems: 'center',
    padding: S.xl,
  },
  card: {
    backgroundColor: C.card,
    borderRadius: R.lg,
    paddingHorizontal: 28,
    paddingVertical: 24,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    minWidth: 190,
    maxWidth: 320,
    ...shadow.raised,
  },
  messageText: {
    ...T.caption,
    fontWeight: '600',
    color: C.ink,
    textAlign: 'center',
  },
});
