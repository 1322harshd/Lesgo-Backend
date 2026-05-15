import express from 'express';
import { User } from './models.js';
import { protect } from './authMiddleware.js';

const router = express.Router();

// Add a new user
router.post('/', async (req, res) => {
  try {
    const user = new User(req.body);
    await user.save();
    res.status(201).json(user);
    console.log(res)
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/google/:googleId', async (req, res) => {
  try {
    const user = await User.findOne({ googleId: req.params.googleId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

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

    const user = await User.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true });
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
