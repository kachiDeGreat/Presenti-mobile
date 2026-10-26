import * as Location from 'expo-location';

// Geocoding and location search service supporting native device, Google, Photon, and OSM

export interface GeocodedLocation {
  id: string;
  name: string;
  sub: string;
  displayName: string;
  lat: number;
  lng: number;
  category?: string;
  source?: 'google' | 'device' | 'photon' | 'nominatim' | 'coordinates';
}

// Bounding box for Nigeria: [minLng, minLat, maxLng, maxLat]
const NIGERIA_BBOX = '2.6769,4.2725,14.6778,13.8920';

// Nigerian state abbreviations, acronyms, and common city aliases
const NIGERIAN_ALIASES: Record<string, string> = {
  CRS: 'Cross River State',
  CR: 'Cross River State',
  FCT: 'Abuja, Federal Capital Territory',
  ABJ: 'Abuja',
  PH: 'Port Harcourt, Rivers State',
  PHC: 'Port Harcourt, Rivers State',
  LG: 'Lagos State',
  LAG: 'Lagos State',
  KD: 'Kaduna State',
  KAD: 'Kaduna State',
  KN: 'Kano State',
  KAN: 'Kano State',
  ED: 'Edo State',
  BEN: 'Benin City, Edo State',
  DT: 'Delta State',
  DEL: 'Delta State',
  AN: 'Anambra State',
  ANA: 'Anambra State',
  AWK: 'Awka, Anambra State',
  EN: 'Enugu State',
  ENU: 'Enugu State',
  IM: 'Imo State',
  OWE: 'Owerri, Imo State',
  AB: 'Abia State',
  UMU: 'Umuahia, Abia State',
  ABA: 'Aba, Abia State',
  AK: 'Akwa Ibom State',
  AKS: 'Akwa Ibom State',
  UYO: 'Uyo, Akwa Ibom State',
  OG: 'Ogun State',
  ABK: 'Abeokuta, Ogun State',
  ON: 'Ondo State',
  AKR: 'Akure, Ondo State',
  OS: 'Osun State',
  OSH: 'Osogbo, Osun State',
  OY: 'Oyo State',
  IB: 'Ibadan, Oyo State',
  EK: 'Ekiti State',
  ADO: 'Ado-Ekiti, Ekiti State',
  KW: 'Kwara State',
  ILO: 'Ilorin, Kwara State',
  KG: 'Kogi State',
  LOK: 'Lokoja, Kogi State',
  BN: 'Benue State',
  MKD: 'Makurdi, Benue State',
  PL: 'Plateau State',
  JOS: 'Jos, Plateau State',
  NS: 'Nasarawa State',
  LAF: 'Lafia, Nasarawa State',
  TR: 'Taraba State',
  JAL: 'Jalingo, Taraba State',
  AD: 'Adamawa State',
  YOL: 'Yola, Adamawa State',
  BA: 'Bauchi State',
  BAU: 'Bauchi State',
  GO: 'Gombe State',
  GOM: 'Gombe State',
  BO: 'Borno State',
  MIU: 'Maiduguri, Borno State',
  YB: 'Yobe State',
  DAM: 'Damaturu, Yobe State',
  JG: 'Jigawa State',
  DUT: 'Dutse, Jigawa State',
  KT: 'Katsina State',
  KAT: 'Katsina State',
  SK: 'Sokoto State',
  SOK: 'Sokoto State',
  ZB: 'Zamfara State',
  GUS: 'Gusau, Zamfara State',
  KB: 'Kebbi State',
  BRK: 'Birnin Kebbi, Kebbi State',
  NG: 'Niger State',
  MIN: 'Minna, Niger State',
  BY: 'Bayelsa State',
  YEN: 'Yenagoa, Bayelsa State',
  EB: 'Ebonyi State',
};

/**
 * Expands Nigerian shorthand and abbreviations to full searchable names.
 * e.g., "Calabar, CRS" -> "Calabar, Cross River State, Nigeria"
 */
