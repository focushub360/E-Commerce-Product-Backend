import Product from '../models/Product.js';
import Notification from '../models/Notification.js';
import mongoose from 'mongoose';
import InventoryItem from '../models/InventoryItem.js';
import {
  ensureOfferAndInventoryForProduct,
  syncOfferAfterProductUpdate,
  deleteInventoryForProduct,
} from '../services/inventory/migrationService.js';

// ── helpers ───────────────────────────────────────────────────────────
const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const buildQuery = (req) => {
  const {
    category, categorySlug, categoryRaw,
    sub, search, dealer: dealerFilter,
  } = req.query;

  const query = {};

  if (category && category !== 'All') {
    // Match against every possible form the category might be stored as:
    //   "Engine Parts"  (name)
    //   "engine-parts"  (slug / URL param)
    //   "Engine"        (first word — handles old seeded products)
    const terms = [...new Set([category, categorySlug, categoryRaw].filter(Boolean))];

    const orClauses = terms.map(t => ({
      category: { $regex: `^${escapeRegex(t)}$`, $options: 'i' },
    }));

    // Also partial-match on the first meaningful word of the name
    // so "Engine Parts" also finds products stored as "Engine"
    const firstWord = category.split(/[\s-]+/)[0];
    if (firstWord && firstWord.length > 2) {
      orClauses.push({ category: { $regex: escapeRegex(firstWord), $options: 'i' } });
    }

    query.$or = orClauses;
  }

  if (sub) {
    query.subCategory = { $regex: `^${escapeRegex(sub)}$`, $options: 'i' };
  }

  if (dealerFilter && mongoose.isValidObjectId(dealerFilter)) {
    query.dealer = dealerFilter;
  }

  if (search) {
    const s = escapeRegex(search);
    query.$or = [
      { title:       { $regex: s, $options: 'i' } },
      { brand:       { $regex: s, $options: 'i' } },
      { category:    { $regex: s, $options: 'i' } },
      { subCategory: { $regex: s, $options: 'i' } },
      { tags:        { $regex: s, $options: 'i' } },
    ];
  }

  return query;
};

const parseArrayField = (value) => {
  if (Array.isArray(value)) return value.map(s => String(s).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map(s => s.trim()).filter(Boolean);
  return [];
};

// Product.stock is retained for legacy dealer/admin forms. Customer-facing
// stock must come from the physical inventory rows, which are the source of
// truth for dealer inventory. Sum available units across active locations.
export const withAvailableStock = async (products) => {
  if (!products.length) return products;
  const ids = products.map((product) => product._id);
  const stocks = await InventoryItem.aggregate([
    { $match: { product: { $in: ids }, isActive: true } },
    { $group: {
      _id: '$product',
      stock: { $sum: { $max: [0, { $subtract: [
        { $ifNull: ['$onHand', 0] },
        { $add: [
          { $ifNull: ['$reserved', 0] },
          { $ifNull: ['$damaged', 0] },
          { $ifNull: ['$blocked', 0] },
        ] },
      ] }] } },
    } },
  ]);
// console.log("Inventory records and calculated stock:", stocks);
//console.log("Product stock before inventory calculation:", products.map(p => ({
  //  id: String(p._id),
  //  stock: p.stock
//})));


  const stockByProduct = new Map(stocks.map(({ _id, stock }) => [String(_id), stock]));
  return products.map((product) => ({
    ...product,
    stock: stockByProduct.get(String(product._id)) ?? product.stock ?? 0,
  }));
};

// ── GET /api/products ─────────────────────────────────────────────────
export const getProducts = async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const sort  = req.query.sort || '-createdAt';

    const query    = buildQuery(req);
    const total    = await Product.countDocuments(query);
    const products = await Product.find(query)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('dealer', 'dealerId businessName')
      .lean();

    res.json({ products: await withAvailableStock(products), total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('[getProducts]', err);
    res.status(500).json({ message: err.message });
  }
};

// ── GET /api/products/search ──────────────────────────────────────────
export const searchProducts = async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || !q.trim()) return res.json([]);

    const s = escapeRegex(q.trim());
    const products = await Product.find({
      $or: [
        { title: { $regex: s, $options: 'i' } },
        { brand: { $regex: s, $options: 'i' } },
        { tags:  { $regex: s, $options: 'i' } },
      ],
    })
      .select('title brand category image price')
      .limit(8)
      .lean();

    res.json(products);
  } catch (err) {
    console.error('[searchProducts]', err);
    res.status(500).json({ message: err.message });
  }
};

