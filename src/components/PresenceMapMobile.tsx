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
      background: #142748;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .leaflet-control-zoom {
      border: 1px solid #e5e7eb !important;
      border-radius: 0 !important;
      box-shadow: none !important;
    }
    .leaflet-bar a {
      background-color: #142748 !important;
      color: #f2f1ee !important;
      border-color: rgba(255, 255, 255, 0.2) !important;
      border-radius: 0 !important;
    }
    .beacon-pulse {
      width: 20px;
      height: 20px;
      background: #142748;
      border: 3px solid #ffffff;
      border-radius: 50%;
      box-shadow: 0 0 12px rgba(20, 39, 72, 0.8);
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
      background: #142748;
      border: 1px solid rgba(255, 255, 255, 0.3);
      color: #f2f1ee;
      padding: 6px 10px;
      border-radius: 0;
      font-size: 10px;
      font-weight: 700;
      font-family: ui-monospace, monospace;
      letter-spacing: 0.6px;
      text-transform: uppercase;
      cursor: pointer;
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
      color: '#142748',
      weight: 2,
      fillColor: '#142748',
      fillOpacity: 0.15,
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
          style={{ width: '100%', height: '100%', border: 'none', borderRadius: 0 }}
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
            <ActivityIndicator size="small" color="#142748" />
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
    borderRadius: 0,
    overflow: 'hidden',
    backgroundColor: '#142748',
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  webView: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  loadingContainer: {
    ...StyleSheet.absoluteFill,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  loadingText: {
    color: '#52525b',
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'ui-monospace' : 'monospace',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
});
