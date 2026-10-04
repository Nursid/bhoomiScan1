const authService = require('./auth.service');

// Same response bodies as the reference backend (not wrapped in `data`).
const mobileVerify = async (req, res) => res.json(await authService.mobileVerify(req.body));

const me = async (req, res) => res.json(await authService.me(req.user, req.auth));

module.exports = { mobileVerify, me };
