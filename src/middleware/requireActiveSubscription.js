/**
 * Gate for paid functionality. The subscription must be ACTIVE and inside its
 * paid window (startsAt <= now < endsAt); the status alone is not trusted, so an
 * expiry job running late can never extend access. Sets req.subscription.
 */

const subscriptionsService = require('../modules/subscriptions/subscriptions.service');
const { forbidden } = require('../utils/errors');

const requireActiveSubscription = async (req, res, next) => {
  const subscription = await subscriptionsService.findActiveSubscription(req.user.id);
  if (!subscription) {
    throw forbidden('An active subscription is required for this feature', 'SUBSCRIPTION_REQUIRED');
  }
  req.subscription = subscription;
  next();
};

module.exports = requireActiveSubscription;
