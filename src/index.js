require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { User, WorkOrder, Payment, ServiceType, AppNotification, orderToJSON } = require('./models');
const { signToken, authMiddleware, requireRole } = require('./auth');
const {
  getPricingConfig,
  updatePricingConfig,
  lockedPricesFromConfig,
  billAmountForUser,
  migrateLegacyPricing,
} = require('./pricing');
const {
  onVisitRequested,
  onVisitConfirmed,
  onRedoCreated,
  notificationToJSON,
} = require('./appNotify');

const PORT = process.env.PORT || 3001;
const app = express();

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '15mb' }));

// ── Admin web (static) ──────────────────────────────────────────────
const adminDir = path.join(__dirname, '../public/admin');
app.use('/admin', express.static(adminDir));
app.get('/admin', (_, res) => res.sendFile(path.join(adminDir, 'index.html')));

// ── Health ──────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true, service: 'hmm-api' }));

// ── Auth ────────────────────────────────────────────────────────────
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password, name, unitNumber, address, phoneNumber } = req.body;
    if (!email || !password || password.length < 6) {
      return res.status(400).json({ error: 'Email and password (6+ chars) required' });
    }
    if (await User.findOne({ email: email.toLowerCase() })) {
      return res.status(409).json({ error: 'Email already in use' });
    }
    const uid = crypto.randomUUID();
    const userRole = 'customer';
    const plan = 'monthly';
    const renewal = new Date();
    renewal.setMonth(renewal.getMonth() + 1);
    const pricing = await getPricingConfig();
    const locked = userRole === 'customer' ? lockedPricesFromConfig(pricing) : {};
    const user = await User.create({
      uid,
      email: email.toLowerCase(),
      passwordHash: await bcrypt.hash(password, 10),
      name: name || email.split('@')[0],
      role: userRole,
      unitNumber: unitNumber || '',
      address: address || '',
      phoneNumber: phoneNumber || '',
      subscriptionStatus: 'active',
      subscriptionPlan: plan,
      renewalDate: userRole === 'customer' ? renewal : null,
      signupFeePaid: userRole === 'customer',
      ...locked,
    });
    if (userRole === 'customer') {
      await Payment.create({
        customerUID: uid,
        amount: pricing.signupFee,
        plan: 'signup_fee',
        status: 'paid',
        note: 'One-time signup fee',
      });
      await Payment.create({
        customerUID: uid,
        amount: locked.lockedMonthlyPrice,
        plan: 'monthly',
        status: 'paid',
        note: `First month (locked rate $${locked.lockedMonthlyPrice}/mo)`,
      });
    }
    const token = signToken(user);
    res.json({ token, user: user.toPublic() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email: email?.toLowerCase() });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    res.json({ token: signToken(user), user: user.toPublic() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  const user = await User.findOne({ uid: req.user.uid });
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: user.toPublic() });
});

// ── Pricing (public for signup screen) ─────────────────────────────
app.get('/api/pricing', async (_, res) => {
  res.json(await getPricingConfig());
});

// ── Services (catalog) ────────────────────────────────────────────
app.get('/api/services', authMiddleware, async (_, res) => {
  const items = await ServiceType.find().sort({ sortOrder: 1 });
  res.json(items.map(s => ({ id: s._id.toString(), name: s.name, price: s.price, sortOrder: s.sortOrder })));
});

// ── Payments ──────────────────────────────────────────────────────
app.get('/api/payments', authMiddleware, async (req, res) => {
  const uid = req.user.role === 'admin' ? req.query.customerUID : req.user.uid;
  if (!uid) return res.status(400).json({ error: 'customerUID required' });
  const items = await Payment.find({ customerUID: uid }).sort({ date: -1 });
  res.json(items.map(p => ({ id: p._id.toString(), ...p.toObject(), _id: undefined, __v: undefined })));
});

// ── Orders: list ────────────────────────────────────────────────────
app.get('/api/orders', authMiddleware, async (req, res) => {
  let query = {};
  if (req.user.role === 'customer') query.customerUID = req.user.uid;
  else if (req.user.role === 'worker') query.assignedWorkerUID = req.user.uid;
  // admin: all orders
  const orders = await WorkOrder.find(query).sort({ scheduledDate: -1 });
  const mapped = orders.map(orderToJSON);
  if (req.user.role === 'customer') {
    mapped.forEach(o => { o.adminNote = ''; o.workerNote = ''; o.workerNotes = []; });
  }
  res.json(mapped);
});

