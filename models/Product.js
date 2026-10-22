import mongoose from 'mongoose';

const reviewSchema = new mongoose.Schema(
  {
    user:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name:    { type: String, required: true },
    rating:  { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, default: '' },
  },
  { timestamps: true }
);

const productSchema = new mongoose.Schema(
  {
    // Ownership
    dealer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    // ── FIX: sparse:true so multiple docs can omit it without colliding,
    //         and we auto-generate it in the pre-save hook below.
    productId:     { type: Number, unique: true, sparse: true },

    brand:         { type: String, default: 'TVS' },
    model:         String,
    title:         { type: String, required: true },
    price:         { type: Number, required: true },
    originalPrice: Number,
    currency:      { type: String, default: 'INR' },

    rating:     { type: Number, default: 0 },
    numReviews: { type: Number, default: 0 },
    reviews:    [reviewSchema],

    stock:      { type: Number, default: 0,required: true },
    color:      String,
    material:   String,
    partNumber: String,

    availableInIndia: { type: Boolean, default: true },

    category:    { type: String, required: true },
    subCategory: { type: String, default: '' },

    description:   String,
    features:      [String],
    images:        [String],
    image:         String,
    discount:      { type: Number, default: 0 },
    isFeatured:    { type: Boolean, default: false },
    tags:          [String],
    compatibility: [String],

    viewCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// ── Auto-generate productId if not supplied ───────────────────────────
// Finds the highest existing productId and increments by 1.
// Runs only on new documents (isNew) to avoid overwriting on updates.
productSchema.pre('save', async function (next) {
  if (!this.isNew || this.productId) return next(); // already set, skip
  try {
    const last = await mongoose.model('Product')
      .findOne({ productId: { $ne: null } })
      .sort({ productId: -1 })
      .select('productId')
      .lean();
    this.productId = last ? last.productId + 1 : 1000; // start at 1000
    next();
  } catch (err) {
    next(err);
  }
});

// ── Text index for search ─────────────────────────────────────────────
productSchema.index({
  title:       'text',
  brand:       'text',
  category:    'text',
  tags:        'text',
  subCategory: 'text',
});

const Product = mongoose.model('Product', productSchema);
export default Product;