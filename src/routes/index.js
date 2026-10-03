/** /api/v1 router. */

const { Router } = require('express');
const authRoutes = require('../modules/auth/auth.routes');
const usersRoutes = require('../modules/users/users.routes');
const { plansRouter, subscriptionsRouter } = require('../modules/subscriptions/subscriptions.routes');
const paymentsRoutes = require('../modules/payments/payments.routes');
const landVerificationRoutes = require('../modules/land-verification/land-verification.routes');
const smartContractRoutes = require('../modules/smart-contract/smart-contract.routes');
const alertsRoutes = require('../modules/alerts/alerts.routes');

const router = Router();

router.use('/auth', authRoutes);
router.use('/users', usersRoutes);
router.use('/plans', plansRouter);
router.use('/subscriptions', subscriptionsRouter);
router.use('/payments', paymentsRoutes);
router.use('/land-verification', landVerificationRoutes);
router.use('/smart-contract', smartContractRoutes);
router.use('/alerts', alertsRoutes);

module.exports = router;
