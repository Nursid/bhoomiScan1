/**
 * Seeds subscription plans (idempotent upsert by code). Amounts are in paise.
 *
 * Both plans give 12 months of access; they differ in how often a parcel is
 * re-checked automatically (allowedFrequencies):
 *   monthly  ₹999 / year   monthly checks
 *   weekly   ₹1499 / year  weekly (or monthly) checks
 *
 * Plans not listed here are deactivated, never deleted: past subscriptions keep
 * pointing at them, but they can no longer be bought.
 */

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const FEATURES = {
  recurringVerification: true,
  changeAlerts: true,
  smartContractAnchoring: true,
};

const PLANS = [
  {
    code: 'monthly',
    name: 'Monthly',
    description: 'One year of land verification with monthly automatic checks.',
    amount: 99900, // ₹999 in paise
    currency: 'INR',
    interval: 'YEARLY',
    durationMonths: 12,
    allowedFrequencies: ['MONTHLY'],
    maxMonitoredLands: 5,
    sortOrder: 1,
    isActive: true,
    features: FEATURES,
  },
  {
    code: 'weekly',
    name: 'Weekly',
    description: 'One year of land verification with weekly automatic checks.',
    amount: 149900, // ₹1499 in paise
    currency: 'INR',
    interval: 'YEARLY',
    durationMonths: 12,
    allowedFrequencies: ['WEEKLY', 'MONTHLY'],
    maxMonitoredLands: 20,
    sortOrder: 2,
    isActive: true,
    features: FEATURES,
  },
];

const main = async () => {
  for (const plan of PLANS) {
    await prisma.subscriptionPlan.upsert({ where: { code: plan.code }, create: plan, update: plan });
  }
  const { count: retired } = await prisma.subscriptionPlan.updateMany({
    where: { code: { notIn: PLANS.map((plan) => plan.code) }, isActive: true },
    data: { isActive: false },
  });
  console.log(`Seeded ${PLANS.length} subscription plans${retired ? `, deactivated ${retired} old plan(s)` : ''}`);
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