app.get('/api/orders/:id', authMiddleware, async (req, res) => {
  const order = await WorkOrder.findById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  const o = orderToJSON(order);
  if (req.user.role === 'customer') {
    o.adminNote = '';
    o.workerNote = '';
    o.workerNotes = [];
  }
  res.json(o);
});

// ── Customer: request visit ───────────────────────────────────────
app.post('/api/orders', authMiddleware, requireRole('customer', 'admin'), async (req, res) => {
  const body = req.body;
  const customerUID = req.user.role === 'admin' ? body.customerUID : req.user.uid;
  const customer = await User.findOne({ uid: customerUID });
  const slots = body.preferredDates?.length ? body.preferredDates.map(d => new Date(d)) : [new Date()];
  const isAdmin = req.user.role === 'admin';
  const order = await WorkOrder.create({
    customerUID,
    unitNumber: body.unitNumber || customer?.unitNumber || '',
    address: body.address || customer?.address || '',
    region: customer?.region || body.region || '',
    scheduledDate: slots[0],
    preferredDates: slots,
    customerNote: body.customerNote || '',
    requestedServices: body.requestedServices || [],
    estimatedPrice: body.estimatedPrice || 0,
    customerPhotos: body.customerPhotos || [],
    status: isAdmin ? (body.status || 'scheduled') : 'pendingConfirmation',
    confirmedAt: isAdmin ? new Date() : null,
  });
  if (!isAdmin) {
    const customer = await User.findOne({ uid: customerUID });
    onVisitRequested(customer, order).catch(console.error);
  }
  res.status(201).json(orderToJSON(order));
});

app.patch('/api/orders/:id', authMiddleware, async (req, res) => {
  const order = await WorkOrder.findById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });

  if (req.user.role === 'customer') {
    if (order.customerUID !== req.user.uid) return res.status(403).json({ error: 'Forbidden' });
    if (order.status !== 'pendingConfirmation') {
      return res.status(400).json({ error: 'Only pending requests can be edited' });
    }
    const customerAllowed = ['preferredDates', 'customerNote', 'requestedServices', 'estimatedPrice', 'customerPhotos'];
    for (const key of customerAllowed) {
      if (req.body[key] !== undefined) order[key] = req.body[key];
    }
    if (req.body.preferredDates?.length) {
      order.preferredDates = req.body.preferredDates.map(d => new Date(d));
      order.scheduledDate = order.preferredDates[0];
    }
    order.status = 'pendingConfirmation';
    order.confirmedAt = null;
  } else {
    const allowed = [
    'scheduledDate', 'preferredDates', 'customerNote', 'requestedServices',
    'estimatedPrice', 'checklistItems', 'adminNote', 'assignedWorkerUID', 'status', 'region',
    ];
    for (const key of allowed) {
      if (req.body[key] !== undefined) order[key] = req.body[key];
    }
  }
  await order.save();
  res.json(orderToJSON(order));
});

app.post('/api/orders/:id/cancel', authMiddleware, async (req, res) => {
  const order = await WorkOrder.findByIdAndUpdate(
    req.params.id, { status: 'cancelled' }, { new: true }
  );
  if (!order) return res.status(404).json({ error: 'Not found' });
  res.json(orderToJSON(order));
});

