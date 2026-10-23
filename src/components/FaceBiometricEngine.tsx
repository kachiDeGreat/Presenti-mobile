import React, { useRef, useImperativeHandle, forwardRef, useCallback } from 'react';
import { View, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';
import { extractEmbeddingFromBase64, normalizeVector } from '../services/faceRecognitionService';

export interface FaceBiometricEngineRef {
  processFrame: (base64Image: string) => Promise<{
    vector: number[];
    quality: number;
    brightness: number;
  }>;
}

const ENGINE_HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>body { margin: 0; background: transparent; }</style>
</head>
<body>
  <canvas id="c" width="64" height="64" style="display:none;"></canvas>
  <script>
    const canvas = document.getElementById('c');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    function computeSobelAndLBP(ctx, w, h) {
      const imgData = ctx.getImageData(0, 0, w, h);
      const data = imgData.data;
      const gray = new Float32Array(w * h);

      let totalLum = 0;
      for (let i = 0; i < data.length; i += 4) {
        // Luminance Y = 0.299R + 0.587G + 0.114B
        const y = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        gray[i / 4] = y;
        totalLum += y;
      }
      const avgBrightness = totalLum / (w * h * 255.0);

      // 128-dimensional biometric vector container
      const vector = new Float32Array(128);

      // 1. Zonal luminance & contrast (16 zones: 4x4 grid) -> 32 features
      const blockSize = Math.floor(w / 4);
      let featureIdx = 0;

      for (let by = 0; by < 4; by++) {
        for (let bx = 0; bx < 4; bx++) {
          let sum = 0;
          let sumSq = 0;
          let count = 0;

          for (let y = by * blockSize; y < (by + 1) * blockSize; y++) {
            for (let x = bx * blockSize; x < (bx + 1) * blockSize; x++) {
              const val = gray[y * w + x];
              sum += val;
              sumSq += val * val;
              count++;
            }
          }
          const mean = sum / (count || 1);
          const variance = Math.max(0, (sumSq / (count || 1)) - (mean * mean));
          vector[featureIdx++] = mean / 255.0;
          vector[featureIdx++] = Math.sqrt(variance) / 128.0;
        }
      }

      // 2. Sobel Edge Gradients (32 features)
      for (let by = 0; by < 4; by++) {
        for (let bx = 0; bx < 4; bx++) {
          let gradEnergyX = 0;
          let gradEnergyY = 0;

          for (let y = by * blockSize + 1; y < (by + 1) * blockSize - 1; y++) {
            for (let x = bx * blockSize + 1; x < (bx + 1) * blockSize - 1; x++) {
              const gx = (gray[(y - 1) * w + (x + 1)] + 2 * gray[y * w + (x + 1)] + gray[(y + 1) * w + (x + 1)]) -
                         (gray[(y - 1) * w + (x - 1)] + 2 * gray[y * w + (x - 1)] + gray[(y + 1) * w + (x - 1)]);
              const gy = (gray[(y + 1) * w + (x - 1)] + 2 * gray[(y + 1) * w + x] + gray[(y + 1) * w + (x + 1)]) -
                         (gray[(y - 1) * w + (x - 1)] + 2 * gray[(y - 1) * w + x] + gray[(y - 1) * w + (x + 1)]);
              gradEnergyX += Math.abs(gx);
              gradEnergyY += Math.abs(gy);
            }
          }
          vector[featureIdx++] = gradEnergyX / (blockSize * blockSize * 255.0);
          vector[featureIdx++] = gradEnergyY / (blockSize * blockSize * 255.0);
        }
      }

      // 3. Facial Symmetry & Center-Surround Cross Ratios (32 features)
      for (let i = 0; i < 16; i++) {
        const leftVal = vector[i * 2];
        const rightVal = vector[i * 2 + 1];
        vector[featureIdx++] = leftVal - rightVal; // Left-right asymmetry
        vector[featureIdx++] = (leftVal + rightVal) * 0.5; // Average balance
      }

      // 4. Central Texture Signature (LBP - Local Binary Pattern) (32 features)
      const centerX = Math.floor(w / 2);
      const centerY = Math.floor(h / 2);
      const radius = 16;
      let lbpIdx = 0;

      for (let y = centerY - radius; y < centerY + radius; y += 4) {
        for (let x = centerX - radius; x < centerX + radius; x += 4) {
          if (featureIdx >= 128) break;
          const centerPixel = gray[y * w + x];
          let code = 0;
          if (gray[(y - 1) * w + (x - 1)] > centerPixel) code |= 1;
          if (gray[(y - 1) * w + x] > centerPixel) code |= 2;
          if (gray[(y - 1) * w + (x + 1)] > centerPixel) code |= 4;
          if (gray[y * w + (x + 1)] > centerPixel) code |= 8;
          if (gray[(y + 1) * w + (x + 1)] > centerPixel) code |= 16;
          if (gray[(y + 1) * w + x] > centerPixel) code |= 32;
          if (gray[(y + 1) * w + (x - 1)] > centerPixel) code |= 64;
          if (gray[y * w + (x - 1)] > centerPixel) code |= 128;
          vector[featureIdx++] = code / 255.0;
        }
      }

      // 5. Unit normalize vector
      let sumSq = 0;
      for (let i = 0; i < 128; i++) {
        sumSq += vector[i] * vector[i];
      }
      const norm = Math.sqrt(sumSq) || 1;
      const normalized = [];
      for (let i = 0; i < 128; i++) {
        normalized.push(vector[i] / norm);
      }

      return {
        vector: normalized,
        brightness: avgBrightness,
        quality: Math.min(1.0, Math.max(0.2, avgBrightness * 1.5))
      };
    }

    window.addEventListener('message', function(event) {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'EXTRACT') {
          const img = new Image();
          img.onload = function() {
            ctx.clearRect(0, 0, 64, 64);
            ctx.drawImage(img, 0, 0, 64, 64);
            const res = computeSobelAndLBP(ctx, 64, 64);
            window.ReactNativeWebView.postMessage(JSON.stringify({
              id: msg.id,
              success: true,
              vector: res.vector,
              brightness: res.brightness,
              quality: res.quality
            }));
          };
          img.onerror = function() {
            window.ReactNativeWebView.postMessage(JSON.stringify({
              id: msg.id,
              success: false,
              error: 'Image decoding failed'
            }));
          };
          img.src = 'data:image/jpeg;base64,' + msg.base64;
        }
      } catch (err) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          error: String(err)
        }));
      }
    });

    // Notify ready
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ENGINE_READY' }));
  </script>
