import express from 'express';
import 'dotenv/config';
import mongoose from 'mongoose';
import cors from 'cors';

import userRoutes from './routes/userRoutes.js';
import authRoutes from './routes/authRoutes.js';
import socialRoutes from './routes/socialRoutes.js';
import suggestionsRoutes from './routes/suggestionsRoutes.js';
import locationRoutes from './routes/locationRoutes.js';
import agentRoutes from './routes/agentRoutes.js';
import notificationsRoutes from './routes/notificationsRoutes.js';
import placesRoutes from './routes/placesRoutes.js';
import dns from 'node:dns';
dns.setServers(['1.1.1.1', '8.8.8.8']);

const app= express()

//setting PORT environment variable
const PORT = process.env.PORT || 3002;
const HOST = process.env.HOST || '0.0.0.0';

// Configure CORS for frontend applications
const allowedOrigins = process.env.FRONTEND_ORIGINS

app.use(cors({
    origin: allowedOrigins,
    credentials: true
}));

// Enable JSON request body parsing
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'lesgo-backend',
    port: PORT,
  });
});

app.use('/users', userRoutes);

app.use('/auth', authRoutes);

app.use('/social', socialRoutes);

app.use('/suggestions/notifications', notificationsRoutes);

app.use('/suggestions', suggestionsRoutes);

app.use('/location', locationRoutes);

app.use('/places', placesRoutes);

app.use('/locations', placesRoutes);

app.use('/agent', agentRoutes);

app.use('/social/notifications', notificationsRoutes);

app.use('/notifications', notificationsRoutes);

// Connect to MongoDB first
mongoose.connect(process.env.MONGO_DB_URI)
  .then(() => {
    console.log('Connected to MongoDB successfully');
    
    // Only start the server once the DB is ready
    app.listen(PORT, HOST, () => {
      console.log(`Server is running on http://${HOST}:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Database connection failed', err);
    process.exit(1); // Exit if DB connection is critical
  });
