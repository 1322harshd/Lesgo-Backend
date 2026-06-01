import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import { sendAgentMessage, startAgentConversation } from '../services/aiPlannerGraph.js';

const router = express.Router();

router.use(protect);

router.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'lesgo-agent',
    userId: req.user.userId,
  });
});

//route for starting conversation with agent by passing user detail to 'startAgentConversation' function
router.post('/conversation/start', async (req, res) => {
  try {
    const result = await startAgentConversation(req.user.userId);
    res.status(201).json(result);
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
});

//route to pass conversation to agent
router.post('/chat', async (req, res) => {
  try {
    const result = await sendAgentMessage({
      userId: req.user.userId,
      conversationId: req.body.conversationId,
      message: req.body.message,
    });

    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
});

export default router;
