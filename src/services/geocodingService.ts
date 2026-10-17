import * as Location from 'expo-location';

/**
 * High-performance Geocoding and Location Search Service for Mobile App.
 * Combines OpenStreetMap Nominatim, Photon (Komoot), and Expo Location
 * for global address, venue, and city search with zero API key requirements.
 */

export interface GeocodedLocation {
  id: string;
  name: string;
  sub: string;
  displayName: string;
  lat: number;
  lng: number;
  category?: string;
  source?: 'nominatim' | 'photon' | 'expo';
}

/**
 * Searches global locations, venues, addresses, and landmarks.
 * Multi-tiered:
 * 1. OpenStreetMap Nominatim (best for Nigerian addresses, roads, cities)
 * 2. Photon (Komoot - fast fuzzy autocomplete)
 * 3. Expo native Location.geocodeAsync (device fallback)
 */
export async function searchGlobalLocations(
  query: string,
  options?: { limit?: number; timeoutMs?: number }
): Promise<GeocodedLocation[]> {
  const clean = query.trim();
  if (clean.length < 2) return [];

  // 1. Check if user typed or pasted raw coordinates or a Google Maps URL
  const parsedCoords = parseCoordinatesOrUrl(clean);
  if (parsedCoords) {
    return [
      {
        id: 'parsed-coord',
        name: `${parsedCoords.lat.toFixed(5)}, ${parsedCoords.lng.toFixed(5)}`,
        sub: 'Pasted Coordinates',
        displayName: `Coordinates: ${parsedCoords.lat.toFixed(6)}, ${parsedCoords.lng.toFixed(6)}`,
        lat: parsedCoords.lat,
        lng: parsedCoords.lng,
        category: 'coordinates',
        source: 'nominatim',
      },
    ];
  }

  const limit = options?.limit || 6;
  const timeoutMs = options?.timeoutMs || 8000;
  const results: GeocodedLocation[] = [];
  const seen = new Set<string>();

  const addLocation = (
    id: string,
    name: string,
    state?: string,
    country?: string,
    district?: string,
    lat?: number,
    lng?: number,
    category?: string,
    source?: 'nominatim' | 'photon' | 'expo'
  ) => {
    if (typeof lat !== 'number' || typeof lng !== 'number' || !name) return;
    if (isNaN(lat) || isNaN(lng)) return;

    let cleanState = state || '';
    if (
      country?.toLowerCase() === 'nigeria' &&
      cleanState &&
      !cleanState.toLowerCase().includes('state') &&
      !cleanState.toLowerCase().includes('fct')
    ) {
      cleanState = `${cleanState} State`;
    }

    const subList: string[] = [];
    if (district && district.toLowerCase() !== name.toLowerCase()) {
      subList.push(district);
    }
    if (cleanState) subList.push(cleanState);
    if (country) subList.push(country);

    const sub = subList.join(', ');
    const displayList = [name];
    if (cleanState && cleanState.toLowerCase() !== name.toLowerCase()) {
      displayList.push(cleanState);
    }
    if (country) displayList.push(country);
    const displayName = displayList.join(', ');

    const coordKey = `${lat.toFixed(3)}_${lng.toFixed(3)}`;
    const textKey = `${name.toLowerCase()}|${cleanState.toLowerCase()}`;
    if (!seen.has(coordKey) && !seen.has(textKey)) {
      seen.add(coordKey);
      seen.add(textKey);
      results.push({
        id,
        name,
        sub,
        displayName,
        lat: Number(lat.toFixed(6)),
        lng: Number(lng.toFixed(6)),
        category,
        source,
      });
    }
  };

  // Helper with timeout
  const fetchWithTimeout = (url: string, headers?: Record<string, string>) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { headers, signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .finally(() => clearTimeout(timeout));
  };

  try {
    const [nomData, photonData] = await Promise.all([
      fetchWithTimeout(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
          clean
        )}&format=json&limit=5&addressdetails=1`,
        { 'User-Agent': 'PresentiAttendanceMobile/1.0' }
      ),
      fetchWithTimeout(
        `https://photon.komoot.io/api/?q=${encodeURIComponent(clean)}&limit=5`
      ),
    ]);

    // Parse Nominatim results
    if (Array.isArray(nomData)) {
      for (const item of nomData) {
        const addr = item.address || {};
        const streetPart =
          addr.house_number && addr.road
            ? `${addr.house_number} ${addr.road}`
            : addr.road || addr.suburb || addr.neighbourhood || addr.amenity || addr.building;
        const name =
          streetPart ||
          item.name ||
          (item.display_name ? item.display_name.split(',')[0] : clean);

        addLocation(
          `nom-${item.place_id || Math.random()}`,
          name,
          addr.state,
          addr.country,
          addr.city || addr.town || addr.county || addr.suburb,
          parseFloat(item.lat),
          parseFloat(item.lon),
          item.type || 'address',
          'nominatim'
        );
      }
    }

    // Parse Photon results
    if (photonData && Array.isArray(photonData.features)) {
      for (const f of photonData.features) {
        const p = f.properties || {};
        const coords = f.geometry?.coordinates || [];
        const streetPart =
          p.housenumber && p.street ? `${p.housenumber} ${p.street}` : p.street;
        const name =
          streetPart ||
          p.name ||
          p.city ||
          p.district ||
          p.county ||
          clean;
        const category = p.osm_value || p.type || 'place';

        addLocation(
          `ph-${p.osm_id || Math.random()}`,
          name,
          p.state,
          p.country,
          p.district || p.county || p.city,
          coords[1],
          coords[0],
          category,
          'photon'
        );
      }
    }
  } catch (err) {
    console.warn('Online geocoding failed, trying device fallback:', err);
  }

  // If online search returned no results, try native device Geocoder as fallback
  if (results.length === 0) {
    try {
      const expoResults = await Location.geocodeAsync(clean);
      if (expoResults && expoResults.length > 0) {
        for (let i = 0; i < Math.min(expoResults.length, limit); i++) {
          const item = expoResults[i];
          addLocation(
            `expo-${i}`,
            clean,
            undefined,
            undefined,
            undefined,
            item.latitude,
            item.longitude,
            'device',
            'expo'
          );
        }
      }
    } catch {
      // Ignore device geocoder errors
    }
  }

  return results.slice(0, limit);
}

