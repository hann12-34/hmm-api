const { isStaffRole } = require('./auth');

function canAccessOrder(user, order) {
  if (!user || !order) return false;
  if (isStaffRole(user.role)) return true;
  if (user.role === 'customer') return order.customerUID === user.uid;
  if (user.role === 'worker') {
    if (!order.assignedWorkerUID) return true;
    return order.assignedWorkerUID === user.uid;
  }
  return false;
}

function workerCanAct(user, order) {
  if (!user || user.role !== 'worker' || !order) return false;
  if (!order.assignedWorkerUID) return true;
  return order.assignedWorkerUID === user.uid;
}

module.exports = { canAccessOrder, workerCanAct };
