import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'lesgo-dev-secret';

// Middleware to protect routes and ensure the user is authenticated
export function protect(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'No token' });
  }
  const token = header.split(' ')[1];
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ message: 'Invalid token' });
  }
}
