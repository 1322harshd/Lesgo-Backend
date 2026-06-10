import express from 'express';
import { User } from '../models/appModels.js';
import { protect } from '../middleware/authMiddleware.js';
import { buildUserUpdateDocument } from '../services/userPrivacyService.js';

const router = express.Router();

// Update the authenticated user by ID
router.put('/:id', protect, async (req, res) => {
  try {
    if (req.user.userId !== req.params.id) {
      return res.status(403).json({ error: 'You can only update your own profile' });
    }

    const allowedUpdates = {
      name: req.body.name,
      email: req.body.email,
      profilePicture: req.body.profilePicture,
      contactNumber: req.body.contactNumber,
      homeArea: req.body.homeArea,
      homeLat: req.body.homeLat,
      homeLng: req.body.homeLng,
    };
    const updates = Object.fromEntries(
      Object.entries(allowedUpdates).filter(([, value]) => value !== undefined)
    );

    const user = await User.findByIdAndUpdate(
      req.params.id,
      buildUserUpdateDocument(updates),
      { new: true, runValidators: true }
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Get a user by ID
router.get('/:id', protect, async (req, res) => {
  try {
    if (req.user.userId !== req.params.id) {
      return res.status(403).json({ error: 'You can only view your own profile' });
    }

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
