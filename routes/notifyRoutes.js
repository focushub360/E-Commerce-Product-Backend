
import express from 'express';
import rateLimit from 'express-rate-limit';

import {
    createNotifyMe,
    getMyNotifications,
    getNotifyStatus,
    cancelNotifyMe,
} from '../controllers/notifyController.js';

import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

const createLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: 'Too many requests. Please try again later.',
    },
});

// All Notify Me routes require login
router.use(protect);

// Create subscription and alert the dealer
router.post('/', createLimiter, createNotifyMe);

// Get all subscriptions for the logged-in customer
router.get('/my', getMyNotifications);

// Check subscription status for a particular product
router.get('/status/:productId', getNotifyStatus);

// Cancel a subscription
router.patch('/:id/cancel', cancelNotifyMe);

export default router;
