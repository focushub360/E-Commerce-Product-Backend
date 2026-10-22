import mongoose from 'mongoose';
import { withAvailableStock } from './productController.js';
import NotifyMe from '../models/NotifyMe.js';
import DealerNotification from '../models/DealerNotification.js';
import Product from '../models/Product.js';
import User from '../models/User.js';
import { sendWhatsAppMessage } from '../utils/whatsapp.js';


// --------------------------------------------------
// Common error response
// --------------------------------------------------
const sendError = (res, status, message) => {
    return res.status(status).json({
        success: false,
        message,
    });
};

// --------------------------------------------------
// 1. CUSTOMER CLICKS "NOTIFY ME"
// POST /api/notify-me
// Body: { productId }
// --------------------------------------------------
export const createNotifyMe = async (req, res) => {
    try {

        const { productId } = req.body;
        console.log('Notify Me request body:', req.body);
        console.log('Logged-in user:', req.user?.id);

        // Customer must be logged in.
        if (!req.user?.id) {
            return sendError(res, 401, 'Please login to continue.');
        }

        // Validate product ID.
        if (!productId || !mongoose.Types.ObjectId.isValid(productId)) {
            return sendError(res, 400, 'A valid product ID is required.');
        }

        // Find product.
        const product = await Product.findById(productId);

// console.log("=== PRODUCT DETAILS API ===");
// console.log("Database:", mongoose.connection.name);
// console.log("Host:", mongoose.connection.host);
// console.log("Product ID:", product?._id);
// console.log("Stock from database:", product?.stock);

        if (!product) {
            return sendError(res, 404, 'Product not found.');
        }

    const [productWithStock] = await withAvailableStock([
    product.toObject(),
]);

     const cleanStock = Number(productWithStock.stock);
    //  console.log('Product stock in Product collection:', product.stock);
    //  console.log('Actual available inventory stock:', cleanStock);

        // Notify Me is only for out-of-stock products.
        if (
    isNaN(cleanStock) ||
    !Number.isFinite(cleanStock) ||
    cleanStock < 0
) {
    return sendError(res, 400, 'Product stock is invalid.');
}

if (cleanStock > 0) {
    return sendError(res, 400, 'This product is already in stock.');
}

        // Find customer.
        const customer = await User.findById(req.user.id);

        if (!customer) {
            return sendError(res, 404, 'Customer not found.');
        }

        // Prevent dealers/admins from subscribing as customers.
        if (customer.role !== 'user') {
            return sendError(
                res,
                403,
                'Only customer accounts can subscribe to Notify Me.'
            );
        }

        // WhatsApp alerts require a phone number.
        if (!customer.phone) {
            return sendError(
                res,
                400,
                'Please add a phone number to your profile for WhatsApp alerts.'
            );
        }

        // Find the dealer assigned to the product.
        if (!product.dealer) {
            return sendError(
                res,
                400,
                'No dealer is assigned to this product.'
            );
        }

        const dealer = await User.findOne({
            _id: product.dealer,
            role: 'dealer',
        });

        if (!dealer) {
            return sendError(res, 404, 'Dealer not found.');
        }

        // Prevent duplicate active subscriptions.
        const existing = await NotifyMe.findOne({
            product: product._id,
            customer: customer._id,
            status: 'active',
        });

        if (existing) {
            return sendError(
                res,
                409,
                'You have already subscribed to this product.'
            );
        }

        // Save the customer's subscription.
        const subscription = await NotifyMe.create({
            product: product._id,
            productSnapshot: {
                name: product.title,
                price: product.price,
                image: product.image ?? null,
            },
            customer: customer._id,
            dealer: dealer._id,
            status: 'active',
        });

        // Create a restock-request alert for the dealer.
        try {
            await DealerNotification.create({
                dealer: dealer._id,
                product: product._id,
                customer: customer._id,
                message: `A customer wants ${product.title}. Please restock this product.`,
                type: 'restock_request',
            });
        } catch (alertError) {
            // The subscription was saved, so don't pretend
            // the entire request failed without recording it.
            console.error(
                'Dealer notification creation failed:',
                alertError
            );

            return res.status(201).json({
                success: true,
                message:
                    'Your Notify Me request was saved, but the dealer alert could not be created. Please try again later.',
                dealerAlertCreated: false,
                data: {
                    id: subscription._id,
                    product: subscription.productSnapshot,
                    status: subscription.status,
                    createdAt: subscription.createdAt,
                },
            });
        }

        return res.status(201).json({
            success: true,
            message: 'You will be notified when this product is back in stock.',
            dealerAlertCreated: true,
            data: {
                id: subscription._id,
                product: subscription.productSnapshot,
                status: subscription.status,
                createdAt: subscription.createdAt,
            },
        });
    } catch (error) {
        // MongoDB duplicate-key protection.
        if (error.code === 11000) {
            return sendError(
                res,
                409,
                'You have already subscribed to this product.'
            );
        }

        console.error('createNotifyMe error:', error);

        return sendError(
            res,
            500,
            'Failed to create notification subscription.'
        );
    }
};

