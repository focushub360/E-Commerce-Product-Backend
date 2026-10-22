import express from 'express';
import { getDealerNotifications } from '../controllers/dealerNotificationController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

// Get notifications for the logged-in dealer
router.get('/', protect, getDealerNotifications);

export default router;