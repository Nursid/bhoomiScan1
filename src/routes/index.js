/** /api/v1 router. */

const { Router } = require('express');
const usersRoutes = require('../modules/users/users.routes');
const { plansRouter, subscriptionsRouter } = require('../modules/subscriptions/subscriptions.routes');
const paymentsRoutes = require('../modules/payments/payments.routes');
const landVerificationRoutes = require('../modules/land-verification/land-verification.routes');
const smartContractRoutes = require('../modules/smart-contract/smart-contract.routes');
const alertsRoutes = require('../modules/alerts/alerts.routes');
const adminRoutes = require('../modules/admin/admin.routes');
const documentsRoutes = require('../modules/documents/documents.routes').router;

const router = Router();

router.use('/users', usersRoutes);
router.use('/plans', plansRouter);
router.use('/subscriptions', subscriptionsRouter);
router.use('/payments', paymentsRoutes);
router.use('/land-verification', landVerificationRoutes);
router.use('/smart-contract', smartContractRoutes);
router.use('/documents', documentsRoutes);
router.use('/alerts', alertsRoutes);
router.use('/admin', adminRoutes);

module.exports = router;
