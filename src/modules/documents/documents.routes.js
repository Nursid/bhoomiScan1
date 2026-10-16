const { Router } = require('express');
const { z } = require('zod');
const { AppError, badRequest } = require('../../utils/errors');
const { authenticate } = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { created, ok } = require('../../utils/response');
const service = require('./documents.service');

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MIME_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);

const validateFileType = (req, res, next) => {
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!MIME_TYPES.has(contentType)) throw new AppError(415, 'UNSUPPORTED_FILE_TYPE', 'Upload a PDF, JPEG, PNG, or WebP file');
  req.uploadContentType = contentType;
  next();
};

const parseFile = require('express').raw({ type: (req) => MIME_TYPES.has(req.uploadContentType), limit: MAX_FILE_BYTES });

const fileDetails = (req) => {
  const bytes = req.body;
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw badRequest('Uploaded file is empty', undefined, 'EMPTY_FILE');
  const type = req.uploadContentType;
  const valid = type === 'application/pdf'
    ? bytes.subarray(0, 5).toString('ascii') === '%PDF-'
    : type === 'image/jpeg'
      ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : type === 'image/png'
        ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!valid) throw badRequest('File content does not match its declared type', undefined, 'FILE_TYPE_MISMATCH');

  const suppliedName = String(req.headers['x-file-name'] || '').replace(/[\u0000-\u001f\u007f]/g, '').split(/[\\/]/).pop().trim();
  if (suppliedName.length > 255) throw badRequest('File name must be 255 characters or fewer', undefined, 'INVALID_FILE_NAME');
  const extension = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[type];
  return { bytes, contentType: type, fileName: suppliedName || `upload.${extension}` };
};

const router = Router();
router.use(authenticate);

router.post('/', validateFileType, parseFile, async (req, res) =>
  created(res, { document: await service.register(req.user.id, fileDetails(req)) }),
);
router.post('/:id/versions', validate({ params: z.object({ id: z.string().uuid('Invalid document id') }) }), validateFileType, parseFile, async (req, res) =>
  created(res, { document: await service.registerVersion(req.user.id, req.params.id, fileDetails(req)) }),
);
router.post('/verify', validateFileType, parseFile, async (req, res) =>
  ok(res, await service.verifyBytes(fileDetails(req).bytes)),
);
router.get('/', async (req, res) => ok(res, { documents: await service.list(req.user.id) }));
router.get('/:id/file', validate({ params: z.object({ id: z.string().uuid('Invalid document id') }) }), async (req, res) => {
  const file = await service.retrieveFile(req.user.id, req.params.id);
  res.set({
    'Content-Type': file.contentType,
    'Content-Length': String(file.sizeBytes),
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.status(200).send(file.bytes);
});
router.get('/:id/versions', validate({ params: z.object({ id: z.string().uuid('Invalid document id') }) }), async (req, res) =>
  ok(res, { versions: await service.listVersions(req.user.id, req.params.id) }),
);
router.get('/:id/verify', validate({ params: z.object({ id: z.string().uuid('Invalid document id') }) }), async (req, res) =>
  ok(res, await service.verify(req.user.id, req.params.id)),
);

module.exports = { router, __testing: { validateFileType, fileDetails, MAX_FILE_BYTES } };
