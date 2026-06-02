import express from 'express';
import { getTrendingPlaces } from '../services/placesService.js';

const router = express.Router();

//function for building API URL and fetching coordinates from 'Nominatim'
async function resolveCoordinates(cityName) {
  const searchText = cityName.toLowerCase().includes('new zealand')
    ? cityName
    : `${cityName}, New Zealand`;
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', searchText);
  url.searchParams.set('format', 'json');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('limit', '1');

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'LesGo-Hangout-Planner/1.0',
    },
  });

  if (!response.ok) {
    throw new Error(`Geocoder failed with status ${response.status}`);
  }

  const [result] = await response.json();

  if (!result) {
    throw new Error(`City not found: ${cityName}`);
  }

  const city =
    result.address?.city ||
    result.address?.town ||
    result.address?.suburb ||
    result.address?.village ||
    result.display_name;

  return {
    latitude: Number(result.lat),
    longitude: Number(result.lon),
    city: city || cityName,
    formattedAddress: result.display_name || city || cityName,
  };
}

//route for calling function and sending coordinates in response
router.get('/geocode', async (req, res) => {
  try {
    const area = String(req.query.area || '').trim();

    if (!area) {
      return res.status(400).json({ message: 'Home area is required.' });
    }

    const location = await resolveCoordinates(area);

    res.json({
      homeArea: location.formattedAddress,
      homeLat: location.latitude,
      homeLng: location.longitude,
    });
  } catch (error) {
    const statusCode = error.message?.startsWith('City not found') ? 404 : 400;
    res.status(statusCode).json({ message: error.message || 'Could not geocode area.' });
  }
});

router.get('/trending', async (req, res) => {
  try {
    console.log('GET /location/trending', {
      lat: req.query.lat,
      lng: req.query.lng,
      homeArea: req.query.homeArea,
    });

    const places = await getTrendingPlaces({
      lat: req.query.lat,
      lng: req.query.lng,
      homeArea: req.query.homeArea,
    });

    res.json(places);
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
});

export default router;
