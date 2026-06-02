const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

const TRENDING_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.rating',
  'places.userRatingCount',
  'places.googleMapsUri',
  'places.photos',
  'places.primaryType',
  'places.types',
].join(',');

const DETAILS_FIELD_MASK = [
  'id',
  'displayName',
  'formattedAddress',
  'location',
  'rating',
  'userRatingCount',
  'googleMapsUri',
  'websiteUri',
  'regularOpeningHours',
  'currentOpeningHours',
  'internationalPhoneNumber',
  'priceLevel',
  'businessStatus',
  'primaryType',
  'types',
  'photos',
  'editorialSummary',
].join(',');

const FOOD_TYPES = ['restaurant', 'cafe', 'bar'];
const ACTIVITY_TYPES = ['tourist_attraction', 'park', 'movie_theater', 'bowling_alley', 'museum'];

function assertGoogleMapsApiKey() {
  if (!GOOGLE_MAPS_API_KEY) {
    const error = new Error('GOOGLE_MAPS_API_KEY is required for Google Places.');
    error.statusCode = 500;
    throw error;
  }
}

function googlePlacesHeaders(fieldMask) {
  return {
    'Content-Type': 'application/json',
    'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
    'X-Goog-FieldMask': fieldMask,
  };
}

function normalizePlace(place) {
  return {
    id: place.id,
    name: place.displayName?.text ?? 'Unnamed place',
    address: place.formattedAddress ?? '',
    lat: place.location?.latitude,
    lng: place.location?.longitude,
    rating: place.rating,
    userRatingCount: place.userRatingCount,
    googleMapsUri: place.googleMapsUri,
    primaryType: place.primaryType,
    types: place.types ?? [],
    photos: place.photos ?? [],
  };
}

async function fetchGooglePlaces(url, body, fieldMask) {
  assertGoogleMapsApiKey();

  const response = await fetch(url, {
    method: 'POST',
    headers: googlePlacesHeaders(fieldMask),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = new Error(`Google Places returned ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }

  const data = await response.json();
  return data.places ?? [];
}

async function searchNearbyPlaces({ lat, lng, includedTypes }) {
  const places = await fetchGooglePlaces(
    'https://places.googleapis.com/v1/places:searchNearby',
    {
      includedTypes,
      maxResultCount: 10,
      rankPreference: 'POPULARITY',
      locationRestriction: {
        circle: {
          center: {
            latitude: lat,
            longitude: lng,
          },
          radius: 5000,
        },
      },
    },
    TRENDING_FIELD_MASK
  );

  return places.map(normalizePlace);
}

async function searchTextPlaces({ query, includedType }) {
  const places = await fetchGooglePlaces(
    'https://places.googleapis.com/v1/places:searchText',
    {
      textQuery: query,
      includedType,
      maxResultCount: 10,
      rankPreference: 'RELEVANCE',
    },
    TRENDING_FIELD_MASK
  );

  return places.map(normalizePlace);
}

function parseCoordinate(value) {
  const coordinate = Number(value);
  return Number.isFinite(coordinate) ? coordinate : null;
}

export async function getTrendingPlaces({ lat, lng, homeArea }) {
  const latitude = parseCoordinate(lat);
  const longitude = parseCoordinate(lng);
  const area = String(homeArea || 'Auckland, New Zealand').trim() || 'Auckland, New Zealand';

  if (latitude !== null && longitude !== null) {
    const [foodPlaces, activityPlaces] = await Promise.all([
      searchNearbyPlaces({ lat: latitude, lng: longitude, includedTypes: FOOD_TYPES }),
      searchNearbyPlaces({ lat: latitude, lng: longitude, includedTypes: ACTIVITY_TYPES }),
    ]);

    return { foodPlaces, activityPlaces };
  }

  const [foodPlaces, activityPlaces] = await Promise.all([
    searchTextPlaces({ query: `popular food places in ${area}`, includedType: 'restaurant' }),
    searchTextPlaces({ query: `popular activities in ${area}`, includedType: 'tourist_attraction' }),
  ]);

  return { foodPlaces, activityPlaces };
}

export async function getPlaceDetails(placeId) {
  assertGoogleMapsApiKey();

  const cleanPlaceId = String(placeId || '').replace(/^places\//, '').trim();

  if (!cleanPlaceId) {
    const error = new Error('Place ID is required.');
    error.statusCode = 400;
    throw error;
  }

  const response = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(cleanPlaceId)}`, {
    headers: googlePlacesHeaders(DETAILS_FIELD_MASK),
  });

  if (!response.ok) {
    const error = new Error(`Google Places returned ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }

  return response.json();
}
