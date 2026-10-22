import dns from 'node:dns';
dns.setServers(['8.8.8.8', '1.1.1.1']);

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import connectDB from './Config/db.js';

import authRoutes         from './routes/authRoutes.js';
import productRoutes      from './routes/productRoutes.js';
import cartRoutes         from './routes/cartRoutes.js';
import wishlistRoutes     from './routes/wishlistRoutes.js';
import userRoutes         from './routes/userRoutes.js';
import orderRoutes        from './routes/orderRoutes.js';
import adminRoutes        from './routes/adminRoutes.js';
import dealerRoutes       from './routes/dealerRoutes.js';
import notificationRoutes from './routes/notificationRoutes.js';
import categoryRoutes     from './routes/categoryRoutes.js';
import siteSettingsRoutes from './routes/siteSettingsRoutes.js';
import inventoryRoutes         from './routes/inventoryRoutes.js';
import dealerOfferRoutes       from './routes/dealerOfferRoutes.js';
import fulfillmentNodeRoutes   from './routes/fulfillmentNodeRoutes.js';
import fulfillmentRoutes       from './routes/fulfillmentRoutes.js';
import checkoutRoutes          from './routes/checkoutRoutes.js';
import { releaseExpiredReservations } from './services/inventory/reservationService.js';
import fulfillmentGroupRoutes  from './routes/fulfillmentGroupRoutes.js';
import notifyRoutes from './routes/notifyRoutes.js';
import dealerNotificationRoutes from './routes/dealerNotificationRoutes.js';

dotenv.config();
connectDB();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:3000',
    'http://127.0.0.1:5173',
    'https://e-comauto.vercel.app',
    'https://e-commerce-product-frontend-kappa.vercel.app',
    process.env.FRONTEND_URL,
  ].filter(Boolean),
  credentials: true,
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use('/api/auth',          authRoutes);
app.use('/api/products',      productRoutes);
app.use('/api/cart',          cartRoutes);
app.use('/api/wishlist',      wishlistRoutes);
app.use('/api/user',          userRoutes);
app.use('/api/orders',        orderRoutes);
app.use('/api/admin',         adminRoutes);
app.use('/api/dealer',        dealerRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/categories',    categoryRoutes);
app.use('/api/admin/site-settings', siteSettingsRoutes);
app.use('/api/inventory',         inventoryRoutes);
app.use('/api/dealer-offers',     dealerOfferRoutes);
app.use('/api/fulfillment-nodes', fulfillmentNodeRoutes);
app.use('/api/fulfillment',       fulfillmentRoutes);
app.use('/api/checkout',          checkoutRoutes);
app.use('/api/fulfillment-groups', fulfillmentGroupRoutes);
app.use('/api/notify-me', notifyRoutes);
app.use('/api/dealer-notifications', dealerNotificationRoutes);
app.get('/', (_req, res) => res.json({ status: 'TVS AutoParts API is running ✅' }));
app.use((_req, res) => res.status(404).json({ message: 'Route not found' }));
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ message: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));

// Phase 4 §14 — explicit expiry sweep. Never relies solely on a Mongo TTL
// index (TTL background deletion is asynchronous, §1), so this runs on a
// plain interval instead of introducing Redis/BullMQ for one job.
const RESERVATION_SWEEP_INTERVAL_MS = Number(process.env.RESERVATION_SWEEP_INTERVAL_MS || 60_000);
setInterval(() => {
  releaseExpiredReservations().catch((err) => console.error('releaseExpiredReservations failed:', err.message));
}, RESERVATION_SWEEP_INTERVAL_MS);