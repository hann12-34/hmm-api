/**
 * Seed test accounts into hmm_maintenance (or your MONGODB_URI database).
 * Usage: MONGODB_URI="mongodb+srv://..." node scripts/seed.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { User, ServiceType } = require('../src/models');
const { DEFAULTS } = require('../src/pricing');

const ACCOUNTS = [
  { email: 'admin@hmm.com', password: 'hmm123', name: 'Admin', role: 'admin' },
  { email: 'manager@hmm.com', password: 'hmm123', name: 'Manager', role: 'manager' },
  { email: 'worker@hmm.com', password: 'hmm123', name: 'Worker', role: 'worker' },
  { email: 'client@hmm.com', password: 'hmm123', name: 'Client', role: 'customer',
    unitNumber: '101', address: '123 Main St, Burnaby', region: 'Lougheed' },
];

const DEFAULT_SERVICES = [
  { name: 'HVAC Filter', price: 49, sortOrder: 1 },
  { name: 'Plumbing Check', price: 79, sortOrder: 2 },
  { name: 'Electrical Safety', price: 99, sortOrder: 3 },
];

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('Set MONGODB_URI in .env or environment');
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log('Connected to MongoDB');

  for (const acct of ACCOUNTS) {
    const existing = await User.findOne({ email: acct.email });
    if (existing) {
      console.log(`Skip (exists): ${acct.email}`);
      continue;
    }
    const uid = crypto.randomUUID();
    await User.create({
      uid,
      email: acct.email,
      passwordHash: await bcrypt.hash(acct.password, 10),
      name: acct.name,
      role: acct.role,
      unitNumber: acct.unitNumber || '',
      address: acct.address || '',
      region: acct.region || '',
      subscriptionStatus: 'active',
      subscriptionPlan: 'monthly',
      renewalDate: acct.role === 'customer' ? new Date(Date.now() + 30 * 86400000) : null,
      signupFeePaid: acct.role === 'customer',
      signupFeeAmount: acct.role === 'customer' ? DEFAULTS.signupFee : 0,
      lockedMonthlyPrice: acct.role === 'customer' ? DEFAULTS.monthlyPriceNew : undefined,
      lockedAnnualPrice: acct.role === 'customer' ? DEFAULTS.annualPriceNew : undefined,
      pricingLockedAt: acct.role === 'customer' ? new Date() : undefined,
    });
    console.log(`Created: ${acct.email} (${acct.role})`);
  }

  for (const svc of DEFAULT_SERVICES) {
    await ServiceType.updateOne({ name: svc.name }, svc, { upsert: true });
  }
  console.log('Service types seeded');
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
