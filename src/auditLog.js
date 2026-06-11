const { AuditLog } = require('./models');

async function logAudit({ actor, action, targetType, targetId, summary, details }) {
  if (!actor?.uid) return null;
  try {
    return await AuditLog.create({
      actorUID: actor.uid,
      actorEmail: actor.email || '',
      actorRole: actor.role || '',
      action,
      targetType: targetType || '',
      targetId: targetId || '',
      summary: summary || '',
      details: details || {},
    });
  } catch (e) {
    console.error('audit log failed', e);
    return null;
  }
}

function auditToJSON(doc) {
  const o = doc.toObject ? doc.toObject() : doc;
  return {
    id: o._id.toString(),
    actorUID: o.actorUID,
    actorEmail: o.actorEmail,
    actorRole: o.actorRole,
    action: o.action,
    targetType: o.targetType,
    targetId: o.targetId,
    summary: o.summary,
    details: o.details,
    createdAt: o.createdAt,
  };
}

module.exports = { logAudit, auditToJSON };