export function expandLocationQuery(rawQuery: string): {
  expanded: string;
  isNigerian: boolean;
} {
  const clean = rawQuery.trim();
  let isNigerian = false;

  // Check if text already references Nigeria explicitly
  if (/\bnigeria\b/i.test(clean)) {
    isNigerian = true;
  }

  // Expand state codes or acronyms
  const words = clean.split(/([, \t/]+)/);
  const transformed = words.map((w) => {
    const stripped = w.replace(/[^a-zA-Z]/g, '').toUpperCase();
    if (stripped && NIGERIAN_ALIASES[stripped]) {
      isNigerian = true;
      return NIGERIAN_ALIASES[stripped];
    }
    return w;
  });

  let expanded = transformed.join('');

  // If a known Nigerian state or city is present, ensure "Nigeria" is appended if not present
  if (isNigerian && !/\bnigeria\b/i.test(expanded)) {
    expanded = `${expanded}, Nigeria`;
  }

  return { expanded, isNigerian };
}

/**
 * Validates if coordinates are geographically within Nigeria boundaries.
 */
function isWithinNigeria(lat: number, lng: number): boolean {
  return lat >= 4.0 && lat <= 14.0 && lng >= 2.5 && lng <= 15.0;
}

/**
 * Searches global and local locations, venues, addresses, and landmarks.
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
        sub: 'Pasted Coordinates / Google Maps Link',
        displayName: `Coordinates: ${parsedCoords.lat.toFixed(6)}, ${parsedCoords.lng.toFixed(6)}`,
        lat: parsedCoords.lat,
        lng: parsedCoords.lng,
        category: 'coordinates',
        source: 'coordinates',
      },
    ];
  }

  const limit = options?.limit || 6;
  const timeoutMs = options?.timeoutMs || 8000;
  const results: GeocodedLocation[] = [];
  const seen = new Set<string>();

  // Expand abbreviations (e.g. "Calabar, CRS" -> "Calabar, Cross River State, Nigeria")
  const { expanded, isNigerian } = expandLocationQuery(clean);

  const addLocation = (
    id: string,
    name: string,
    state?: string,
    country?: string,
    district?: string,
    lat?: number,
    lng?: number,
    category?: string,
    source?: 'google' | 'device' | 'photon' | 'nominatim'
  ) => {
    if (typeof lat !== 'number' || typeof lng !== 'number' || !name) return;
    if (isNaN(lat) || isNaN(lng)) return;

    // Strict safety filter: if user searched a Nigerian location, reject results outside Nigeria!
    if (isNigerian && !isWithinNigeria(lat, lng)) {
      return;
    }

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

  // Tier 1: Native device geocoder
  const nativeDevicePromise = (async () => {
    try {
      // Query both expanded and original clean query in parallel
      const searchTerms = [expanded];
      if (expanded !== clean) searchTerms.push(clean);

      for (const term of searchTerms) {
        const expoResults = await Location.geocodeAsync(term);
        if (expoResults && expoResults.length > 0) {
          for (let i = 0; i < Math.min(expoResults.length, 3); i++) {
            const item = expoResults[i];
            addLocation(
              `device-${i}-${Date.now()}`,
              clean,
              undefined,
              isNigerian ? 'Nigeria' : undefined,
              undefined,
              item.latitude,
              item.longitude,
              'google_device',
              'device'
            );
          }
          if (results.length > 0) break;
        }
      }
    } catch {
      // Device geocoder failed or not available, proceed to online engines
    }
  })();

  // Tier 2: Google Maps geocoding API
  const googleApiKey =
    process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY ||
    process.env.EXPO_PUBLIC_GOOGLE_SERVICES_API_KEY ||
    '';

  const googleApiPromise = (async () => {
    if (!googleApiKey) return;
    try {
      const countryFilter = isNigerian ? '&components=country:NG' : '';
      const googleUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
        expanded
      )}${countryFilter}&key=${googleApiKey}`;

      const data = await fetchWithTimeout(googleUrl);
      if (data && data.status === 'OK' && Array.isArray(data.results)) {
        for (let i = 0; i < Math.min(data.results.length, 4); i++) {
          const item = data.results[i];
          const lat = item.geometry?.location?.lat;
          const lng = item.geometry?.location?.lng;
          const formatted = item.formatted_address || clean;
          const parts = formatted.split(',');
          const primaryName = parts[0]?.trim() || clean;

          addLocation(
            `google-${item.place_id || i}`,
            primaryName,
            parts[parts.length - 2]?.trim(),
            parts[parts.length - 1]?.trim(),
            undefined,
            lat,
            lng,
            item.types?.[0] || 'venue',
            'google'
          );
        }
      }
    } catch {
      // Ignore Google API errors (e.g. no billing, quota) and fall back
    }
  })();

  // Tier 3: Photon geocoding with Nigeria bounding box
  const photonQuery = isNigerian
    ? `https://photon.komoot.io/api/?q=${encodeURIComponent(
        expanded
      )}&bbox=${NIGERIA_BBOX}&limit=5`
    : `https://photon.komoot.io/api/?q=${encodeURIComponent(expanded)}&limit=5`;

  const photonPromise = fetchWithTimeout(photonQuery).then((photonData) => {
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
  });

  // Tier 4: OpenStreetMap Nominatim geocoding
  const nominatimQuery = isNigerian
    ? `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
        expanded
      )}&countrycodes=ng&format=json&limit=5&addressdetails=1`
    : `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
        expanded
      )}&format=json&limit=5&addressdetails=1`;

  const nominatimPromise = fetchWithTimeout(nominatimQuery, {
    'User-Agent': 'PresentiAttendanceMobile/1.0',
  }).then((nomData) => {
    if (Array.isArray(nomData)) {
      for (const item of nomData) {
        const addr = item.address || {};
        const streetPart =
          addr.house_number && addr.road
            ? `${addr.house_number} ${addr.road}`
            : addr.road ||
              addr.suburb ||
              addr.neighbourhood ||
              addr.amenity ||
              addr.building;
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
  });

  // Execute all tiers concurrently
  await Promise.allSettled([
    nativeDevicePromise,
    googleApiPromise,
    photonPromise,
    nominatimPromise,
  ]);

  return results.slice(0, limit);
}

/**
 * Reverse geocodes coordinates to a human-readable venue or street name.
 * Uses Android native Google Play geocoder first, followed by Nominatim.
 */
