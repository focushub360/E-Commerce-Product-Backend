import mongoose from 'mongoose';

const notifyMeSchema = new mongoose.Schema(
  {
    // Which product the customer is waiting for
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },

    // Small copy of product info, only for display/history
    productSnapshot: {
      name: { type: String, required: true, trim: true },
      price: { type: Number, required: true, min: 0 },
      image: { type: String, default: null },
    },

    // Who is waiting (phone is read from User when sending)
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    // Which dealer owns the product (just the ID)
    dealer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    // active = waiting, notified = message sent, cancelled = customer gave up
    status: {
      type: String,
      enum: ['active', 'notified', 'cancelled'],
      default: 'active',
    },

    // When the WhatsApp message was sent
    notifiedAt: {
      
        type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// Stops duplicate ACTIVE subscriptions, even if the user double-clicks
notifyMeSchema.index(
  { product: 1, customer: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } }
);

// Fast lookup: "all active subscribers for product X" (used when stock returns)
notifyMeSchema.index({ product: 1, status: 1 });

// Fast lookup: "all subscriptions of this customer"
notifyMeSchema.index({ customer: 1 });

// Fast lookup: "all active subscriptions for this dealer"
notifyMeSchema.index({ dealer: 1, status: 1 }); 

export default mongoose.model('NotifyMe', notifyMeSchema);