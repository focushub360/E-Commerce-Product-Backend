
import DealerNotification from '../models/DealerNotification.js';

// Get notifications for the logged-in dealer
export const getDealerNotifications = async (req, res) => {
  try {
    const dealerId = req.user.id || req.user._id;

    if (!dealerId) {
      return res.status(401).json({
        message: 'Please log in to continue.',
      });
    }

    const notifications = await DealerNotification.find({
      dealer: dealerId,
      isResolved: false,
    })
      .populate('product', 'title name image')
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      count: notifications.length,
      notifications,
    });
  } catch (error) {
    console.error('Get dealer notifications error:', error);

    return res.status(500).json({
      message: 'Failed to fetch dealer notifications.',
    });
  }
};