/**
 * Reverse geocodes coordinates to a human-readable venue or street name.
 * Multi-tiered:
 * 1. Nominatim online reverse geocoding
 * 2. Device Location.reverseGeocodeAsync fallback
 */
export async function reverseGeocodeCoords(
  lat: number,
  lng: number
): Promise<{ displayName: string; name: string } | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1`,
      {
        headers: { 'User-Agent': 'PresentiAttendanceMobile/1.0' },
        signal: controller.signal,
      }
    )
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .finally(() => clearTimeout(timeout));

    if (res) {
      const addr = res.address || {};
      const primaryName =
        addr.amenity ||
        addr.building ||
        addr.road ||
        addr.suburb ||
        addr.neighbourhood ||
        addr.city ||
        addr.town ||
        res.name ||
        'Pinned Premises Location';

      const parts: string[] = [];
      if (primaryName) parts.push(primaryName);
      if (addr.suburb && addr.suburb !== primaryName) parts.push(addr.suburb);
      if (addr.city && addr.city !== primaryName) parts.push(addr.city);
      if (addr.state) parts.push(addr.state);
      if (addr.country) parts.push(addr.country);

      return {
        name: primaryName,
        displayName:
          parts.join(', ') || res.display_name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
      };
    }
  } catch {
    // Fall back to native device geocoder below
  }

  // Device native reverse geocoder fallback
  try {
    const results = await Location.reverseGeocodeAsync({
      latitude: lat,
      longitude: lng,
    });
    if (results && results.length > 0) {
      const item = results[0];
      const parts = [
        item.name,
        item.street,
        item.city || item.subregion,
        item.region,
      ].filter(Boolean);
      const name = item.name || item.street || 'Pinned Premises Location';
      return {
        name,
        displayName: parts.join(', ') || `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
      };
    }
  } catch {
    // ignore
  }

  return {
    name: 'Pinned Premises Location',
    displayName: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
  };
}

/**
 * Parses latitude and longitude from raw coordinate strings or Google Maps URLs.
 */
export function parseCoordinatesOrUrl(
  input: string
): { lat: number; lng: number } | null {
  if (!input || typeof input !== 'string') return null;
  const str = input.trim();
  if (!str) return null;

  const isValidCoord = (lat: number, lng: number): boolean => {
    return (
      !isNaN(lat) &&
      !isNaN(lng) &&
      lat >= -90 &&
      lat <= 90 &&
      lng >= -180 &&
      lng <= 180
    );
  };

  // 1. Check for @lat,lng in Google Maps URLs (e.g. .../@4.960234,8.327651,17z...)
  const atMatch = str.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (atMatch) {
    const lat = parseFloat(atMatch[1]);
    const lng = parseFloat(atMatch[2]);
    if (isValidCoord(lat, lng)) return { lat, lng };
  }

  // 2. Check for q=lat,lng or query=lat,lng
  const queryMatch = str.match(
    /[?&](?:q|query)=(-?\d+\.\d+)[,\s]+(-?\d+\.\d+)/
  );
  if (queryMatch) {
    const lat = parseFloat(queryMatch[1]);
    const lng = parseFloat(queryMatch[2]);
    if (isValidCoord(lat, lng)) return { lat, lng };
  }

  // 3. Check for standard coordinate pair: "4.960234, 8.327651"
  const pairMatch = str.match(/^(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)$/);
  if (pairMatch) {
    const lat = parseFloat(pairMatch[1]);
    const lng = parseFloat(pairMatch[2]);
    if (isValidCoord(lat, lng)) return { lat, lng };
  }

  // 4. Loose coordinate match anywhere in text
  const looseMatch = str.match(/(-?\d+\.\d+)[,\s]+(-?\d+\.\d+)/);
  if (looseMatch) {
    const lat = parseFloat(looseMatch[1]);
    const lng = parseFloat(looseMatch[2]);
    if (isValidCoord(lat, lng)) return { lat, lng };
  }

  return null;
}
