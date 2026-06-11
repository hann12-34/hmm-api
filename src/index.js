require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { User, WorkOrder, Payment, ServiceType, orderToJSON } = require('./models');
const { signToken, authMiddleware, requireRole } = require('./auth');

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
    const { email, password, name, role, unitNumber, address, phoneNumber } = req.body;
    if (!email || !password || password.length < 6) {
      return res.status(400).json({ error: 'Email and password (6+ chars) required' });
    }
    if (await User.findOne({ email: email.toLowerCase() })) {
      return res.status(409).json({ error: 'Email already in use' });
    }
    const uid = crypto.randomUUID();
    const userRole = ['customer', 'worker', 'admin'].includes(role) ? role : 'customer';
    const plan = 'monthly';
    const renewal = new Date();
    renewal.setMonth(renewal.getMonth() + 1);
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
    });
    if (userRole === 'customer') {
      await Payment.create({
        customerUID: uid,
        amount: 99,
        plan,
        status: 'paid',
        note: 'Subscription started (Monthly)',
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
  const slots = body.preferredDates?.length ? body.preferredDates.map(d => new Date(d)) : [new Date()];
  const order = await WorkOrder.create({
    customerUID,
    unitNumber: body.unitNumber || '',
    address: body.address || '',
    scheduledDate: slots[0],
    preferredDates: slots,
    customerNote: body.customerNote || '',
    requestedServices: body.requestedServices || [],
    estimatedPrice: body.estimatedPrice || 0,
    customerPhotos: body.customerPhotos || [],
    status: 'scheduled',
  });
  res.status(201).json(orderToJSON(order));
});

app.patch('/api/orders/:id', authMiddleware, async (req, res) => {
  const order = await WorkOrder.findById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  const allowed = [
    'scheduledDate', 'preferredDates', 'customerNote', 'requestedServices',
    'estimatedPrice', 'checklistItems', 'adminNote', 'assignedWorkerUID', 'status',
  ];
  for (const key of allowed) {
    if (req.body[key] !== undefined) order[key] = req.body[key];
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
  const order = await WorkOrder.findByIdAndUpdate(req.params.id, {
    customerRating: rating,
    customerFeedback: feedback,
    redoRequested: !!redoRequested,
  }, { new: true });
  if (!order) return res.status(404).json({ error: 'Not found' });
  res.json(orderToJSON(order));
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

app.patch('/api/users/:uid', authMiddleware, requireRole('admin'), async (req, res) => {
  const user = await User.findOneAndUpdate({ uid: req.params.uid }, req.body, { new: true });
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(user.toPublic());
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
  const renewal = new Date();
  if (plan === 'annual') renewal.setFullYear(renewal.getFullYear() + 1);
  else renewal.setMonth(renewal.getMonth() + 1);
  const user = await User.findOneAndUpdate({ uid: req.user.uid }, {
    subscriptionPlan: plan,
    renewalDate: renewal,
    subscriptionStatus: 'active',
  }, { new: true });
  await Payment.create({
    customerUID: req.user.uid,
    amount: plan === 'annual' ? 990 : 99,
    plan,
    status: 'paid',
    cardLast4: user.cardLast4,
    note: `Plan changed to ${plan}`,
  });
  res.json(user.toPublic());
});

app.post('/api/users/me/cancel-subscription', authMiddleware, requireRole('customer'), async (req, res) => {
  await WorkOrder.updateMany(
    { customerUID: req.user.uid, status: { $in: ['scheduled', 'inProgress', 'paused', 'needsRevisit'] } },
    { status: 'cancelled' }
  );
  const user = await User.findOneAndUpdate(
    { uid: req.user.uid }, { subscriptionStatus: 'cancelled' }, { new: true }
  );
  res.json(user.toPublic());
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
