const service = require('./payments.service');
const { ok, created } = require('../../utils/response');

const create = async (req, res) => created(res, await service.createPayment(req.user.id, req.body.subscriptionId));

const verify = async (req, res) => ok(res, await service.verifyPayment(req.user.id, req.body));

// Razorpay only needs a 2xx; failures return non-2xx so Razorpay retries.
const webhook = async (req, res) => ok(res, await service.handleWebhook(req.rawBody, req.headers, req.body));

const list = async (req, res) => ok(res, { payments: await service.listPayments(req.user.id) });

module.exports = { create, verify, webhook, list };
