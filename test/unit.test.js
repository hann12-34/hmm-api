const { test } = require('node:test');
const assert = require('node:assert');

const { canAccessOrder, workerCanAct } = require('../src/orderAccess');
const { billAmountForUser, lockedPricesFromConfig, enrichUserPublic, DEFAULTS } = require('../src/pricing');
const { isStaffRole, requireRole } = require('../src/auth');

test('canAccessOrder: staff can access any order', () => {
  assert.equal(canAccessOrder({ role: 'admin', uid: 'a' }, { customerUID: 'x' }), true);
  assert.equal(canAccessOrder({ role: 'manager', uid: 'm' }, { customerUID: 'x' }), true);
});

test('canAccessOrder: customer only own order', () => {
  assert.equal(canAccessOrder({ role: 'customer', uid: 'c1' }, { customerUID: 'c1' }), true);
  assert.equal(canAccessOrder({ role: 'customer', uid: 'c1' }, { customerUID: 'c2' }), false);
});

test('canAccessOrder: worker sees assigned or unassigned only', () => {
  assert.equal(canAccessOrder({ role: 'worker', uid: 'w1' }, { assignedWorkerUID: 'w1' }), true);
  assert.equal(canAccessOrder({ role: 'worker', uid: 'w1' }, { assignedWorkerUID: null }), true);
  assert.equal(canAccessOrder({ role: 'worker', uid: 'w1' }, { assignedWorkerUID: 'w2' }), false);
});

test('canAccessOrder: guards against missing args', () => {
  assert.equal(canAccessOrder(null, { customerUID: 'x' }), false);
  assert.equal(canAccessOrder({ role: 'admin' }, null), false);
});

test('workerCanAct: only workers, only their jobs', () => {
  assert.equal(workerCanAct({ role: 'admin', uid: 'a' }, { assignedWorkerUID: 'a' }), false);
  assert.equal(workerCanAct({ role: 'worker', uid: 'w1' }, { assignedWorkerUID: 'w1' }), true);
  assert.equal(workerCanAct({ role: 'worker', uid: 'w1' }, { assignedWorkerUID: 'w2' }), false);
  assert.equal(workerCanAct({ role: 'worker', uid: 'w1' }, { assignedWorkerUID: null }), true);
});

test('isStaffRole distinguishes staff from others', () => {
  assert.equal(isStaffRole('admin'), true);
  assert.equal(isStaffRole('manager'), true);
  assert.equal(isStaffRole('worker'), false);
  assert.equal(isStaffRole('customer'), false);
});

test('billAmountForUser uses locked prices, falls back to defaults', () => {
  const u = { lockedMonthlyPrice: 79, lockedAnnualPrice: 790 };
  assert.equal(billAmountForUser(u, 'monthly'), 79);
  assert.equal(billAmountForUser(u, 'annual'), 790);
  assert.equal(billAmountForUser({}, 'monthly'), DEFAULTS.monthlyPriceNew);
  assert.equal(billAmountForUser({}, 'annual'), DEFAULTS.annualPriceNew);
});

test('lockedPricesFromConfig maps config to locked fields', () => {
  const l = lockedPricesFromConfig({ monthlyPriceNew: 99, annualPriceNew: 990, signupFee: 99 });
  assert.equal(l.lockedMonthlyPrice, 99);
  assert.equal(l.lockedAnnualPrice, 990);
  assert.equal(l.signupFeeAmount, 99);
  assert.ok(l.pricingLockedAt instanceof Date);
});

test('enrichUserPublic sets planAmount from plan', () => {
  const monthly = enrichUserPublic({ subscriptionPlan: 'monthly', lockedMonthlyPrice: 60, lockedAnnualPrice: 600 });
  assert.equal(monthly.planAmount, 60);
  const annual = enrichUserPublic({ subscriptionPlan: 'annual', lockedMonthlyPrice: 60, lockedAnnualPrice: 600 });
  assert.equal(annual.planAmount, 600);
});

test('requireRole allows matching roles and blocks others', () => {
  const mw = requireRole('admin', 'manager');
  const makeRes = () => {
    const res = { statusCode: null, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
  };

  let nexted = false;
  mw({ user: { role: 'manager' } }, makeRes(), () => { nexted = true; });
  assert.equal(nexted, true);

  nexted = false;
  const res = makeRes();
  mw({ user: { role: 'worker' } }, res, () => { nexted = true; });
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 403);
});
