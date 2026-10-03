/**
 * Zod request validation. Replaces req.body / req.params / req.query with the
 * parsed (trimmed, coerced) values so controllers only ever see validated input.
 *
 *   router.post('/x', validate({ body: schema }), controller.x)
 */

const { AppError } = require('../utils/errors');

const formatIssues = (issues, location) =>
  issues.map((issue) => ({
    location,
    field: issue.path.join('.') || location,
    message: issue.message,
  }));

const validate = (schemas) => (req, res, next) => {
  const errors = [];
  for (const location of ['params', 'query', 'body']) {
    const schema = schemas[location];
    if (!schema) continue;
    const result = schema.safeParse(req[location] ?? {});
    if (result.success) {
      // Express 5 exposes req.query as a getter; redefine it to hold parsed values.
      Object.defineProperty(req, location, { value: result.data, writable: true, configurable: true, enumerable: true });
    } else {
      errors.push(...formatIssues(result.error.issues, location));
    }
  }
  if (errors.length > 0) {
    throw new AppError(422, 'VALIDATION_FAILED', 'Request validation failed', { details: errors });
  }
  next();
};

module.exports = validate;