app.post('/api/orders/:id/feedback', authMiddleware, requireRole('customer'), async (req, res) => {
  const { rating, feedback, redoRequested } = req.body;
  const order = await WorkOrder.findById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  if (order.customerUID !== req.user.uid) return res.status(403).json({ error: 'Forbidden' });

  order.customerRating = rating;
  order.customerFeedback = feedback || '';
  order.redoRequested = !!redoRequested;
  await order.save();

  let redoOrder = null;
  if (redoRequested) {
    const existingRedo = await WorkOrder.findOne({
      redoFromOrderId: order._id.toString(),
      status: { $nin: ['completed', 'cancelled'] },
    });
    if (!existingRedo) {
      const redoDate = new Date();
      redoDate.setDate(redoDate.getDate() + 7);
      redoOrder = await WorkOrder.create({
        customerUID: order.customerUID,
        unitNumber: order.unitNumber,
        address: order.address,
        region: order.region || '',
        scheduledDate: redoDate,
        preferredDates: [redoDate],
        status: 'pendingConfirmation',
        customerNote: `Redo requested: ${feedback || 'Customer requested a follow-up visit'}`,
        requestedServices: order.requestedServices || [],
        estimatedPrice: 0,
        redoFromOrderId: order._id.toString(),
        adminNote: `Auto-created redo from completed visit (rating: ${rating}/5)`,
      });
      const customer = await User.findOne({ uid: order.customerUID });
      onRedoCreated(customer, order, redoOrder).catch(console.error);
    }
  }

  const result = orderToJSON(order);
  if (redoOrder) result.redoJobId = redoOrder._id.toString();
  res.json(result);
});

// ── Notes ─────────────────────────────────────────────────────────
app.patch('/api/orders/:id/notes', authMiddleware, async (req, res) => {
  const order = await WorkOrder.findById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  if (req.body.customerNote !== undefined) order.customerNote = req.body.customerNote;
  if (req.body.workerNote !== undefined) order.workerNote = req.body.workerNote;
  await order.save();
  res.json(orderToJSON(order));
});

app.post('/api/orders/:id/worker-notes', authMiddleware, requireRole('worker'), async (req, res) => {
  const order = await WorkOrder.findById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  const entry = {
    id: crypto.randomUUID(),
    text: (req.body.text || '').trim(),
    createdAt: new Date(),
    authorUID: req.user.uid,
  };
  if (!entry.text) return res.status(400).json({ error: 'Empty note' });
  if (!order.workerNotes?.length && order.workerNote) {
    order.workerNotes.push({
      id: `legacy-${order._id}`,
      text: order.workerNote,
      createdAt: order.startedAt || order.scheduledDate,
      authorUID: order.assignedWorkerUID || req.user.uid,
    });
  }
  order.workerNotes.push(entry);
  order.workerNote = entry.text;
  await order.save();
  res.json(orderToJSON(order));
});

// ── Photos ────────────────────────────────────────────────────────
app.post('/api/orders/:id/photos/:side', authMiddleware, async (req, res) => {
  const side = req.params.side;
  const field = side === 'customer' ? 'customerPhotos' : 'workerPhotos';
  const order = await WorkOrder.findById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  const url = req.body.url;
  if (!url) return res.status(400).json({ error: 'url required' });
  if (!order[field].includes(url)) order[field].push(url);
  await order.save();
  res.json(orderToJSON(order));
});

app.delete('/api/orders/:id/photos/:side', authMiddleware, async (req, res) => {
  const field = req.params.side === 'customer' ? 'customerPhotos' : 'workerPhotos';
  const order = await WorkOrder.findById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  order[field] = order[field].filter(u => u !== req.body.url);
  await order.save();
  res.json(orderToJSON(order));
});

// ── Checklist ─────────────────────────────────────────────────────
app.patch('/api/orders/:id/checklist', authMiddleware, async (req, res) => {
  const order = await WorkOrder.findByIdAndUpdate(
    req.params.id, { checklistItems: req.body.items }, { new: true }
  );
  if (!order) return res.status(404).json({ error: 'Not found' });
  res.json(orderToJSON(order));
});

// ── Worker status actions ─────────────────────────────────────────
async function appendWorkTime(order, event, workerUID, extra = {}) {
  const entry = { id: crypto.randomUUID(), event, timestamp: new Date(), workerUID };
  order.workTimeLog.push(entry);
  Object.assign(order, extra);
  await order.save();
  return orderToJSON(order);
}

app.post('/api/orders/:id/start', authMiddleware, requireRole('worker'), async (req, res) => {
  const order = await WorkOrder.findById(req.params.id);
  if (!order || order.status !== 'scheduled') return res.status(400).json({ error: 'Cannot start' });
  order.status = 'inProgress';
  order.startedAt = new Date();
  order.assignedWorkerUID = req.user.uid;
  res.json(await appendWorkTime(order, 'started', req.user.uid));
});

