const authService = require('./auth.service');

// Same response bodies as the reference backend (not wrapped in `data`).
const mobileVerify = async (req, res) => res.json(await authService.mobileVerify(req.body));

const googleLogin = async (req, res) => res.json(await authService.googleLogin(req.body));

const linkGoogle = async (req, res) => res.json(await authService.linkGoogle(req.user, req.body));

const me = async (req, res) => res.json(await authService.me(req.user, req.auth));

module.exports = { mobileVerify, googleLogin, linkGoogle, me };