// --------------------------------------------------
// 2. CUSTOMER CHECKS THEIR SUBSCRIPTIONS
// GET /api/notify-me/my
// --------------------------------------------------
export const getMyNotifications = async (req, res) => {
    try {
        const subscriptions = await NotifyMe.find({
            customer: req.user.id,
        })
            .select('product productSnapshot status notifiedAt createdAt')
            .sort({ createdAt: -1 })
            .lean();

        return res.status(200).json({
            success: true,
            count: subscriptions.length,
            data: subscriptions,
        });
    } catch (error) {
        console.error('getMyNotifications error:', error);

        return sendError(
            res,
            500,
            'Failed to fetch notifications.'
        );
    }
};

// --------------------------------------------------
// 3. CHECK IF CUSTOMER IS ALREADY SUBSCRIBED
// GET /api/notify-me/status/:productId
// --------------------------------------------------
export const getNotifyStatus = async (req, res) => {
    try {
        const { productId } = req.params;

        if (!mongoose.Types.ObjectId.isValid(productId)) {
            return sendError(res, 400, 'Invalid product ID.');
        }

        const subscription = await NotifyMe.findOne({
            product: productId,
            customer: req.user.id,
            status: 'active',
        })
            .select('_id status')
            .lean();

        return res.status(200).json({
           
            subscribed: Boolean(subscription),
                    });
    } catch (error) {
        console.error('getNotifyStatus error:', error);

        return sendError(
            res,
            500,
            'Failed to check notification status.'
        );
    }
};

// --------------------------------------------------
// 4. CUSTOMER CANCELS THEIR SUBSCRIPTION
// PATCH /api/notify-me/:id/cancel
// --------------------------------------------------
export const cancelNotifyMe = async (req, res) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return sendError(res, 400, 'Invalid subscription ID.');
        }

        // Customer can cancel only their own active subscription.
        const subscription = await NotifyMe.findOneAndUpdate(
            {
                _id: id,
                customer: req.user.id,
                status: 'active',
            },
            {
                $set: { status: 'cancelled' },
            },
            {
                new: true,
                runValidators: true,
            }
        );

        if (!subscription) {
            return sendError(
                res,
                404,
                'Active subscription not found.'
            );
        }

        return res.status(200).json({
            success: true,
            message: 'Notification cancelled.',
        });
    } catch (error) {
        console.error('cancelNotifyMe error:', error);

        return sendError(
            res,
            500,
            'Failed to cancel notification.'
        );
    }
};

// --------------------------------------------------
// 5. SEND WHATSAPP WHEN STOCK RETURNS
// Internal function; not an HTTP route.
// --------------------------------------------------

