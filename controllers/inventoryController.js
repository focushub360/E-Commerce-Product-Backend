import mongoose from 'mongoose';
import User from '../models/User.js';
import Product from '../models/Product.js';
import FulfillmentNode from '../models/FulfillmentNode.js';
import InventoryItem from '../models/InventoryItem.js';
import { withAvailableList } from '../services/inventory/inventoryUtils.js';
import { runMigration } from '../services/inventory/migrationService.js';
import { withAvailableStock } from './productController.js';
import { notifyBackInStock } from './notifyController.js';
import DealerNotification from '../models/DealerNotification.js';

/* ── helpers ─────────────────────────────────────────────────────────── */

const isDealer = (req) => req.user?.role === 'dealer';

const INVENTORY_POPULATE = [
  { path: 'product',            select: 'title brand category subCategory image partNumber productId price stock' },
  { path: 'dealer',             select: 'name businessName dealerId businessLocation' },
  { path: 'fulfillmentNode',    select: 'name type address expressEnabled serviceRadiusKm isActive' },
];

const parsePage = (req, max = 100) => {
  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const limit = Math.min(max, parseInt(req.query.limit) || 20);
  return { page, limit };
};

const validateObjectId = (value, label) => {
  if (!value) return { error: `${label} is required` };
  if (!mongoose.isValidObjectId(value)) return { error: `Invalid ${label}` };
  return {};
};

const assertQuantity = (value, label) => {
  const num = Number(value);
  if (value === undefined || value === null || value === '') return { valid: false, error: `${label} is required` };
  if (!Number.isFinite(num) || num < 0) return { valid: false, error: `${label} must be a non-negative number` };
  if (!Number.isInteger(num)) return { valid: false, error: `${label} must be a whole number` };
  return { valid: true, value: num };
};

const buildInventoryMatch = (req) => {
  const match = {};
  const { product, dealer, fulfillmentNode, sku, isActive, availability } = req.query;

  // NOTE: this match object is used both by Mongoose's find()/countDocuments()
  // (which auto-cast string ids against the schema) AND by aggregate()'s raw
  // $match stage (which does NOT auto-cast). ObjectId values must therefore
  // be cast explicitly here, or the aggregate summary silently matches zero
  // documents whenever an id filter is applied.
  const toObjectId = (id) => new mongoose.Types.ObjectId(id);

  if (product) {
    const ids = String(product)
      .split(',')
      .map((s) => s.trim())
      .filter((s) => mongoose.isValidObjectId(s));
    if (ids.length === 1) match.product = toObjectId(ids[0]);
    else if (ids.length > 1) match.product = { $in: ids.map(toObjectId) };
  }
  if (dealer && mongoose.isValidObjectId(dealer)) match.dealer = toObjectId(dealer);
  if (fulfillmentNode && mongoose.isValidObjectId(fulfillmentNode)) match.fulfillmentNode = toObjectId(fulfillmentNode);
  if (sku) match.sku = { $regex: String(sku).trim(), $options: 'i' };
  if (isActive !== undefined) match.isActive = isActive === 'true';

  // Stock availability filters — derived, never stored as a field.
  const onHandExpr = ['$reserved', '$damaged', '$blocked'];
  if (availability === 'in')    match.$expr = { $gt:  ['$onHand', { $sum: onHandExpr }] };
  if (availability === 'out')   match.$expr = { $lte: ['$onHand', { $sum: onHandExpr }] };
  if (availability === 'low')   match.$expr = { $and: [
    { $gt: ['$onHand', { $sum: onHandExpr }] },
    { $lte: [{ $subtract: ['$onHand', { $sum: onHandExpr }] }, 10] },
  ] };

  // Dealer role: hard-scope everything to their own inventory.
  if (isDealer(req)) match.dealer = toObjectId(req.user._id);

  return match;
};

const LOW_STOCK_THRESHOLD = 10;

