import React, { useRef } from "react";
import {
  Animated,
  Pressable,
  StyleSheet,
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

  const flat = StyleSheet.flatten(style) || {};
  const {
    flex,
    flexGrow,
    flexShrink,
    flexBasis,
    width,
    minWidth,
    maxWidth,
    alignSelf,
    position,
    top,
    right,
    bottom,
    left,
    zIndex,
    margin,
    marginTop,
    marginBottom,
    marginLeft,
    marginRight,
    marginHorizontal,
    marginVertical,
    ...innerStyle
  } = flat;

  const outerStyle: ViewStyle = {
    ...(flex !== undefined ? { flex } : {}),
    ...(flexGrow !== undefined ? { flexGrow } : {}),
    ...(flexShrink !== undefined ? { flexShrink } : {}),
    ...(flexBasis !== undefined ? { flexBasis } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(minWidth !== undefined ? { minWidth } : {}),
    ...(maxWidth !== undefined ? { maxWidth } : {}),
    ...(alignSelf !== undefined ? { alignSelf } : {}),
    ...(position !== undefined ? { position } : {}),
    ...(top !== undefined ? { top } : {}),
    ...(right !== undefined ? { right } : {}),
    ...(bottom !== undefined ? { bottom } : {}),
    ...(left !== undefined ? { left } : {}),
    ...(zIndex !== undefined ? { zIndex } : {}),
    ...(margin !== undefined ? { margin } : {}),
    ...(marginTop !== undefined ? { marginTop } : {}),
    ...(marginBottom !== undefined ? { marginBottom } : {}),
    ...(marginLeft !== undefined ? { marginLeft } : {}),
    ...(marginRight !== undefined ? { marginRight } : {}),
    ...(marginHorizontal !== undefined ? { marginHorizontal } : {}),
    ...(marginVertical !== undefined ? { marginVertical } : {}),
  };

  return (
    <Pressable
      disabled={disabled}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={outerStyle}
      android_ripple={disabled ? undefined : { color: rippleColor, borderless: false }}
      {...rest}
    >
      <Animated.View
        style={[
          innerStyle,
          flex !== undefined || width !== undefined ? { width: "100%" } : null,
          { transform: [{ scale }] },
        ]}
      >
        {children}
      </Animated.View>
    </Pressable>
  );
};
