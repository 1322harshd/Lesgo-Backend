import express from 'express';
import 'dotenv/config';
import mongoose from 'mongoose';
import cors from 'cors';

import userRoutes from './routes.js';

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
