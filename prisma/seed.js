/**
 * Seeds subscription plans (idempotent upsert by code).
 * Prices mirror the reference project's defaults (monthly 591, quarterly 1599 INR),
 * stored in paise.
 */

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const PLANS = [
  {
    code: 'monthly',
    name: 'Monthly',
    description: 'Land verification with recurring monitoring, billed monthly.',
    amount: 59100,
    currency: 'INR',
    interval: 'MONTHLY',
    durationMonths: 1,
    allowedFrequencies: ['WEEKLY', 'MONTHLY'],
    maxMonitoredLands: 5,
    sortOrder: 1,
    features: { recurringVerification: true, changeAlerts: true, smartContractAnchoring: true },
  },
  {
    code: 'quarterly',
    name: 'Quarterly',
    description: 'Land verification with recurring monitoring, billed every 3 months.',
    amount: 159900,
    currency: 'INR',
    interval: 'QUARTERLY',
    durationMonths: 3,
    allowedFrequencies: ['WEEKLY', 'MONTHLY', 'QUARTERLY'],
    maxMonitoredLands: 20,
    sortOrder: 2,
    features: { recurringVerification: true, changeAlerts: true, smartContractAnchoring: true },
  },
];

const main = async () => {
  for (const plan of PLANS) {
    await prisma.subscriptionPlan.upsert({ where: { code: plan.code }, create: plan, update: plan });
  }
  console.log(`Seeded ${PLANS.length} subscription plans`);
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
