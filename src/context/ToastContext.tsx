import React, { createContext, useContext, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Animated,
  TouchableOpacity,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

export type ToastType = 'success' | 'error' | 'info' | 'warn' | 'syncing';

export interface ToastOptions {
  title?: string;
  duration?: number;
}

interface ToastData {
  id: string;
  type: ToastType;
  message: string;
  title?: string;
}

interface ToastContextType {
  show: (type: ToastType, message: string, options?: ToastOptions) => void;
  success: (message: string, options?: ToastOptions) => void;
  error: (message: string, options?: ToastOptions) => void;
  info: (message: string, options?: ToastOptions) => void;
  warn: (message: string, options?: ToastOptions) => void;
  syncing: (message: string, options?: ToastOptions) => void;
  hide: () => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

const THEME_CONFIG: Record<
  ToastType,
  {
    bg: string;
    border: string;
    text: string;
    subtext: string;
    icon: keyof typeof Ionicons.glyphMap;
    iconColor: string;
    defaultTitle: string;
  }
> = {
  success: {
    bg: '#ECFDF5',
    border: '#A7F3D0',
    text: '#065F46',
    subtext: '#047857',
    icon: 'checkmark-circle',
    iconColor: '#059669',
    defaultTitle: 'Success',
  },
  error: {
    bg: '#FEF2F2',
    border: '#FECACA',
    text: '#991B1B',
    subtext: '#B91C1C',
    icon: 'alert-circle',
    iconColor: '#DC2626',
    defaultTitle: 'Error',
  },
  info: {
    bg: '#EFF6FF',
    border: '#BFDBFE',
    text: '#1E40AF',
    subtext: '#2563EB',
    icon: 'information-circle',
    iconColor: '#2563EB',
    defaultTitle: 'Notice',
  },
  warn: {
    bg: '#FFFBEB',
    border: '#FDE68A',
    text: '#92400E',
    subtext: '#B45309',
    icon: 'warning',
    iconColor: '#D97706',
    defaultTitle: 'Warning',
  },
  syncing: {
    bg: '#EFF6FF',
    border: '#BFDBFE',
    text: '#1E3A8A',
    subtext: '#2563EB',
    icon: 'sync-outline',
    iconColor: '#2563EB',
    defaultTitle: 'Syncing Attendance',
  },
};

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toast, setToast] = useState<ToastData | null>(null);
  const insets = useSafeAreaInsets();
  const translateY = useRef(new Animated.Value(-120)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hide = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: -120,
        duration: 220,
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 0,
        duration: 180,
        useNativeDriver: true,
      }),
    ]).start(() => {
      setToast(null);
    });
  }, [translateY, opacity]);

  const show = useCallback(
    (type: ToastType, message: string, options?: ToastOptions) => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }

      setToast({
        id: Date.now().toString(),
        type,
        message,
        title: options?.title,
      });

      translateY.setValue(-120);
      opacity.setValue(0);

      Animated.parallel([
        Animated.spring(translateY, {
          toValue: 0,
          friction: 8,
          tension: 40,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();

      const duration =
        options?.duration !== undefined
          ? options.duration
          : type === 'syncing'
          ? 0
          : 3500;
      if (duration > 0) {
        timerRef.current = setTimeout(() => {
          hide();
        }, duration);
      }
    },
    [hide, translateY, opacity]
  );

  const success = useCallback(
    (message: string, options?: ToastOptions) => show('success', message, options),
    [show]
  );
  const error = useCallback(
    (message: string, options?: ToastOptions) => show('error', message, options),
    [show]
  );
  const info = useCallback(
    (message: string, options?: ToastOptions) => show('info', message, options),
    [show]
  );
  const warn = useCallback(
    (message: string, options?: ToastOptions) => show('warn', message, options),
    [show]
  );
  const syncing = useCallback(
    (message: string, options?: ToastOptions) => show('syncing', message, options),
    [show]
  );

  const theme = toast ? THEME_CONFIG[toast.type] : null;
  const topPosition = Math.max(insets.top + 8, 16);

  return (
    <ToastContext.Provider value={{ show, success, error, info, warn, syncing, hide }}>
      {children}
      {toast && theme && (
        <Animated.View
          style={[
            styles.container,
            {
              top: topPosition,
              transform: [{ translateY }],
              opacity,
            },
          ]}
          pointerEvents="box-none"
        >
          <TouchableOpacity
            style={[
              styles.toastCard,
              {
                backgroundColor: theme.bg,
                borderColor: theme.border,
              },
            ]}
            onPress={hide}
            activeOpacity={0.9}
          >
            <View style={styles.iconContainer}>
              {toast.type === 'syncing' ? (
                <ActivityIndicator size="small" color="#2563EB" />
              ) : (
                <Ionicons name={theme.icon} size={24} color={theme.iconColor} />
              )}
            </View>

            <View style={styles.textContainer}>
              <Text style={[styles.title, { color: theme.text }]}>
                {toast.title || theme.defaultTitle}
              </Text>
              <Text style={[styles.message, { color: theme.subtext }]}>
                {toast.message}
              </Text>
            </View>

            <TouchableOpacity onPress={hide} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={18} color={theme.text} style={{ opacity: 0.6 }} />
            </TouchableOpacity>
          </TouchableOpacity>
        </Animated.View>
      )}
    </ToastContext.Provider>
  );
};

export const useToast = () => {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
};

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 16,
    right: 16,
    zIndex: 9999,
    elevation: 10,
    alignItems: 'center',
  },
  toastCard: {
    width: '100%',
    maxWidth: 520,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1.5,
    gap: 12,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 10,
    elevation: 6,
  },
  iconContainer: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  textContainer: {
    flex: 1,
    gap: 2,
  },
  title: {
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  message: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '500',
  },
});
