import React, { useRef, useMemo } from 'react';
import { View, StyleSheet, Platform, Text, ActivityIndicator } from 'react-native';
import { WebView } from 'react-native-webview';

interface PresenceMapMobileProps {
  latitude: number;
  longitude: number;
  radiusMeters: number;
  onCoordinatesChange: (lat: number, lng: number) => void;
  height?: number;
}

export const PresenceMapMobile: React.FC<PresenceMapMobileProps> = ({
  latitude,
  longitude,
  radiusMeters,
  onCoordinatesChange,
  height = 280,
}) => {
  const webViewRef = useRef<WebView>(null);

  const initialLat = Number.isFinite(latitude) && latitude !== 0 ? latitude : 4.975;
  const initialLng = Number.isFinite(longitude) && longitude !== 0 ? longitude : 8.3417;

  // HTML content rendering Leaflet with Google Satellite Hybrid Tiles
  const mapHtml = useMemo(() => {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    html, body, #map {
      height: 100%;
      width: 100%;
      margin: 0;
      padding: 0;
      background: #0F172A;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .leaflet-control-zoom {
      border: none !important;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3) !important;
    }
    .leaflet-bar a {
      background-color: #1E293B !important;
      color: #F8FAFC !important;
      border-color: #334155 !important;
    }
    .beacon-pulse {
      width: 22px;
      height: 22px;
      background: #0284C7;
      border: 3px solid #FFFFFF;
      border-radius: 50%;
      box-shadow: 0 0 14px rgba(2, 132, 199, 0.8);
      cursor: grab;
    }
    .beacon-pulse:active {
      cursor: grabbing;
    }
    .layer-toggle {
      position: absolute;
      top: 12px;
      right: 12px;
      z-index: 1000;
      background: rgba(15, 23, 42, 0.85);
      border: 1px solid rgba(255, 255, 255, 0.2);
      color: #38BDF8;
      padding: 6px 12px;
      border-radius: 20px;
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
      backdrop-filter: blur(4px);
    }
  </style>
</head>
<body>
  <div id="map"></div>
  <button id="toggleBtn" class="layer-toggle" onclick="toggleLayer()">🛰️ Satellite</button>

  <script>
    var currentLat = ${initialLat};
    var currentLng = ${initialLng};
    var currentRadius = ${radiusMeters};

    var map = L.map('map', {
      center: [currentLat, currentLng],
      zoom: 18,
      zoomControl: true,
      attributionControl: false
    });

    var satLayer = L.tileLayer('https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', {
      subdomains: ['0', '1', '2', '3'],
      maxZoom: 22
    }).addTo(map);

    var streetLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19
    });

    var isSatellite = true;
    function toggleLayer() {
      if (isSatellite) {
        map.removeLayer(satLayer);
        streetLayer.addTo(map);
        document.getElementById('toggleBtn').innerText = '🗺️ Streets';
        isSatellite = false;
      } else {
        map.removeLayer(streetLayer);
        satLayer.addTo(map);
        document.getElementById('toggleBtn').innerText = '🛰️ Satellite';
        isSatellite = true;
      }
    }

    var beaconIcon = L.divIcon({
      className: '',
      html: '<div class="beacon-pulse"></div>',
      iconSize: [22, 22],
      iconAnchor: [11, 11]
    });

    var marker = L.marker([currentLat, currentLng], {
      icon: beaconIcon,
      draggable: true
    }).addTo(map);

    var circle = L.circle([currentLat, currentLng], {
      radius: currentRadius,
      color: '#38BDF8',
      weight: 2,
      fillColor: '#0284C7',
      fillOpacity: 0.22,
      dashArray: '4, 6'
    }).addTo(map);

    function notifyCoordinates(lat, lng) {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'COORDINATES_CHANGED',
          latitude: parseFloat(lat.toFixed(6)),
          longitude: parseFloat(lng.toFixed(6))
        }));
      }
    }

    marker.on('dragend', function(e) {
      var pos = marker.getLatLng();
      circle.setLatLng(pos);
      notifyCoordinates(pos.lat, pos.lng);
    });

    map.on('click', function(e) {
      marker.setLatLng(e.latlng);
      circle.setLatLng(e.latlng);
      notifyCoordinates(e.latlng.lat, e.latlng.lng);
    });

    // Listen to messages from React Native parent
    window.updatePosition = function(lat, lng, radius) {
      if (lat && lng) {
        marker.setLatLng([lat, lng]);
        circle.setLatLng([lat, lng]);
        if (typeof map.flyTo === 'function') {
          map.flyTo([lat, lng], 18, { duration: 1.2 });
        } else {
          map.panTo([lat, lng]);
        }
      }
      if (radius) {
        circle.setRadius(radius);
      }
    };
  </script>
</body>
</html>
    `;
  }, [initialLat, initialLng]);

  // Handle messages received from the WebView
  const handleMessage = (event: any) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === 'COORDINATES_CHANGED') {
        onCoordinatesChange(data.latitude, data.longitude);
      }
    } catch {
      // ignore parsing errors
    }
  };

  // Sync radius changes to WebView
  React.useEffect(() => {
    if (webViewRef.current) {
      const js = `if (window.updatePosition) { window.updatePosition(${latitude}, ${longitude}, ${radiusMeters}); } true;`;
      webViewRef.current.injectJavaScript(js);
    }
  }, [latitude, longitude, radiusMeters]);

  if (Platform.OS === 'web') {
    return (
      <View style={[styles.container, { height }]}>
        <iframe
          title="Presence Map"
          srcDoc={mapHtml}
          style={{ width: '100%', height: '100%', border: 'none', borderRadius: 12 }}
        />
      </View>
    );
  }

  return (
    <View style={[styles.container, { height }]}>
      <WebView
        ref={webViewRef}
        originWhitelist={['*']}
        source={{ html: mapHtml }}
        onMessage={handleMessage}
        javaScriptEnabled
        domStorageEnabled
        scrollEnabled={false}
        nestedScrollEnabled={false}
        style={styles.webView}
        startInLoadingState
        renderLoading={() => (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="small" color="#38BDF8" />
            <Text style={styles.loadingText}>Loading Satellite Map...</Text>
          </View>
        )}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    width: '100%',
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: '#0F172A',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
  },
  webView: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  loadingContainer: {
    ...StyleSheet.absoluteFill,
    backgroundColor: '#0F172A',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  loadingText: {
    color: '#94A3B8',
    fontSize: 12,
  },
});
