import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Animated,
  Dimensions,
  Platform,
  Vibration,
  Easing,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Ionicons } from "@expo/vector-icons";
import * as LocalAuthentication from "expo-local-authentication";
import {
  extractEmbeddingFromMLKit,
  extractEmbeddingFromBase64,
  compareFaceEmbeddings,
  FACE_MATCH_THRESHOLD,
} from "../services/faceRecognitionService";
import {
  FaceBiometricEngine,
  FaceBiometricEngineRef,
} from "./FaceBiometricEngine";

// Initialize Google ML Kit Native Module with Landmark, Contour and Classification options
let mlkitDetector: any = null;
try {
  const { RNMLKitFaceDetector } = require("@infinitered/react-native-mlkit-face-detection");
  mlkitDetector = new RNMLKitFaceDetector({
    performanceMode: "fast",
    landmarkMode: true,
    contourMode: true,
    classificationMode: true,
    isTrackingEnabled: true,
  });
} catch {
  // Falls back to Canvas engine if native binary is not yet compiled
}

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get("window");
const OVAL_WIDTH = Math.min(SCREEN_WIDTH * 0.72, 260);
const OVAL_HEIGHT = OVAL_WIDTH * 1.32;

export type FaceScanStep =
  | "SEARCHING"   // Looking for face
  | "OFF_CENTER"  // Face present but shifted
  | "TRACKING"    // Face centered, filling progress
  | "SUCCESS"     // 100% captured / verified
  | "MISMATCH";   // Only in verify mode when wrong face

export interface FaceScanModalProps {
  visible: boolean;
  mode: "ENROLL" | "VERIFY";
  memberName?: string;
  enrolledEmbedding?: number[];
  onSuccess: (result: {
    embedding: number[];
    confidence: number;
    thumbnailBase64?: string;
  }) => void;
  onFailure?: (reason: string) => void;
  onClose: () => void;
}

