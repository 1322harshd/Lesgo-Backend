import express from 'express';
import { getPlaceDetails, getTrendingPlaces } from '../services/placesService.js';

const router = express.Router();

router.get('/trending', async (req, res) => {
  try {
    console.log('GET /places/trending', {
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

router.get('/:placeId', async (req, res) => {
  try {
    console.log('GET /places/:placeId', {
      placeId: req.params.placeId,
    });

    const place = await getPlaceDetails(req.params.placeId);

    res.json({ place });
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
});

export default router;
