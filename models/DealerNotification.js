
import mongoose from 'mongoose';

const dealerNotificationSchema = new mongoose.Schema(
  {
    dealer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },

    // Customer is present for Notify Me requests.
    // Automatic out-of-stock alerts don't need a customer.
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    message: {
      type: String,
      required: true,
    },

    type: {
      type: String,
      enum: ['restock_request', 'out_of_stock'],
      default: 'restock_request',
    },

    isRead: {
      type: Boolean,
      default: false,
    },

    // Track whether the stock alert has been resolved.
    isResolved: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

dealerNotificationSchema.index({
  dealer: 1,
  isRead: 1,
  createdAt: -1,
});

dealerNotificationSchema.index({
  dealer: 1,
  product: 1,
  type: 1,
  isResolved: 1,
});

export default mongoose.model(
  'DealerNotification',
  dealerNotificationSchema
);
