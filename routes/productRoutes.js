import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { protect, dealerOrAdmin } from '../middleware/authMiddleware.js';
// import { updateProductStock } from '../controllers/notifyController.js';
import {
  getProducts,
  searchProducts,
  getProductsByCategory,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
  createReview,
  updateReview,
} from '../controllers/productController.js';

const router = express.Router();

// ── Multer ────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = 'uploads/products';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    cb(null, `prod_${Date.now()}${path.extname(file.originalname)}`);
  },
});
const fileFilter = (_req, file, cb) =>
  file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Only images allowed'), false);
const upload = multer({ storage, fileFilter, limits: { fileSize: 5 * 1024 * 1024 } });

// ── Routes ────────────────────────────────────────────────────────────
router.get('/',                   getProducts);
router.get('/search',             searchProducts);
router.get('/category/:slug',     getProductsByCategory);
router.get('/:id',                getProductById);

router.post('/',                  protect, dealerOrAdmin, upload.single('imageFile'), createProduct);
router.put('/:id',                protect, dealerOrAdmin, upload.single('imageFile'), updateProduct);
router.delete('/:id',             protect, dealerOrAdmin, deleteProduct);

router.post('/:id/reviews',       protect, createReview);
router.put('/:id/reviews',        protect, updateReview);

export default router;