// ── GET /api/products/category/:slug ─────────────────────────────────
export const getProductsByCategory = async (req, res) => {
  try {
    const { slug } = req.params;
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const sort  = req.query.sort || '-createdAt';
    const { sub } = req.query;

    // Match slug, name-from-slug, or first word
    const nameFromSlug = slug.replace(/-/g, ' ');
    const firstWord    = slug.split('-')[0];

    const orClauses = [
      { category: { $regex: `^${escapeRegex(slug)}$`,         $options: 'i' } },
      { category: { $regex: `^${escapeRegex(nameFromSlug)}$`, $options: 'i' } },
    ];
    if (firstWord && firstWord.length > 2) {
      orClauses.push({ category: { $regex: escapeRegex(firstWord), $options: 'i' } });
    }

    const query = { $or: orClauses };
    if (sub) query.subCategory = { $regex: `^${escapeRegex(sub)}$`, $options: 'i' };

    const total    = await Product.countDocuments(query);
    const products = await Product.find(query)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('dealer', 'dealerId businessName')
      .lean();

    res.json({ products: await withAvailableStock(products), total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('[getProductsByCategory]', err);
    res.status(500).json({ message: err.message });
  }
};

// ── GET /api/products/:id ─────────────────────────────────────────────

export const getProductById = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid product ID' });
    }

    const product = await Product.findById(req.params.id)
      .populate('reviews.user', 'name avatar')
      .populate('dealer', 'dealerId businessName');

    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    console.log("Stock directly from Product query:", product.stock);

    product.viewCount = (product.viewCount || 0) + 1;
    await product.save();

    const [productWithStock] = await withAvailableStock([product.toObject()]);

    console.log("Stock after withAvailableStock:", productWithStock?.stock);

    res.json(productWithStock);
  } catch (err) {
    console.error('[getProductById]', err);
    res.status(500).json({ message: err.message });
  }
};

// ── POST /api/products ────────────────────────────────────────────────
export const createProduct = async (req, res) => {
  try {
    const body = { ...req.body };

    if (!body.title?.trim())             return res.status(400).json({ message: 'Title is required' });
    if (!body.category?.trim())          return res.status(400).json({ message: 'Category is required' });
    if (!body.price || +body.price <= 0) return res.status(400).json({ message: 'Valid price required' });

    for (const k of ['price', 'originalPrice', 'discount', 'stock', 'rating', 'numReviews']) {
      if (body[k] !== undefined) body[k] = Number(body[k]) || 0;
    }
    for (const k of ['tags', 'features', 'compatibility']) {
      body[k] = parseArrayField(body[k]);
    }

    if (req.file) body.image = `/uploads/products/${req.file.filename}`;
    body.dealer = req.user.role === 'dealer' ? req.user._id : null;

    const product = await Product.create(body);

    if (req.user.role === 'dealer') {
      try {
        const User = (await import('../models/User.js')).default;
        const adminUser = await User.findOne({ role: 'admin' }).lean();
        if (adminUser) {
          await Notification.create({
            recipient:     adminUser._id,
            recipientRole: 'admin',
            type:          'new_arrival',
            title:         'New Dealer Product',
            message:       `${req.user.businessName || req.user.name} added: ${product.title}`,
            refProduct:    product._id,
          });
        }
      } catch (notifErr) {
        console.error('[createProduct] Notification error:', notifErr.message);
      }

      // Phase 1 — auto-seed DealerOffer + InventoryItem for the new dealer
      // product. Non-blocking: a failure here must never fail product creation.
      try {
        await ensureOfferAndInventoryForProduct(product);
      } catch (syncErr) {
        console.error('[createProduct] inventory sync error:', syncErr.message);
      }
    }

    res.status(201).json(product);
  } catch (err) {
    console.error('[createProduct]', err);
    res.status(500).json({ message: err.message });
  }
};