app.post('/api/orders/:id/pause', authMiddleware, requireRole('worker'), async (req, res) => {
  const order = await WorkOrder.findById(req.params.id);
  if (!order || order.status !== 'inProgress') return res.status(400).json({ error: 'Cannot pause' });
  order.status = 'paused';
  res.json(await appendWorkTime(order, 'paused', req.user.uid));
});

app.post('/api/orders/:id/resume', authMiddleware, requireRole('worker'), async (req, res) => {
  const order = await WorkOrder.findById(req.params.id);
  if (!order || order.status !== 'paused') return res.status(400).json({ error: 'Cannot resume' });
  order.status = 'inProgress';
  res.json(await appendWorkTime(order, 'resumed', req.user.uid));
});

app.post('/api/orders/:id/complete', authMiddleware, requireRole('worker'), async (req, res) => {
  const order = await WorkOrder.findById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  order.status = 'completed';
  order.completedAt = new Date();
  const result = await appendWorkTime(order, 'completed', req.user.uid);
  // Auto-charge service fee
  if (order.estimatedPrice > 0 && !order.serviceCharged) {
    const customer = await User.findOne({ uid: order.customerUID });
    await Payment.create({
      customerUID: order.customerUID,
      amount: order.estimatedPrice,
      plan: 'service',
      status: customer?.cardLast4 ? 'paid' : 'failed',
      cardLast4: customer?.cardLast4,
      note: 'Service: ' + (order.requestedServices?.join(', ') || 'Visit'),
    });
    order.serviceCharged = true;
    await order.save();
  }
  res.json(result);
});

app.post('/api/orders/:id/revisit', authMiddleware, requireRole('worker'), async (req, res) => {
  const order = await WorkOrder.findById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  if (order.status === 'inProgress') {
    order.status = 'needsRevisit';
    order.revisitCount += 1;
    await appendWorkTime(order, 'paused', req.user.uid);
  } else {
    order.status = 'needsRevisit';
    order.revisitCount += 1;
    await order.save();
  }
  res.json(orderToJSON(order));
});

app.post('/api/orders/:id/schedule-revisit', authMiddleware, requireRole('worker'), async (req, res) => {
  const order = await WorkOrder.findByIdAndUpdate(req.params.id, {
    scheduledDate: new Date(req.body.date),
    status: 'scheduled',
  }, { new: true });
  if (!order) return res.status(404).json({ error: 'Not found' });
  res.json(orderToJSON(order));
});

// ── Admin: users ────────────────────────────────────────────────────
app.get('/api/admin/users', authMiddleware, requireRole('admin'), async (_, res) => {
  const users = await User.find();
  res.json(users.map(u => u.toPublic()));
});

app.get('/api/admin/users/:uid/history', authMiddleware, requireRole('admin'), async (req, res) => {
  const user = await User.findOne({ uid: req.params.uid });
  if (!user) return res.status(404).json({ error: 'Not found' });

  let orders = [];
  let payments = [];
  if (user.role === 'customer') {
    orders = await WorkOrder.find({ customerUID: user.uid }).sort({ scheduledDate: -1 });
    payments = await Payment.find({ customerUID: user.uid }).sort({ date: -1 });
  } else if (user.role === 'worker') {
    orders = await WorkOrder.find({ assignedWorkerUID: user.uid }).sort({ scheduledDate: -1 });
  }

  res.json({
    user: user.toPublic(),
    orders: orders.map(orderToJSON),
    payments: payments.map(p => ({
      id: p._id.toString(),
      date: p.date,
      amount: p.amount,
      plan: p.plan,
      status: p.status,
      note: p.note,
      cardLast4: p.cardLast4,
    })),
  });
});

app.patch('/api/users/me/profile', authMiddleware, async (req, res) => {
  const user = await User.findOne({ uid: req.user.uid });
  if (!user) return res.status(404).json({ error: 'Not found' });
  if (req.body.name !== undefined) user.name = String(req.body.name).trim();
  if (req.body.phoneNumber !== undefined) user.phoneNumber = String(req.body.phoneNumber).trim();
  if (req.body.notifyApp !== undefined) user.notifyApp = !!req.body.notifyApp;
  await user.save();
  res.json(user.toPublic());
});

