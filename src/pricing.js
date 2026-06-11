const { PricingConfig, User } = require('./models');

const DEFAULTS = {
  signupFee: 99,
  monthlyPriceNew: 99,
  annualPriceNew: 990,
};

async function getPricingConfig() {
  let doc = await PricingConfig.findOne({ key: 'default' });
  if (!doc) {
    doc = await PricingConfig.create({ key: 'default', ...DEFAULTS });
  }
  return {
    signupFee: doc.signupFee,
    monthlyPriceNew: doc.monthlyPriceNew,
    annualPriceNew: doc.annualPriceNew,
    updatedAt: doc.updatedAt,
  };
}

async function updatePricingConfig(updates) {
  const allowed = ['signupFee', 'monthlyPriceNew', 'annualPriceNew'];
  const patch = {};
  for (const k of allowed) {
    if (updates[k] !== undefined) patch[k] = Number(updates[k]);
  }
  const doc = await PricingConfig.findOneAndUpdate(
    { key: 'default' },
    { $set: patch },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return {
    signupFee: doc.signupFee,
    monthlyPriceNew: doc.monthlyPriceNew,
    annualPriceNew: doc.annualPriceNew,
    updatedAt: doc.updatedAt,
  };
}

/** Prices locked at signup — never change when admin raises "new" prices. */
function lockedPricesFromConfig(config) {
  return {
    lockedMonthlyPrice: config.monthlyPriceNew,
    lockedAnnualPrice: config.annualPriceNew,
    signupFeeAmount: config.signupFee,
    pricingLockedAt: new Date(),
  };
}

function billAmountForUser(user, plan) {
  const monthly = user.lockedMonthlyPrice ?? DEFAULTS.monthlyPriceNew;
  const annual = user.lockedAnnualPrice ?? DEFAULTS.annualPriceNew;
  return plan === 'annual' ? annual : monthly;
}

function enrichUserPublic(userObj) {
  const monthly = userObj.lockedMonthlyPrice ?? DEFAULTS.monthlyPriceNew;
  const annual = userObj.lockedAnnualPrice ?? DEFAULTS.annualPriceNew;
  const plan = userObj.subscriptionPlan || 'monthly';
  userObj.lockedMonthlyPrice = monthly;
  userObj.lockedAnnualPrice = annual;
  userObj.planAmount = plan === 'annual' ? annual : monthly;
  userObj.signupFeePaid = userObj.signupFeePaid ?? false;
  userObj.signupFeeAmount = userObj.signupFeeAmount ?? 0;
  return userObj;
}

/** Backfill existing customers without locked prices. */
async function migrateLegacyPricing() {
  const config = await getPricingConfig();
  await User.updateMany(
    { role: 'customer', lockedMonthlyPrice: { $exists: false } },
    {
      $set: {
        lockedMonthlyPrice: DEFAULTS.monthlyPriceNew,
        lockedAnnualPrice: DEFAULTS.annualPriceNew,
        signupFeePaid: true,
        signupFeeAmount: DEFAULTS.signupFee,
        pricingLockedAt: new Date(),
      },
    }
  );
}

module.exports = {
  DEFAULTS,
  getPricingConfig,
  updatePricingConfig,
  lockedPricesFromConfig,
  billAmountForUser,
  enrichUserPublic,
  migrateLegacyPricing,
};
