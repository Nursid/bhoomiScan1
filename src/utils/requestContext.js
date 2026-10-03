/**
 * Per-request context (request id, user id) available anywhere in the call chain
 * without threading it through every function: outbound call audit logs use it
 * to link provider calls to the inbound request and user.
 */

const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

const run = (context, fn) => storage.run({ ...context }, fn);
const get = () => storage.getStore() || {};
const set = (patch) => {
  const store = storage.getStore();
  if (store) {
    Object.assign(store, patch);
  }
};

module.exports = { run, get, set };