app.patch('/api/users/:uid', authMiddleware, requireRole('admin'), async (req, res) => {
  const user = await User.findOne({ uid: req.params.uid });
  if (!user) return res.status(404).json({ error: 'Not found' });
  if (user.role === 'admin') {
    return res.status(400).json({ error: 'Admin accounts cannot be edited here' });
  }

  const allowed = ['name', 'address', 'unitNumber', 'region', 'phoneNumber', 'notifyApp', 'role'];
  const patch = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) {
      patch[k] = (k === 'notifyApp') ? !!req.body[k] : req.body[k];
    }
  }

  if (patch.role !== undefined) {
    if (!['customer', 'worker'].includes(patch.role)) {
      return res.status(400).json({ error: 'Role must be customer or worker' });
    }
    if (patch.role !== user.role) {
      if (patch.role === 'worker') {
        patch.subscriptionStatus = 'cancelled';
        patch.renewalDate = null;
        await WorkOrder.updateMany(
          { customerUID: user.uid, status: { $in: ['pendingConfirmation', 'scheduled', 'inProgress', 'paused', 'needsRevisit'] } },
          { status: 'cancelled' }
        );
      } else {
        const pricing = await getPricingConfig();
        const locked = lockedPricesFromConfig(pricing);
        if (user.lockedMonthlyPrice == null) {
          Object.assign(patch, locked);
        }
        patch.subscriptionStatus = 'active';
        patch.subscriptionPlan = user.subscriptionPlan || 'monthly';
        const renewal = new Date();
        renewal.setMonth(renewal.getMonth() + 1);
        patch.renewalDate = renewal;
        if (!user.signupFeePaid) {
          patch.signupFeePaid = true;
          patch.signupFeeAmount = pricing.signupFee;
        }
      }
    }
  }

  const updated = await User.findOneAndUpdate({ uid: req.params.uid }, patch, { new: true });
  if (patch.region !== undefined && updated.role === 'customer') {
    await WorkOrder.updateMany(
      { customerUID: updated.uid, status: { $nin: ['completed', 'cancelled'] } },
      { $set: { region: patch.region } }
    );
  }
  res.json(updated.toPublic());
});

app.delete('/api/users/:uid', authMiddleware, requireRole('admin'), async (req, res) => {
  await User.deleteOne({ uid: req.params.uid });
  res.json({ ok: true });
});

// ── Customer billing ────────────────────────────────────────────────
app.patch('/api/users/me/payment-method', authMiddleware, requireRole('customer'), async (req, res) => {
  const user = await User.findOneAndUpdate({ uid: req.user.uid }, {
    cardBrand: req.body.brand,
    cardLast4: req.body.last4,
  }, { new: true });
  res.json(user.toPublic());
});

app.patch('/api/users/me/plan', authMiddleware, requireRole('customer'), async (req, res) => {
  const plan = req.body.plan;
  const user = await User.findOne({ uid: req.user.uid });
  if (!user) return res.status(404).json({ error: 'Not found' });
  const amount = billAmountForUser(user, plan);
  const renewal = new Date();
  if (plan === 'annual') renewal.setFullYear(renewal.getFullYear() + 1);
  else renewal.setMonth(renewal.getMonth() + 1);
  user.subscriptionPlan = plan;
  user.renewalDate = renewal;
  user.subscriptionStatus = 'active';
  await user.save();
  await Payment.create({
    customerUID: req.user.uid,
    amount,
    plan,
    status: 'paid',
    cardLast4: user.cardLast4,
    note: `Plan changed to ${plan} (your locked rate $${amount})`,
  });
  res.json(user.toPublic());
});

app.post('/api/users/me/cancel-subscription', authMiddleware, requireRole('customer'), async (req, res) => {
  await WorkOrder.updateMany(
    { customerUID: req.user.uid, status: { $in: ['pendingConfirmation', 'scheduled', 'inProgress', 'paused', 'needsRevisit'] } },
    { status: 'cancelled' }
  );
  const user = await User.findOneAndUpdate(
    { uid: req.user.uid }, { subscriptionStatus: 'cancelled' }, { new: true }
  );
  res.json(user.toPublic());
});

