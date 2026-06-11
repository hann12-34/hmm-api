const { User, AppNotification } = require('./models');

async function pushToUser(userUID, { title, body, type, orderId }) {
  const user = await User.findOne({ uid: userUID });
  if (!user || user.notifyApp === false) return null;
  return AppNotification.create({
    userUID,
    title,
    body,
    type: type || 'general',
    orderId: orderId || '',
    read: false,
  });
}

async function pushToAdmins(payload) {
  const staff = await User.find({
    role: { $in: ['admin', 'manager'] },
    notifyApp: { $ne: false },
  });
  return Promise.all(staff.map(a => pushToUser(a.uid, payload)));
}

async function onVisitRequested(customer, order) {
  const orderId = order._id?.toString() || order.id || '';
  const slots = (order.preferredDates || []).length
    ? order.preferredDates.map(d => new Date(d).toLocaleString()).join(', ')
    : new Date(order.scheduledDate).toLocaleString();
  await pushToUser(customer.uid, {
    title: 'Visit request received',
    body: `Unit ${order.unitNumber} — preferred times: ${slots}. We'll confirm your appointment soon.`,
    type: 'visit_requested',
    orderId,
  });
  await pushToAdmins({
    title: 'New visit request',
    body: `${customer.name || customer.email} · ${order.region || order.unitNumber || '—'} · ${slots}`,
    type: 'visit_requested',
    orderId,
  });
}

async function onVisitConfirmed(customer, order) {
  const orderId = order._id?.toString() || order.id || '';
  const when = new Date(order.scheduledDate).toLocaleString();
  await pushToUser(customer.uid, {
    title: 'Visit confirmed',
    body: `Unit ${order.unitNumber} on ${when}.`,
    type: 'visit_confirmed',
    orderId,
  });
}

async function onRedoCreated(customer, originalOrder, redoOrder) {
  const orderId = redoOrder._id?.toString() || redoOrder.id || '';
  await pushToUser(customer.uid, {
    title: 'Redo visit requested',
    body: `We received your redo request for Unit ${originalOrder.unitNumber}. We'll confirm the follow-up date soon.`,
    type: 'redo_created',
    orderId,
  });
  await pushToAdmins({
    title: 'Redo visit auto-created',
    body: `${customer.name || customer.email} · ${originalOrder.region || originalOrder.unitNumber || '—'} · pending confirmation`,
    type: 'redo_created',
    orderId,
  });
}

function notificationToJSON(doc) {
  const o = doc.toObject ? doc.toObject() : doc;
  return {
    id: o._id.toString(),
    userUID: o.userUID,
    title: o.title,
    body: o.body,
    type: o.type,
    orderId: o.orderId,
    read: o.read,
    createdAt: o.createdAt,
  };
}

module.exports = {
  pushToUser,
  pushToAdmins,
  onVisitRequested,
  onVisitConfirmed,
  onRedoCreated,
  notificationToJSON,
};