const paginateInventory = async (match, { page, limit }) => {
  const [total, items] = await Promise.all([
    InventoryItem.countDocuments(match),
    InventoryItem.find(match)
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate(INVENTORY_POPULATE)
      .lean(),
  ]);

  // Fetch all items that match for summary computation (without pagination)
  const allItems = await InventoryItem.find(match).lean();
  let totalSkus = 0;
  let totalUnits = 0;
  let reserved = 0;
  let damaged = 0;
  let blocked = 0;
  let available = 0;
  let lowStockCount = 0;

  for (const item of allItems) {
    totalSkus++;
    totalUnits += item.onHand;
    reserved += item.reserved;
    damaged += item.damaged;
    blocked += item.blocked;
    const avail = Math.max(0, item.onHand - item.reserved - item.damaged - item.blocked);
    available += avail;
    if (avail > 0 && avail <= LOW_STOCK_THRESHOLD) {
      lowStockCount++;
    }
  }

  const summary = {
    totalSkus,
    totalUnits,
    totalOnHand: totalUnits,
    reservedUnits: reserved,
    damagedUnits: damaged,
    blockedUnits: blocked,
    availableUnits: available,
    totalAvailable: available,
    lowStockCount,
  };

  return { total, items: withAvailableList(items), summary, page, pages: Math.ceil(total / limit) };
};