// ── Admin: pricing (new signups only; existing keep locked rates) ───
app.get('/api/admin/pricing', authMiddleware, requireRole('admin'), async (_, res) => {
  const config = await getPricingConfig();
  const customers = await User.find({ role: 'customer' });
  res.json({
    ...config,
    stats: {
      customers: customers.length,
      withLockedMonthly: customers.filter(c => c.lockedMonthlyPrice != null).length,
    },
  });
});

app.patch('/api/admin/pricing', authMiddleware, requireRole('admin'), async (req, res) => {
  const updated = await updatePricingConfig(req.body);
  res.json({
    ...updated,
    message: 'Updated prices apply to NEW signups only. Existing customers keep their locked rates.',
  });
});

// ── Admin: services CRUD ────────────────────────────────────────────
app.post('/api/admin/services', authMiddleware, requireRole('admin'), async (req, res) => {
  const s = await ServiceType.create(req.body);
  res.status(201).json({ id: s._id.toString(), name: s.name, price: s.price, sortOrder: s.sortOrder });
});

app.patch('/api/admin/services/:id', authMiddleware, requireRole('admin'), async (req, res) => {
  const s = await ServiceType.findByIdAndUpdate(req.params.id, req.body, { new: true });
  res.json({ id: s._id.toString(), name: s.name, price: s.price, sortOrder: s.sortOrder });
});

app.delete('/api/admin/services/:id', authMiddleware, requireRole('admin'), async (req, res) => {
  await ServiceType.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/orders/:id/confirm-schedule', authMiddleware, requireRole('admin'), async (req, res) => {
  const order = await WorkOrder.findById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  const date = req.body.scheduledDate ? new Date(req.body.scheduledDate) : order.scheduledDate;
  order.scheduledDate = date;
  order.status = 'scheduled';
  order.confirmedAt = new Date();
  await order.save();
  const customer = await User.findOne({ uid: order.customerUID });
  onVisitConfirmed(customer, order).catch(console.error);
  res.json(orderToJSON(order));
});

// ── In-app notifications ─────────────────────────────────────────────
app.get('/api/notifications', authMiddleware, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const items = await AppNotification.find({ userUID: req.user.uid })
    .sort({ createdAt: -1 })
    .limit(limit);
  res.json(items.map(notificationToJSON));
});

app.get('/api/notifications/unread-count', authMiddleware, async (req, res) => {
  const count = await AppNotification.countDocuments({ userUID: req.user.uid, read: false });
  res.json({ count });
});

app.patch('/api/notifications/:id/read', authMiddleware, async (req, res) => {
  const item = await AppNotification.findOneAndUpdate(
    { _id: req.params.id, userUID: req.user.uid },
    { read: true },
    { new: true }
  );
  if (!item) return res.status(404).json({ error: 'Not found' });
  res.json(notificationToJSON(item));
});

app.post('/api/notifications/read-all', authMiddleware, async (req, res) => {
  await AppNotification.updateMany({ userUID: req.user.uid, read: false }, { read: true });
  res.json({ ok: true });
});

app.delete('/api/orders/:id', authMiddleware, requireRole('admin'), async (req, res) => {
  await WorkOrder.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

// ── Start ───────────────────────────────────────────────────────────
if (!process.env.MONGODB_URI) {
  console.error('FATAL: MONGODB_URI env var is missing');
  process.exit(1);
}
if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET env var is missing');
  process.exit(1);
}

async function connectMongo(retries = 5) {
  for (let i = 1; i <= retries; i++) {
    try {
      await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
      console.log('MongoDB connected (hmm-api)');
      await migrateLegacyPricing();
      return;
    } catch (err) {
      console.error(`MongoDB attempt ${i}/${retries} failed:`, err.message);
      if (i === retries) throw err;
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

connectMongo()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => console.log(`hmm-api listening on :${PORT}`));
  })
  .catch(err => {
    console.error('MongoDB connection failed:', err.message);
    console.error('Check: MONGODB_URI correct? Atlas Network Access allows 0.0.0.0/0?');
    process.exit(1);
  });