export const notifyBackInStock = async (product) => {
    try {
        // 1. Find the latest product data.
        const currentProduct = await Product.findById(product._id);

        if (!currentProduct) {
            console.log('Product not found. WhatsApp skipped.');
            return;
        }

        // 2. Calculate actual available stock from InventoryItem.
        const [productWithStock] = await withAvailableStock([
            currentProduct.toObject(),
        ]);

        const availableStock = Number(productWithStock?.stock);

        console.log('Product:', currentProduct.title);
        console.log('Available inventory stock:', availableStock);

        // 3. Stop if the product is still out of stock.
        if (!Number.isFinite(availableStock) || availableStock <= 0) {
            console.log('Product is out of stock. WhatsApp skipped.');
            return;
        }

        // 4. Find customers waiting for this product.
        const subscriptions = await NotifyMe.find({
            product: currentProduct._id,
            status: 'active',
        }).populate('customer', 'name phone');

        if (subscriptions.length === 0) {
            console.log('No active Notify Me subscriptions.');
            return;
        }

        console.log('Active subscriptions:', subscriptions.length);

        // 5. Send WhatsApp messages.
        for (const subscription of subscriptions) {
            try {
                const customer = subscription.customer;

                if (!customer?.phone) {
                    console.warn(
                        `Skipping ${subscription._id}: customer phone is missing.`
                    );
                    continue;
                }

                const productName =
                    subscription.productSnapshot?.name ||
                    currentProduct.title;

                const message =
                    `Hi ${customer.name || 'there'}, good news! ` +
                    `${productName} is back in stock. ` +
                    'Order now before it sells out.';

                // Send the message.
                const sid = await sendWhatsAppMessage(
                    customer.phone,
                    message
                );  

                console.log('WhatsApp message SID:', sid);

                // 6. Mark notified only after successful sending.
                subscription.status = 'notified';
                subscription.notifiedAt = new Date();

                await subscription.save();

            } catch (error) {
                console.error(
                    `WhatsApp failed for subscription ${subscription._id}:`,
                    error.message
                );
            }
        }
    } catch (error) {
        console.error('notifyBackInStock error:', error);
    }
};


// --------------------------------------------------
// 6. DEALER UPDATES PRODUCT STOCK
// PATCH /api/products/:id/stock
// Body: { stock: 10 }
// --------------------------------------------------
// export const updateProductStock = async (req, res) => {
//     try {
//         const { id } = req.params;
//         const { stock } = req.body;

//         if (!mongoose.Types.ObjectId.isValid(id)) {
//             return sendError(res, 400, 'Invalid product ID.');
//         }

//         if (!Number.isInteger(stock) || stock < 0) {
//             return sendError(
//                 res,
//                 400,
//                 'Stock must be a whole number, 0 or more.'
//             );
//         }

//         if (!req.user?.id) {
//             return sendError(res, 401, 'Please login to continue.');
//         }

//         // Product schema uses "dealer", not "dealerId".
//         // Only the product's assigned dealer can update stock.
//         const before = await Product.findOneAndUpdate(
//             {
//                 _id: id,
//                 dealer: req.user.id,
//             },
//             {
//                 $set: { stock },
//             },
//             {
//                 new: false,
//                 runValidators: true,
//             }
//         );

//         if (!before) {
//             return sendError(
//                 res,
//                 404,
//                 'Product not found or you do not own this product.'
//             );
//         }

//         const wasOutOfStock = before.stock <= 0;
//         const isNowInStock = stock > 0;

//         // Fetch the updated product for the notification function.
//         const updatedProduct = await Product.findById(id);

//         // Trigger WhatsApp only on an out-of-stock -> in-stock transition.
//         if (wasOutOfStock && isNowInStock && updatedProduct) {
//             notifyBackInStock(updatedProduct).catch((error) => {
//                 console.error(
//                     'notifyBackInStock failed:',
//                     error
//                 );
//             });
//         }

//         return res.status(200).json({
//             success: true,
//             message: 'Stock updated.',
//             data: {
//                 id: updatedProduct?._id,
//                 stock: updatedProduct?.stock,
//             },
//         });
//     } catch (error) {
//         console.error('updateProductStock error:', error);

//         return sendError(
//             res,
//             500,
//             'Failed to update stock.'
//         );
//     }
// };