/* ── GET /api/inventory — all inventory (filtered + paginated) ───────── */
export const getAllInventory = async (req, res) => {
  try {
    const { page, limit } = parsePage(req);
    const match = buildInventoryMatch(req);

    // Category filter — resolve to product ids first (no global stock field
    // to query here, inventory rows reference products).
    const { category } = req.query;
    if (category && category !== 'All') {
      const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const productIds = await Product.find({
        category: { $regex: `^${escapeRegex(String(category))}$`, $options: 'i' },
      }).distinct('_id');

      if (!productIds.length) {
        return res.json({ inventory: [], total: 0, page, pages: 0, summary: null });
      }
      if (match.product) {
        const existing = Array.isArray(match.product?.$in)
          ? match.product.$in
          : [match.product];
        match.product = { $in: existing.filter((id) => productIds.some((p) => p.toString() === id.toString())) };
      } else {
        match.product = { $in: productIds };
      }
    }

    const { total, items, summary, pages } = await paginateInventory(match, { page, limit });
    res.json({ inventory: items, total, page, pages, summary });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/* ── GET /api/inventory/product/:productId ───────────────────────────── */
export const getProductInventory = async (req, res) => {
  try {
    const { error } = validateObjectId(req.params.productId, 'product ID');
    if (error) return res.status(400).json({ message: error });

    const product = await Product.findById(req.params.productId).lean();
    if (!product) return res.status(404).json({ message: 'Product not found' });

    const match = { product: product._id };
    if (isDealer(req)) match.dealer = req.user._id;

    const items = await InventoryItem.find(match)
      .populate(INVENTORY_POPULATE)
      .sort('-updatedAt')
      .lean();

    res.json({
      product: { _id: product._id, title: product.title, brand: product.brand, image: product.image, category: product.category },
      inventory: withAvailableList(items),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/* ── GET /api/inventory/dealer/:dealerId ─────────────────────────────── */
export const getDealerInventory = async (req, res) => {
  try {
    const { error } = validateObjectId(req.params.dealerId, 'dealer ID');
    if (error) return res.status(400).json({ message: error });

    // Cross-dealer access is forbidden — dealers may only see their own.
    if (isDealer(req) && req.params.dealerId !== req.user._id.toString())
      return res.status(403).json({ message: 'Not authorized to view this dealer inventory' });

    const dealer = await User.findOne({ _id: req.params.dealerId, role: 'dealer' })
      .select('name businessName dealerId businessLocation dealerState')
      .lean();
    if (!dealer) return res.status(404).json({ message: 'Dealer not found' });

    const { page, limit } = parsePage(req);
    const { total, items, summary, pages } = await paginateInventory(
      { dealer: dealer._id },
      { page, limit }
    );

    res.json({ dealer, inventory: items, total, page, pages, summary });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/* ── GET /api/inventory/node/:nodeId ─────────────────────────────────── */
export const getNodeInventory = async (req, res) => {
  try {
    const { error } = validateObjectId(req.params.nodeId, 'node ID');
    if (error) return res.status(400).json({ message: error });

    const node = await FulfillmentNode.findById(req.params.nodeId).lean();
    if (!node) return res.status(404).json({ message: 'Fulfillment node not found' });

    // Dealers may only inspect their own nodes.
    if (isDealer(req) && node.dealer?.toString() !== req.user._id.toString())
      return res.status(403).json({ message: 'Not authorized to view this node inventory' });

    const { page, limit } = parsePage(req);
    const { total, items, summary, pages } = await paginateInventory(
      { fulfillmentNode: node._id },
      { page, limit }
    );

    res.json({ node, inventory: items, total, page, pages, summary });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/* ── PUT /api/inventory/:id — update stock (no reservation logic yet) ── */


export const updateInventory = async (req, res) => {
  try {
    const { error } = validateObjectId(req.params.id, 'inventory ID');

    if (error) {
      return res.status(400).json({ message: error });
    }

    const item = await InventoryItem.findById(req.params.id);

    if (!item) {
      return res.status(404).json({ message: 'Inventory not found' });
    }

    // Dealers may update only their own inventory.
    if (
      isDealer(req) &&
      item.dealer.toString() !== req.user._id.toString()
    ) {
      return res.status(403).json({
        message: 'Not authorized to update this inventory',
      });
    }

    const productDoc = await Product.findById(item.product).lean();

    if (!productDoc) {
      return res.status(404).json({ message: 'Product not found' });
    }

    // Calculate stock before the update.
    const [beforeProduct] = await withAvailableStock([productDoc]);
    const stockBefore = Number(beforeProduct?.stock ?? 0);

    const { onHand, damaged, blocked, isActive } = req.body;

    if (onHand !== undefined) {
      const r = assertQuantity(onHand, 'onHand');
      if (!r.valid) {
        return res.status(400).json({ message: r.error });
      }
      item.onHand = r.value;
    }

    if (damaged !== undefined) {
      const r = assertQuantity(damaged, 'damaged');
      if (!r.valid) {
        return res.status(400).json({ message: r.error });
      }
      item.damaged = r.value;
    }

    if (blocked !== undefined) {
      const r = assertQuantity(blocked, 'blocked');
      if (!r.valid) {
        return res.status(400).json({ message: r.error });
      }
      item.blocked = r.value;
    }

    if (isActive !== undefined) {
      item.isActive = isActive === true || isActive === 'true';
    }

    item.lastUpdatedAt = new Date();
    await item.save();

    // Reload product and recalculate using the saved inventory.
    const freshProduct = await Product.findById(item.product).lean();
    const [afterProduct] = await withAvailableStock([freshProduct]);
    const stockAfter = Number(afterProduct?.stock ?? 0);

    console.log('[INVENTORY]', {
      productId: item.product,
      stockBefore,
      stockAfter,
    });

    // Use the inventory record's assigned dealer.
    const dealerId = item.dealer;

    if (stockAfter <= 0) {
      // Reuse an existing unresolved alert if one exists.
      const existingAlert = await DealerNotification.findOne({
        dealer: dealerId,
        product: item.product,
        type: 'out_of_stock',
        isResolved: false,
      });

      if (!existingAlert) {
        await DealerNotification.create({
          dealer: dealerId,
          product: item.product,
          customer: null,
          type: 'out_of_stock',
          message: `${freshProduct.title || freshProduct.name || 'This product'} is out of stock. Kindly restock the product.`,
          isRead: false,
          isResolved: false,
        });

        console.log('[INVENTORY] Dealer restock alert created.');
      }
    } else {
      // Stock is available: resolve any outstanding restock alert.
      await DealerNotification.updateMany(
        {
          dealer: dealerId,
          product: item.product,
          type: 'out_of_stock',
          isResolved: false,
        },
        {
          $set: {
            isResolved: true,
            isRead: true,
          },
        }
      );
    }

    // Keep the existing customer WhatsApp notification cycle.
    if (stockBefore <= 0 && stockAfter > 0) {
      notifyBackInStock(freshProduct).catch((err) => {
        console.error('[RESTOCK] WhatsApp notification error:', err);
      });
    }

    return res.json({
      inventory: withAvailableList([item.toObject()])[0],
      message: 'Inventory updated',
    });
  } catch (err) {
    console.error('[INVENTORY] Update failed:', err);
    return res.status(500).json({ message: err.message });
  }
};



/* ── POST /api/inventory — create inventory row (dealer or admin) ────── */
export const createInventory = async (req, res) => {
  try {
    const { product, dealer, fulfillmentNode, onHand = 0, damaged = 0, blocked = 0, sku, isActive } = req.body;
   
    for (const [value, label] of [[product, 'product'], [dealer, 'dealer'], [fulfillmentNode, 'fulfillment node']]) {
      const v = validateObjectId(value, label);
      if (v.error) return res.status(400).json({ message: v.error });
    }

    // Ownership: dealer can only create rows for themselves.
    if (isDealer(req) && dealer !== req.user._id.toString())
      return res.status(403).json({ message: 'Not authorized to create inventory for another dealer' });

    const [productDoc, dealerDoc, nodeDoc] = await Promise.all([
      Product.findById(product).lean(),
      User.findOne({ _id: dealer, role: 'dealer' }).lean(),
      FulfillmentNode.findById(fulfillmentNode).lean(),
    ]);

    if (!productDoc)  return res.status(404).json({ message: 'Product not found' });
    if (!dealerDoc)   return res.status(404).json({ message: 'Dealer not found' });
    if (!nodeDoc)     return res.status(404).json({ message: 'Fulfillment node not found' });
    if (nodeDoc.dealer?.toString() !== dealerDoc._id.toString())
      return res.status(400).json({ message: 'Fulfillment node does not belong to the selected dealer' });

    const onHandNum  = assertQuantity(onHand, 'onHand');
    const damagedNum = assertQuantity(damaged, 'damaged');
    const blockedNum = assertQuantity(blocked, 'blocked');
    for (const r of [onHandNum, damagedNum, blockedNum]) {
      if (!r.valid) return res.status(400).json({ message: r.error });
    }

    const finalSku =
      sku ||
      (productDoc.partNumber
        ? String(productDoc.partNumber)
        : `TVS-${productDoc.productId || String(productDoc._id).slice(-6).toUpperCase()}`);

    const exists = await InventoryItem.findOne({ product, dealer, fulfillmentNode });
    if (exists) return res.status(409).json({ message: 'Inventory already exists for this product/dealer/node' });

    const inventory = await InventoryItem.create({
      product,
      dealer,
      fulfillmentNode,
      sku: finalSku,
      onHand: onHandNum.value,
      damaged: damagedNum.value,
      blocked: blockedNum.value,
      isActive: isActive !== false,
    });

    res.status(201).json({ inventory: withAvailableList([inventory.toObject()])[0] });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'Duplicate inventory' });
    res.status(500).json({ message: err.message });
  }
};

/* ── POST /api/inventory/migrate — run the inventory migration ──────── */
export const migrateInventory = async (req, res) => {
  try {
    console.log('🔄 Starting inventory migration...');
    const stats = await runMigration({ log: console });
    
    console.log('✅ Migration complete:', stats);
    res.json({
      message: 'Inventory migration completed successfully',
      stats,
    });
  } catch (err) {
    console.error('❌ Migration failed:', err);
    res.status(500).json({ message: err.message });
  }
};