// ── PUT /api/products/:id ─────────────────────────────────────────────
export const updateProduct = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id))
      return res.status(400).json({ message: 'Invalid product ID' });

    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });
    if (req.user.role === 'dealer' && product.dealer?.toString() !== req.user._id.toString())
      return res.status(403).json({ message: 'Not authorized to edit this product' });

    const body = { ...req.body };

    for (const k of ['price', 'originalPrice', 'discount', 'stock', 'rating', 'numReviews']) {
      if (body[k] !== undefined) body[k] = Number(body[k]) || 0;
    }
    for (const k of ['tags', 'features', 'compatibility']) {
      if (body[k] !== undefined) body[k] = parseArrayField(body[k]);
    }
    if (req.file) body.image = `/uploads/products/${req.file.filename}`;

    const updated = await Product.findByIdAndUpdate(req.params.id, body, { new: true, runValidators: true });

    if (product.stock === 0 && updated.stock > 0) {
      try {
        const Wishlist = (await import('../models/Wishlist.js')).default;
        const wishlists = await Wishlist.find({ products: product._id }).select('user').lean();
        const notifs = wishlists.map(w => ({
          recipient:     w.user,
          recipientRole: 'user',
          type:          'new_arrival',
          title:         'Back in Stock!',
          message:       `${product.title} is now back in stock!`,
          link:          `/products/${product._id}`,
          refProduct:    product._id,
        }));
        if (notifs.length) await Notification.insertMany(notifs);
      } catch (notifErr) {
        console.error('[updateProduct] Notification error:', notifErr.message);
      }
    }

    // Phase 1 — keep the dealer's offer/inventory up to date. Non-destructive:
    // creates any missing offer/node/inventory and refreshes commercial terms
    // (price), but never overwrites manually-adjusted stock quantities.
    if (updated.dealer) {
      try {
        await ensureOfferAndInventoryForProduct(updated);
        await syncOfferAfterProductUpdate(updated);
      } catch (syncErr) {
        console.error('[updateProduct] inventory sync error:', syncErr.message);
      }
    }

    res.json(updated);
  } catch (err) {
    console.error('[updateProduct]', err);
    res.status(500).json({ message: err.message });
  }
};

// ── DELETE /api/products/:id ──────────────────────────────────────────
export const deleteProduct = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id))
      return res.status(400).json({ message: 'Invalid product ID' });

    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });
    if (req.user.role === 'dealer' && product.dealer?.toString() !== req.user._id.toString())
      return res.status(403).json({ message: 'Not authorized' });

    await product.deleteOne();

    // Phase 1 — remove the related offer + inventory rows (no orphan records).
    try {
      await deleteInventoryForProduct(product._id);
    } catch (cleanupErr) {
      console.error('[deleteProduct] inventory cleanup error:', cleanupErr.message);
    }

    res.json({ message: 'Product deleted' });
  } catch (err) {
    console.error('[deleteProduct]', err);
    res.status(500).json({ message: err.message });
  }
};

// ── POST /api/products/:id/reviews ────────────────────────────────────
export const createReview = async (req, res) => {
  try {
    if (req.user.role !== 'user')
      return res.status(403).json({ message: 'Only customers can submit reviews' });

    if (!mongoose.isValidObjectId(req.params.id))
      return res.status(400).json({ message: 'Invalid product ID' });

    const { rating, comment } = req.body;
    const parsedRating = Number(rating);
    if (!parsedRating || parsedRating < 1 || parsedRating > 5)
      return res.status(400).json({ message: 'Rating must be between 1 and 5' });

    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });

    const alreadyReviewed = product.reviews.some(
      r => r.user.toString() === req.user._id.toString()
    );
    if (alreadyReviewed)
      return res.status(400).json({ message: 'You have already reviewed this product' });

    const Order = (await import('../models/Order.js')).default;
    const purchased = await Order.findOne({
      user:                 req.user._id,
      orderStatus:          'Delivered',
      'orderItems.product': product._id,
    });
    if (!purchased)
      return res.status(400).json({ message: 'You can only review products you have purchased and received' });

    product.reviews.push({ user: req.user._id, name: req.user.name, rating: parsedRating, comment: comment || '' });
    product.numReviews = product.reviews.length;
    product.rating     = product.reviews.reduce((a, r) => a + r.rating, 0) / product.reviews.length;
    await product.save();

    res.status(201).json({ message: 'Review submitted', rating: product.rating, numReviews: product.numReviews });
  } catch (err) {
    console.error('[createReview]', err);
    res.status(500).json({ message: err.message });
  }
};

// ── PUT /api/products/:id/reviews ─────────────────────────────────────
export const updateReview = async (req, res) => {
  try {
    if (req.user.role !== 'user')
      return res.status(403).json({ message: 'Only customers can edit reviews' });

    if (!mongoose.isValidObjectId(req.params.id))
      return res.status(400).json({ message: 'Invalid product ID' });

    const { rating, comment } = req.body;
    const parsedRating = Number(rating);
    if (!parsedRating || parsedRating < 1 || parsedRating > 5)
      return res.status(400).json({ message: 'Rating must be between 1 and 5' });

    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });

    const existing = product.reviews.find(r => r.user.toString() === req.user._id.toString());
    if (!existing)
      return res.status(404).json({ message: 'You have not reviewed this product yet' });

    existing.rating  = parsedRating;
    existing.comment = comment || '';
    product.rating     = product.reviews.reduce((a, r) => a + r.rating, 0) / product.reviews.length;
    product.numReviews = product.reviews.length;
    await product.save();

    res.json({ message: 'Review updated', rating: product.rating, numReviews: product.numReviews });
  } catch (err) {
    console.error('[updateReview]', err);
    res.status(500).json({ message: err.message });
  }
};
