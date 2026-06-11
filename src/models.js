const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  uid: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true, lowercase: true },
  passwordHash: { type: String, required: true },
  name: String,
  role: { type: String, enum: ['customer', 'worker', 'admin'], default: 'customer' },
  unitNumber: String,
  address: String,
  phoneNumber: String,
  subscriptionStatus: { type: String, default: 'active' },
  subscriptionPlan: { type: String, default: 'monthly' },
  renewalDate: Date,
  cardBrand: String,
  cardLast4: String,
  signupFeePaid: { type: Boolean, default: false },
  signupFeeAmount: { type: Number, default: 0 },
  lockedMonthlyPrice: { type: Number },
  lockedAnnualPrice: { type: Number },
  pricingLockedAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
});

const checklistItemSchema = new mongoose.Schema({
  id: String,
  title: String,
  isCompleted: { type: Boolean, default: false },
}, { _id: false });

const workerNoteSchema = new mongoose.Schema({
  id: String,
  text: String,
  createdAt: Date,
  authorUID: String,
}, { _id: false });

const workTimeSchema = new mongoose.Schema({
  id: String,
  event: String,
  timestamp: Date,
  workerUID: String,
}, { _id: false });

const workOrderSchema = new mongoose.Schema({
  customerUID: String,
  assignedWorkerUID: String,
  unitNumber: String,
  address: String,
  scheduledDate: Date,
  status: { type: String, default: 'scheduled' },
  customerPhotos: [String],
  workerPhotos: [String],
  customerNote: { type: String, default: '' },
  workerNote: { type: String, default: '' },
  workerNotes: [workerNoteSchema],
  adminNote: { type: String, default: '' },
  disclaimerAgreed: { type: Boolean, default: false },
  checklistItems: [checklistItemSchema],
  completedAt: Date,
  startedAt: Date,
  workTimeLog: [workTimeSchema],
  revisitCount: { type: Number, default: 0 },
  doorLockVideoURL: String,
  customerRating: { type: Number, default: 0 },
  customerFeedback: { type: String, default: '' },
  redoRequested: { type: Boolean, default: false },
  requestedServices: [String],
  estimatedPrice: { type: Number, default: 0 },
  preferredDates: [Date],
  serviceCharged: { type: Boolean, default: false },
}, { timestamps: true });

const paymentSchema = new mongoose.Schema({
  customerUID: String,
  date: { type: Date, default: Date.now },
  amount: Number,
  plan: String,
  status: { type: String, default: 'paid' },
  cardLast4: String,
  note: String,
});

const serviceTypeSchema = new mongoose.Schema({
  name: String,
  price: Number,
  sortOrder: { type: Number, default: 0 },
});

const pricingConfigSchema = new mongoose.Schema({
  key: { type: String, unique: true, default: 'default' },
  signupFee: { type: Number, default: 99 },
  monthlyPriceNew: { type: Number, default: 99 },
  annualPriceNew: { type: Number, default: 990 },
}, { timestamps: true });

userSchema.methods.toPublic = function () {
  const { enrichUserPublic } = require('./pricing');
  const o = this.toObject();
  delete o.passwordHash;
  delete o.__v;
  o.id = o._id.toString();
  delete o._id;
  return enrichUserPublic(o);
};

function orderToJSON(doc) {
  const o = doc.toObject ? doc.toObject() : doc;
  o.id = o._id.toString();
  delete o._id;
  delete o.__v;
  delete o.createdAt;
  delete o.updatedAt;
  return o;
}

module.exports = {
  User: mongoose.model('User', userSchema),
  WorkOrder: mongoose.model('WorkOrder', workOrderSchema),
  Payment: mongoose.model('Payment', paymentSchema),
  ServiceType: mongoose.model('ServiceType', serviceTypeSchema),
  PricingConfig: mongoose.model('PricingConfig', pricingConfigSchema),
  orderToJSON,
};
