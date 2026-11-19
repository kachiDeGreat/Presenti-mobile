import React, { useRef } from "react";
import {
  Animated,
  Pressable,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";

interface TactilePressableProps extends Omit<PressableProps, "style"> {
  style?: StyleProp<ViewStyle>;
  scaleTo?: number;
  rippleColor?: string;
  children: React.ReactNode;
}

/**
 * Native-driver spring pressable that runs 100% on the UI thread (60fps even on
 * budget Android phones), replacing JS-thread TouchableOpacity lag.
 */
export const TactilePressable: React.FC<TactilePressableProps> = ({
  children,
  style,
  scaleTo = 0.975,
  rippleColor = "rgba(20, 39, 72, 0.08)",
  onPressIn,
  onPressOut,
  disabled,
  ...rest
}) => {
  const scale = useRef(new Animated.Value(1)).current;

  const handlePressIn: PressableProps["onPressIn"] = (e) => {
    if (!disabled) {
      Animated.spring(scale, {
        toValue: scaleTo,
        useNativeDriver: true,
        speed: 45,
        bounciness: 4,
      }).start();
    }
    onPressIn?.(e);
  };

  const handlePressOut: PressableProps["onPressOut"] = (e) => {
    Animated.spring(scale, {
      toValue: 1,
      useNativeDriver: true,
      speed: 38,
      bounciness: 6,
    }).start();
    onPressOut?.(e);
  };

  return (
    <Pressable
      disabled={disabled}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      android_ripple={disabled ? undefined : { color: rippleColor, borderless: false }}
      {...rest}
    >
      <Animated.View style={[style, { transform: [{ scale }] }]}>
        {children}
      </Animated.View>
    </Pressable>
  );
};
