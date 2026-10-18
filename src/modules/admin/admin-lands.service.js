const { prisma } = require('../../database/prisma');
const { paginationMeta } = require('../../utils/response');

const LAND_STATUSES = ['PENDING', 'VERIFIED', 'UNCHANGED', 'CHANGED', 'FAILED'];

const userView = (user) => (user ? { id: user.id, name: user.name, email: user.email, phone: user.mobile } : null);

const landRow = (land, record) => ({
  id: land.id,
  displayName: land.displayName,
  state: land.stateCode,
  provider: land.provider,
  status: land.status,
  locator: land.locator,
  verificationCount: land.verificationCount,
  changeCount: land.changeCount,
  firstVerifiedAt: land.firstVerifiedAt,
  lastVerifiedAt: land.lastVerifiedAt,
  lastError: land.lastErrorCode ? { code: land.lastErrorCode, message: land.lastErrorMessage } : null,
  monitoring: { enabled: land.monitoringEnabled, frequency: land.verificationFrequency, nextVerificationAt: land.nextVerificationAt },
  record: record || null, // latest stored land record (normalized provider data), if any
  user: userView(land.user),
  createdAt: land.createdAt,
});

const listLands = async ({ page, limit, skip, status, search }) => {
  const where = {
    ...(status ? { status } : {}),
    ...(search
      ? {
          OR: [
            { displayName: { contains: search, mode: 'insensitive' } },
            { stateCode: { contains: search, mode: 'insensitive' } },
            { user: { is: { name: { contains: search, mode: 'insensitive' } } } },
            { user: { is: { email: { contains: search, mode: 'insensitive' } } } },
            { user: { is: { mobile: { contains: search } } } },
          ],
        }
      : {}),
  };

  const [total, lands] = await Promise.all([
    prisma.landVerification.count({ where }),
    prisma.landVerification.findMany({
      relationLoadStrategy: 'join',
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: { user: { select: { id: true, name: true, email: true, mobile: true } } },
    }),
  ]);

  const snapshotIds = lands.map((land) => land.latestSnapshotId).filter(Boolean);
  const snapshots = snapshotIds.length
    ? await prisma.landRecordSnapshot.findMany({ where: { id: { in: snapshotIds } }, select: { id: true, normalizedData: true } })
    : [];
  const recordById = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot.normalizedData]));

  return { lands: lands.map((land) => landRow(land, recordById.get(land.latestSnapshotId))), meta: paginationMeta({ page, limit }, total) };
};

const getLandSummary = async () => {
  const groups = await prisma.landVerification.groupBy({ by: ['status'], _count: { _all: true } });
  const counts = Object.fromEntries(LAND_STATUSES.map((status) => [status, 0]));
  let total = 0;
  for (const group of groups) {
    counts[group.status] = group._count._all;
    total += group._count._all;
  }
  return { total, counts };
};

module.exports = { listLands, getLandSummary, LAND_STATUSES };
