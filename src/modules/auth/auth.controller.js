const authService = require('./auth.service');
const { ok } = require('../../utils/response');

const sendOtp = async (req, res) => ok(res, await authService.sendOtp(req.body.mobile));

const verifyOtp = async (req, res) => ok(res, await authService.verifyOtp(req.body));

module.exports = { sendOtp, verifyOtp };