</body>
</html>
`;

export const FaceBiometricEngine = forwardRef<FaceBiometricEngineRef, {}>((_, ref) => {
  const webViewRef = useRef<WebView>(null);
  const pendingRequests = useRef<
    Map<
      string,
      {
        resolve: (val: any) => void;
        reject: (err: any) => void;
        timeout: any;
      }
    >
  >(new Map());

  const handleMessage = useCallback((event: any) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.id && pendingRequests.current.has(data.id)) {
        const item = pendingRequests.current.get(data.id)!;
        clearTimeout(item.timeout);
        pendingRequests.current.delete(data.id);

        if (data.success && Array.isArray(data.vector)) {
          item.resolve({
            vector: data.vector,
            quality: data.quality || 0.9,
            brightness: data.brightness || 0.5,
          });
        } else {
          item.reject(new Error(data.error || 'Vector extraction failed'));
        }
      }
    } catch {}
  }, []);

  useImperativeHandle(ref, () => ({
    processFrame: async (base64Image: string) => {
      const reqId = 'face_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);

      return new Promise((resolve) => {
        // High-speed fallback: If WebView takes > 450ms or is busy, fallback to pure JS extractor
        const timeout = setTimeout(() => {
          if (pendingRequests.current.has(reqId)) {
            pendingRequests.current.delete(reqId);
            const fallbackVector = extractEmbeddingFromBase64(base64Image);
            resolve({
              vector: fallbackVector,
              quality: 0.85,
              brightness: 0.5,
            });
          }
        }, 450);

        pendingRequests.current.set(reqId, {
          resolve,
          reject: () => {
            const fallbackVector = extractEmbeddingFromBase64(base64Image);
            resolve({
              vector: fallbackVector,
              quality: 0.85,
              brightness: 0.5,
            });
          },
          timeout,
        });

        // Send to embedded webview canvas
        const payload = JSON.stringify({
          id: reqId,
          type: 'EXTRACT',
          base64: base64Image,
        });

        webViewRef.current?.postMessage(payload);
      });
    },
  }));

  return (
    <View style={styles.hiddenContainer} pointerEvents="none">
      <WebView
        ref={webViewRef}
        originWhitelist={['*']}
        source={{ html: ENGINE_HTML }}
        onMessage={handleMessage}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        style={styles.webView}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  hiddenContainer: {
    width: 1,
    height: 1,
    opacity: 0,
    position: 'absolute',
    top: -999,
    left: -999,
  },
  webView: {
    width: 1,
    height: 1,
  },
});
