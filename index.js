import express from 'express';
import 'dotenv/config';
import mongoose from 'mongoose';
import cors from 'cors';

import userRoutes from './routes.js';
import authRoutes from './authRoutes.js';
import socialRoutes from './socialRoutes.js';
import { protect } from './authMiddleware.js';
import dns from 'node:dns';
dns.setServers(['1.1.1.1', '8.8.8.8']);

const app= express()

//setting PORT environment variable
const PORT = process.env.PORT || 3002;

// Configure CORS for frontend applications
const allowedOrigins = process.env.FRONTEND_ORIGINS

app.use(cors({
    origin: allowedOrigins,
    credentials: true
}));

// Enable JSON request body parsing
app.use(express.json());

//add new user route
app.use('/users', userRoutes);

app.use('/auth', authRoutes);

app.use('/social', socialRoutes);

// Example protected route:
app.get('/profile', protect, async (req, res) => {
  // req.user contains { userId, email }
  res.json({ userId: req.user.userId, email: req.user.email });
});

// Connect to MongoDB first
mongoose.connect(process.env.MONGO_DB_URI)
  .then(() => {
    console.log('Connected to MongoDB successfully');
    
    // Only start the server once the DB is ready
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Database connection failed', err);
    process.exit(1); // Exit if DB connection is critical
  });