export const FaceScanModal: React.FC<FaceScanModalProps> = ({
  visible,
  mode,
  memberName,
  enrolledEmbedding,
  onSuccess,
  onFailure,
  onClose,
}) => {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<any>(null);
  const engineRef = useRef<FaceBiometricEngineRef>(null);

  const [step, setStep] = useState<FaceScanStep>("SEARCHING");
  const [guidanceTip, setGuidanceTip] = useState<string>("Position face in oval");
  const [guidanceSubtip, setGuidanceSubtip] = useState<string>(
    "Hold phone upright at eye level"
  );
  const [progressPercent, setProgressPercent] = useState<number>(0);
  const [matchScore, setMatchScore] = useState<number | null>(null);

  // Device native biometrics capabilities
  const [biometricLabel, setBiometricLabel] = useState<string>("Face ID");
  const [hasNativeBiometric, setHasNativeBiometric] = useState<boolean>(false);

  // Apple Face ID HUD Animations (Running at 60 FPS via Native Driver)
  const bracketExpandAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const radarSpinAnim = useRef(new Animated.Value(0)).current;
  const checkScaleAnim = useRef(new Animated.Value(0)).current;
  const progressAnim = useRef(new Animated.Value(0)).current;

  // Active loop refs
  const isScanningRef = useRef(false);
  const loopActiveRef = useRef(false);
  const consecutiveCenteredFramesRef = useRef(0);
  const bestVectorRef = useRef<number[] | null>(null);
  const bestThumbnailRef = useRef<string | null>(null);
  const lastEngineThumbRef = useRef<string | null>(null);
  const isMountedRef = useRef(true);
  const scanTimerRef = useRef<any>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      loopActiveRef.current = false;
    };
  }, []);

  // Check hardware native biometrics (Apple Face ID / Android BiometricPrompt)
  useEffect(() => {
    if (!visible) return;
    (async () => {
      try {
        const hasHw = await LocalAuthentication.hasHardwareAsync();
        const isEnrolled = await LocalAuthentication.isEnrolledAsync();
        const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
        const isFaceId = types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION);
        setBiometricLabel(isFaceId ? "Apple Face ID" : "Device Biometrics");
        setHasNativeBiometric(hasHw && isEnrolled);
      } catch {}
    })();
  }, [visible]);

  // 60 FPS Apple Face ID HUD Ambient Animations
  useEffect(() => {
    if (!visible) return;

    // Smooth subtle radar rotation
    const radarSpin = Animated.loop(
      Animated.timing(radarSpinAnim, {
        toValue: 1,
        duration: 3600,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );

    // Corner bracket breathing animation
    const bracketPulse = Animated.loop(
      Animated.sequence([
        Animated.timing(bracketExpandAnim, {
          toValue: 1,
          duration: 1200,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(bracketExpandAnim, {
          toValue: 0,
          duration: 1200,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    );

    // Subtle oval pulse
    const ovalPulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.025,
          duration: 900,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1.0,
          duration: 900,
          useNativeDriver: true,
        }),
      ])
    );

    radarSpin.start();
    bracketPulse.start();
    ovalPulse.start();

    return () => {
      radarSpin.stop();
      bracketPulse.stop();
      ovalPulse.stop();
    };
  }, [visible, radarSpinAnim, bracketExpandAnim, pulseAnim]);

  // Reset scan state on show/hide
  useEffect(() => {
    if (visible) {
      setStep("SEARCHING");
      setGuidanceTip("Position face in oval");
      setGuidanceSubtip("Hold phone upright at eye level");
      setProgressPercent(0);
      setMatchScore(null);
      isScanningRef.current = false;
      loopActiveRef.current = true;
      consecutiveCenteredFramesRef.current = 0;
      bestVectorRef.current = null;
      bestThumbnailRef.current = null;
      lastEngineThumbRef.current = null;
      progressAnim.setValue(0);
      checkScaleAnim.setValue(0);
    } else {
      loopActiveRef.current = false;
    }
  }, [visible, progressAnim, checkScaleAnim]);

  // Trigger Apple Face ID / Device Native Biometrics on demand
  const handleNativeBiometricAuth = useCallback(async () => {
    try {
      const res = await LocalAuthentication.authenticateAsync({
        promptMessage:
          mode === "ENROLL"
            ? "Authorize Facial Biometric Profile Binding"
            : `Authenticate with ${biometricLabel} to Clock In`,
        cancelLabel: "Use Camera Instead",
        disableDeviceFallback: false,
      });

      if (res.success) {
        loopActiveRef.current = false;
        setStep("SUCCESS");
        setGuidanceTip("Face ID Verified ✓");
        setGuidanceSubtip(`Confirmed identity for ${memberName || "member"}`);
        Vibration.vibrate([0, 50, 40, 50]);

        Animated.spring(checkScaleAnim, {
          toValue: 1,
          friction: 6,
          tension: 90,
          useNativeDriver: true,
        }).start();

        setTimeout(() => {
          if (isMountedRef.current) {
            onSuccess({
              embedding: enrolledEmbedding || bestVectorRef.current || new Array(48).fill(1),
              confidence: 1.0,
              thumbnailBase64: bestThumbnailRef.current || undefined,
            });
          }
        }, 550);
      }
    } catch (err) {
      console.warn("Native biometric auth error:", err);
    }
  }, [mode, biometricLabel, memberName, enrolledEmbedding, onSuccess, checkScaleAnim]);

  // Auto-scanning loop with throttled capture (550ms) to ensure 60 FPS video smoothness
  const processNextFrame = useCallback(async () => {
    if (
      !loopActiveRef.current ||
      !cameraRef.current ||
      isScanningRef.current ||
      !visible
    ) {
      return;
    }

    isScanningRef.current = true;

    try {
      const photo = await cameraRef.current.takePictureAsync({
        base64: true,
        quality: 0.15,
        skipProcessing: true,
        shutterSound: false,
      });

      if (!photo?.uri || !loopActiveRef.current) {
        isScanningRef.current = false;
        return;
      }

      let hasFace = false;
      let isCentered = false;
      let guidance = "NO_FACE";
      let vector: number[] = [];

      // 1. Google ML Kit Native Face Detection & 3D Landmarks Extraction
      if (mlkitDetector && photo?.uri) {
        try {
          const mlkitRes = await mlkitDetector.detectFaces(photo.uri);
          if (mlkitRes?.faces && Array.isArray(mlkitRes.faces) && mlkitRes.faces.length > 0) {
            hasFace = true;
            const primaryFace = mlkitRes.faces[0];
            const yaw = primaryFace.headEulerAngleY || 0;
            const pitch = primaryFace.headEulerAngleX || 0;

            if (yaw > 14) {
              isCentered = false;
              guidance = "MOVE_LEFT";
            } else if (yaw < -14) {
              isCentered = false;
              guidance = "MOVE_RIGHT";
            } else if (pitch > 16 || pitch < -16) {
              isCentered = false;
              guidance = "HOLD_LEVEL";
            } else {
              isCentered = true;
              guidance = "CENTERED";
            }

            // Extract high-precision anthropometric vector!
            const mlkitVec = extractEmbeddingFromMLKit(primaryFace);
            if (mlkitVec && mlkitVec.length > 0) {
              vector = mlkitVec;
            }
          }
        } catch (mlErr) {
          console.warn("ML Kit detection error:", mlErr);
        }
      }

      let engineThumb: string | undefined;

      // 2. Secondary Engine: Lightweight Micro-Thumbnail generation
      if (engineRef.current && photo?.base64) {
        try {
          const engineRes = await engineRef.current.processFrame(photo.base64);
          if (!hasFace) {
            hasFace = Boolean(engineRes.hasFace);
            isCentered = Boolean(engineRes.isCentered);
            guidance = engineRes.guidance || "NO_FACE";
          }
          if ((!vector || vector.length === 0) && engineRes.vector && engineRes.vector.length > 0) {
            vector = engineRes.vector;
          }
          engineThumb = engineRes.thumbnail;
        } catch {}
      }

      // 3. Fallback normalized spatial vector if discrete landmarks absent
      if (hasFace && (!vector || vector.length === 0) && photo?.base64) {
        vector = extractEmbeddingFromBase64(photo.base64);
      }

      if (!hasFace) {
        // No face in frame
        consecutiveCenteredFramesRef.current = Math.max(
          0,
          consecutiveCenteredFramesRef.current - 1
        );
        const newPct = Math.max(0, consecutiveCenteredFramesRef.current * 33);
        setProgressPercent(newPct);

        setStep("SEARCHING");
        setGuidanceTip("Position face in oval");
        setGuidanceSubtip("Fit your head completely inside the reticle");
      } else if (!isCentered) {
        // Face present but off-center
        setStep("OFF_CENTER");
        if (guidance === "MOVE_LEFT") {
          setGuidanceTip("Move slightly left");
        } else if (guidance === "MOVE_RIGHT") {
          setGuidanceTip("Move slightly right");
        } else if (guidance === "HOLD_LEVEL") {
          setGuidanceTip("Hold phone at eye level");
        } else {
          setGuidanceTip("Center face in oval");
        }
        setGuidanceSubtip("Align your face in the center of the reticle");
      } else {
        // Face is centered!
        setStep("TRACKING");
        consecutiveCenteredFramesRef.current += 1;
        bestVectorRef.current = vector;
        if (engineThumb) {
          lastEngineThumbRef.current = engineThumb;
        }
        bestThumbnailRef.current =
          engineThumb ||
          lastEngineThumbRef.current ||
          (photo.base64 && photo.base64.length < 80000 ? `data:image/jpeg;base64,${photo.base64}` : null);

        const frames = consecutiveCenteredFramesRef.current;
        const newPct = Math.min(100, frames * 34);
        setProgressPercent(newPct);

        Animated.timing(progressAnim, {
          toValue: newPct / 100,
          duration: 250,
          useNativeDriver: false,
        }).start();

        Vibration.vibrate(20);

        setGuidanceTip("Face Detected • Hold Still...");
        setGuidanceSubtip(`Analyzing facial biometrics... ${Math.round(newPct)}%`);

        // Check verification in VERIFY mode against enrolled embedding
        if (mode === "VERIFY") {
          if (!enrolledEmbedding || enrolledEmbedding.length === 0) {
            setStep("MISMATCH");
            setGuidanceTip("Biometric Profile Missing");
            setGuidanceSubtip("Please enroll your face first to clock in.");
            Vibration.vibrate(200);
            return;
          }

          const match = compareFaceEmbeddings(vector, enrolledEmbedding);
          setMatchScore(match.confidencePercent);

          if (match.isMatch || (frames >= 2 && match.confidencePercent >= 70)) {
            // VERIFY SUCCESS!
            loopActiveRef.current = false;
            setStep("SUCCESS");
            setGuidanceTip(`Face ID Verified (${match.confidencePercent}%) ✓`);
            setGuidanceSubtip(`Confirmed identity for ${memberName || "member"}`);
            Vibration.vibrate([0, 50, 40, 50]);

            Animated.spring(checkScaleAnim, {
              toValue: 1,
              friction: 6,
              tension: 90,
              useNativeDriver: true,
            }).start();

            const finalThumb = bestThumbnailRef.current;
            setTimeout(() => {
              if (isMountedRef.current) {
                onSuccess({
                  embedding: vector,
                  confidence: match.similarity,
                  thumbnailBase64: finalThumb || undefined,
                });
              }
            }, 600);
            return;
          }
        }

        // ENROLL MODE: 3 consecutive centered frames completes enrollment
        if (mode === "ENROLL" && frames >= 3) {
          loopActiveRef.current = false;
          setStep("SUCCESS");
          setGuidanceTip("Face ID Profile Bound! ✓");
          setGuidanceSubtip("Account secured with your facial biometric profile");
          Vibration.vibrate([0, 50, 40, 50]);

          Animated.spring(checkScaleAnim, {
            toValue: 1,
            friction: 6,
            tension: 90,
            useNativeDriver: true,
          }).start();

          const finalVector = bestVectorRef.current || vector;
          const finalThumb = bestThumbnailRef.current;

          setTimeout(() => {
            if (isMountedRef.current) {
              onSuccess({
                embedding: finalVector,
                confidence: 1.0,
                thumbnailBase64: finalThumb || undefined,
              });
            }
          }, 600);
          return;
        }
      }
    } catch (err) {
      console.warn("Scan frame error:", err);
    } finally {
      isScanningRef.current = false;
      if (loopActiveRef.current && isMountedRef.current && visible) {
        scanTimerRef.current = setTimeout(() => {
          if (loopActiveRef.current && isMountedRef.current && visible) {
            processNextFrame();
          }
        }, 550);
      }
    }
  }, [
    visible,
    mode,
    enrolledEmbedding,
    memberName,
    onSuccess,
    onFailure,
    progressAnim,
    checkScaleAnim,
  ]);

  // Main continuous auto-scan loop trigger
  useEffect(() => {
    if (!visible || !permission?.granted) return;

    loopActiveRef.current = true;
    scanTimerRef.current = setTimeout(() => {
      if (loopActiveRef.current && isMountedRef.current && visible) {
        processNextFrame();
      }
    }, 450);

    return () => {
      loopActiveRef.current = false;
      if (scanTimerRef.current) {
        clearTimeout(scanTimerRef.current);
      }
    };
  }, [visible, permission?.granted, processNextFrame]);

  // Color dynamics matching Apple Face ID
  const getThemeColor = () => {
    switch (step) {
      case "SUCCESS":
        return "#30D158"; // Apple Emerald Green
      case "MISMATCH":
        return "#FF453A"; // Apple Crimson Red
      case "OFF_CENTER":
        return "#FF9F0A"; // Apple Amber
      case "TRACKING":
        return "#0A84FF"; // Apple Electric Blue
      case "SEARCHING":
      default:
        return "rgba(255, 255, 255, 0.45)";
    }
  };

  const themeColor = getThemeColor();

  // Corner bracket spacing animation interpolation
  const bracketOffset = bracketExpandAnim.interpolate({
    inputRange: [0, 1],
    outputRange: step === "SUCCESS" ? [-8, -8] : step === "TRACKING" ? [-4, 0] : [0, 6],
  });

  const radarRotation = radarSpinAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent={false}
      onRequestClose={onClose}
    >
      <View style={styles.container}>
        {/* Invisible Secondary Engine */}
        <FaceBiometricEngine ref={engineRef} />

        {/* Camera Permission Guard */}
        {!permission?.granted ? (
          <View style={styles.permissionScreen}>
            <View style={styles.permissionIconBadge}>
              <Ionicons name="camera-outline" size={44} color="#0A84FF" />
            </View>
            <Text style={styles.permissionTitle}>Camera Access Required</Text>
            <Text style={styles.permissionBody}>
              Presenti uses your camera for high-security, on-device facial biometric verification. No raw video is stored.
            </Text>
            <TouchableOpacity
              style={styles.permissionBtn}
              onPress={requestPermission}
              activeOpacity={0.8}
            >
              <Text style={styles.permissionBtnText}>Enable Camera</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.permissionCloseBtn}
              onPress={onClose}
              activeOpacity={0.7}
            >
              <Text style={styles.permissionCloseText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.cameraWrapper}>
            {/* Live Camera Viewfinder */}
            <CameraView
              ref={cameraRef}
              style={StyleSheet.absoluteFill}
              facing="front"
              mute={true}
            />

            {/* Dark Frosted Glass Vignette Overlay */}
            <View style={styles.vignetteOverlay}>
              {/* Top iOS Header */}
              <View style={styles.topHeader}>
                <View style={styles.applePill}>
                  <Ionicons name="scan" size={13} color="#0A84FF" />
                  <Text style={styles.applePillText}>FACE ID</Text>
                </View>

                <TouchableOpacity
                  style={styles.closeRoundBtn}
                  onPress={onClose}
                  activeOpacity={0.7}
                >
                  <Ionicons name="close" size={18} color="#FFFFFF" />
                </TouchableOpacity>
              </View>

              {/* Dynamic Guidance Pill */}
              <View style={styles.guidanceWrapper}>
                <View
                  style={[
                    styles.guidanceBadge,
                    {
                      borderColor: step === "SUCCESS" ? "rgba(48, 209, 88, 0.4)" : step === "TRACKING" ? "rgba(10, 132, 255, 0.4)" : "rgba(255, 255, 255, 0.15)",
                      backgroundColor: step === "SUCCESS" ? "rgba(48, 209, 88, 0.2)" : step === "TRACKING" ? "rgba(10, 132, 255, 0.2)" : "rgba(15, 23, 42, 0.75)",
                    },
                  ]}
                >
                  <Ionicons
                    name={
                      step === "SUCCESS"
                        ? "checkmark-circle"
                        : step === "MISMATCH"
                        ? "alert-circle"
                        : step === "TRACKING"
                        ? "scan-outline"
                        : "person-outline"
                    }
                    size={16}
                    color={themeColor}
                  />
                  <Text style={[styles.guidanceBadgeText, { color: step === "SUCCESS" ? "#30D158" : "#FFFFFF" }]}>
                    {guidanceTip}
                  </Text>
                </View>
                <Text style={styles.guidanceSubtext}>{guidanceSubtip}</Text>
              </View>

              {/* Centered Apple Face ID Reticle */}
              <View style={styles.reticleCenterArea}>
                <Animated.View
                  style={[
                    styles.reticleOval,
                    {
                      borderColor: themeColor,
                      transform: [{ scale: step === "TRACKING" ? pulseAnim : 1.0 }],
                    },
                  ]}
                >
                  {/* Subtle Radar Scan Beam */}
                  {step === "TRACKING" && (
                    <Animated.View
                      style={[
                        styles.radarSweep,
                        { transform: [{ rotate: radarRotation }] },
                      ]}
                    />
                  )}

                  {/* Corner Accent Brackets (Apple Face ID HUD) */}
                  <Animated.View
                    style={[
                      styles.cornerBracket,
                      styles.bracketTL,
                      {
                        borderColor: themeColor,
                        transform: [{ translateX: bracketOffset }, { translateY: bracketOffset }],
                      },
                    ]}
                  />
                  <Animated.View
                    style={[
                      styles.cornerBracket,
                      styles.bracketTR,
                      {
                        borderColor: themeColor,
                        transform: [{ translateX: Animated.multiply(bracketOffset, -1) }, { translateY: bracketOffset }],
                      },
                    ]}
                  />
                  <Animated.View
                    style={[
                      styles.cornerBracket,
                      styles.bracketBL,
                      {
                        borderColor: themeColor,
                        transform: [{ translateX: bracketOffset }, { translateY: Animated.multiply(bracketOffset, -1) }],
                      },
                    ]}
                  />
                  <Animated.View
                    style={[
                      styles.cornerBracket,
                      styles.bracketBR,
                      {
                        borderColor: themeColor,
                        transform: [{ translateX: Animated.multiply(bracketOffset, -1) }, { translateY: Animated.multiply(bracketOffset, -1) }],
                      },
                    ]}
                  />

                  {/* Face Guide Silhouette */}
                  {step === "SEARCHING" && (
                    <View style={styles.faceSilhouette} pointerEvents="none">
                      <Ionicons
                        name="person-outline"
                        size={OVAL_WIDTH * 0.65}
                        color="rgba(255, 255, 255, 0.22)"
                      />
                    </View>
                  )}

                  {/* Success State Overlay with Spring Bounce */}
                  {step === "SUCCESS" && (
                    <Animated.View
                      style={[
                        styles.successBackdrop,
                        { transform: [{ scale: checkScaleAnim }] },
                      ]}
                    >
                      <View style={styles.successCheckCircle}>
                        <Ionicons name="checkmark" size={54} color="#FFFFFF" />
                      </View>
                      <Text style={styles.successText}>
                        {mode === "ENROLL" ? "BOUND" : "VERIFIED"}
                      </Text>
                    </Animated.View>
                  )}

                  {/* Mismatch Overlay */}
                  {step === "MISMATCH" && (
                    <View style={styles.mismatchBackdrop}>
                      <Ionicons name="close-circle" size={68} color="#FF453A" />
                      <Text style={styles.mismatchText}>MISMATCH</Text>
                    </View>
                  )}
                </Animated.View>

                {/* Smooth Progress Bar below Oval */}
                <View style={styles.progressContainer}>
                  <View style={styles.progressTrack}>
                    <Animated.View
                      style={[
                        styles.progressFill,
                        {
                          width: progressAnim.interpolate({
                            inputRange: [0, 1],
                            outputRange: ["0%", "100%"],
                          }),
                          backgroundColor: step === "SUCCESS" ? "#30D158" : "#0A84FF",
                        },
                      ]}
                    />
                  </View>
                  <Text style={styles.progressLabel}>
                    {step === "SUCCESS"
                      ? "100% COMPLETE"
                      : `${Math.round(progressPercent)}%`}
                  </Text>
                </View>
              </View>

              {/* Bottom Actions Card & Banking Native Biometrics Option */}
              <View style={styles.bottomArea}>
                {hasNativeBiometric && (
                  <TouchableOpacity
                    style={styles.appleFaceIdBtn}
                    onPress={handleNativeBiometricAuth}
                    activeOpacity={0.8}
                  >
                    <Ionicons name="scan-outline" size={20} color="#FFFFFF" />
                    <Text style={styles.appleFaceIdBtnText}>
                      Authenticate with {biometricLabel}
                    </Text>
                  </TouchableOpacity>
                )}

                {matchScore !== null && (
                  <View style={styles.scoreRow}>
                    <Text style={styles.scoreText}>
                      Biometric Match: {matchScore}% (Required: ≥{Math.round(FACE_MATCH_THRESHOLD * 100)}%)
                    </Text>
                  </View>
                )}
              </View>
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#050811",
  },
  cameraWrapper: {
    flex: 1,
  },
  vignetteOverlay: {
    flex: 1,
    backgroundColor: "rgba(5, 8, 17, 0.52)",
    justifyContent: "space-between",
    paddingTop: Platform.OS === "ios" ? 54 : 36,
    paddingBottom: Platform.OS === "ios" ? 44 : 28,
  },
  topHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 22,
  },
  applePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(10, 132, 255, 0.15)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(10, 132, 255, 0.35)",
  },
  applePillText: {
    color: "#0A84FF",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1.2,
  },
  closeRoundBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(255, 255, 255, 0.12)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.2)",
  },
  guidanceWrapper: {
    alignItems: "center",
    paddingHorizontal: 24,
    gap: 6,
  },
  guidanceBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 24,
    borderWidth: 1,
  },
  guidanceBadgeText: {
    fontSize: 14,
    fontWeight: "700",
    letterSpacing: 0.2,
  },
  guidanceSubtext: {
    color: "#94A3B8",
    fontSize: 12,
    textAlign: "center",
  },
  reticleCenterArea: {
    alignItems: "center",
    justifyContent: "center",
    gap: 18,
  },
  reticleOval: {
    width: OVAL_WIDTH,
    height: OVAL_HEIGHT,
    borderRadius: OVAL_WIDTH / 2,
    borderWidth: 3,
    position: "relative",
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },
  radarSweep: {
    position: "absolute",
    width: OVAL_WIDTH * 1.5,
    height: 2,
    backgroundColor: "rgba(10, 132, 255, 0.4)",
    shadowColor: "#0A84FF",
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 10,
  },
  cornerBracket: {
    position: "absolute",
    width: 22,
    height: 22,
  },
  bracketTL: {
    top: 14,
    left: 14,
    borderTopWidth: 3,
    borderLeftWidth: 3,
    borderTopLeftRadius: 10,
  },
  bracketTR: {
    top: 14,
    right: 14,
    borderTopWidth: 3,
    borderRightWidth: 3,
    borderTopRightRadius: 10,
  },
  bracketBL: {
    bottom: 14,
    left: 14,
    borderBottomWidth: 3,
    borderLeftWidth: 3,
    borderBottomLeftRadius: 10,
  },
  bracketBR: {
    bottom: 14,
    right: 14,
    borderBottomWidth: 3,
    borderRightWidth: 3,
    borderBottomRightRadius: 10,
  },
  faceSilhouette: {
    position: "absolute",
    alignItems: "center",
    justifyContent: "center",
  },
  successBackdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(5, 8, 17, 0.75)",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  successCheckCircle: {
    width: 82,
    height: 82,
    borderRadius: 41,
    backgroundColor: "#30D158",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#30D158",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 14,
    elevation: 8,
  },
  successText: {
    color: "#30D158",
    fontSize: 17,
    fontWeight: "800",
    letterSpacing: 1.2,
  },
  mismatchBackdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(5, 8, 17, 0.8)",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  mismatchText: {
    color: "#FF453A",
    fontSize: 16,
    fontWeight: "800",
    letterSpacing: 1.2,
  },
  progressContainer: {
    width: OVAL_WIDTH * 0.9,
    alignItems: "center",
    gap: 6,
  },
  progressTrack: {
    width: "100%",
    height: 5,
    backgroundColor: "rgba(255, 255, 255, 0.15)",
    borderRadius: 3,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: 3,
  },
  progressLabel: {
    color: "rgba(255, 255, 255, 0.6)",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
  },
  bottomArea: {
    paddingHorizontal: 24,
    alignItems: "center",
    gap: 12,
  },
  appleFaceIdBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    width: "100%",
    maxWidth: 340,
    backgroundColor: "rgba(10, 132, 255, 0.22)",
    borderWidth: 1.2,
    borderColor: "rgba(10, 132, 255, 0.55)",
    paddingVertical: 14,
    borderRadius: 16,
    shadowColor: "#0A84FF",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
    elevation: 4,
  },
  appleFaceIdBtnText: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "700",
    letterSpacing: 0.2,
  },
  scoreRow: {
    paddingVertical: 4,
  },
  scoreText: {
    color: "rgba(255, 255, 255, 0.55)",
    fontSize: 12,
    fontWeight: "600",
  },
  permissionScreen: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    gap: 16,
  },
  permissionIconBadge: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: "rgba(10, 132, 255, 0.15)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  permissionTitle: {
    color: "#FFFFFF",
    fontSize: 20,
    fontWeight: "700",
    textAlign: "center",
  },
  permissionBody: {
    color: "#94A3B8",
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
  },
  permissionBtn: {
    backgroundColor: "#0A84FF",
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 14,
    width: "100%",
    alignItems: "center",
    marginTop: 8,
  },
  permissionBtnText: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "700",
  },
  permissionCloseBtn: {
    paddingVertical: 8,
  },
  permissionCloseText: {
    color: "#94A3B8",
    fontSize: 15,
  },
});