export async function reverseGeocodeCoords(
  lat: number,
  lng: number
): Promise<{ displayName: string; name: string } | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  // 1. Device native reverse geocoder (uses Google Play Services on Android for 100% free)
  try {
    const results = await Location.reverseGeocodeAsync({
      latitude: lat,
      longitude: lng,
    });
    if (results && results.length > 0) {
      const item = results[0];
      const primaryName =
        item.name ||
        item.street ||
        item.district ||
        item.city ||
        'Pinned Premises Location';

      let region = item.region || '';
      if (
        item.country?.toLowerCase() === 'nigeria' &&
        region &&
        !region.toLowerCase().includes('state') &&
        !region.toLowerCase().includes('fct')
      ) {
        region = `${region} State`;
      }

      const parts = [
        item.name,
        item.street,
        item.subregion || item.city,
        region,
        item.country,
      ].filter(Boolean);

      return {
        name: primaryName,
        displayName:
          Array.from(new Set(parts)).join(', ') ||
          `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
      };
    }
  } catch {
    // Fall back to Nominatim below
  }

  // 2. Nominatim online reverse geocoding fallback
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

      let cleanState = addr.state || '';
      if (
        addr.country?.toLowerCase() === 'nigeria' &&
        cleanState &&
        !cleanState.toLowerCase().includes('state') &&
        !cleanState.toLowerCase().includes('fct')
      ) {
        cleanState = `${cleanState} State`;
      }

      const parts: string[] = [];
      if (primaryName) parts.push(primaryName);
      if (addr.suburb && addr.suburb !== primaryName) parts.push(addr.suburb);
      if (addr.city && addr.city !== primaryName) parts.push(addr.city);
      if (cleanState) parts.push(cleanState);
      if (addr.country) parts.push(addr.country);

      return {
        name: primaryName,
        displayName:
          parts.join(', ') ||
          res.display_name ||
          `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
      };
    }
  } catch {
    // Ignore and return coordinate fallback
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
