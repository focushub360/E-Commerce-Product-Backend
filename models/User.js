import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const addressSchema = new mongoose.Schema({
  label:     { type: String, default: 'Home' },
  street:    String,
  city:      String,
  state:     String,
  pincode:   String,
  country:   { type: String, default: 'India' },
  isDefault: { type: Boolean, default: false },
  // Phase 2 — optional, backward-compatible coordinates for fulfillment
  // routing. Existing addresses without these simply have latitude/
  // longitude === undefined and are treated as "no location" upstream.
  latitude:  { type: Number, default: null },
  longitude: { type: Number, default: null },
});

/* ── Dealer's own invoice branding — used to render THAT dealer's
     block on a customer's invoice, independently of other dealers
     in the same order ── */
const invoiceSettingsSchema = new mongoose.Schema(
  {
    businessName:  { type: String, default: '' }, // falls back to user.businessName if empty
    logo:          { type: String, default: '' },
    gstin:         { type: String, default: '' },
    address:       { type: String, default: '' },
    phone:         { type: String, default: '' },
    email:         { type: String, default: '' },
    bankName:      { type: String, default: '' },
    accountNumber: { type: String, default: '' },
    ifsc:          { type: String, default: '' },
    upiId:         { type: String, default: '' },
    footerNote:    { type: String, default: 'Thank you for your business!' },
    invoicePrefix: { type: String, default: 'INV' },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    name:           { type: String, required: true, trim: true },
    email:          { type: String, required: true, unique: true, lowercase: true },
    password:       { type: String, required: true, minlength: 6 },
    phone:          { type: String, required: true, default: '' },
    secondaryPhone: { type: String, default: '' },
    role:           { type: String, enum: ['user', 'admin', 'dealer'], default: 'user' },
    addresses:      { type: [addressSchema], validate: [v => v.length <= 10, 'Max 10 addresses'] },
    avatar:         { type: String, default: '' },
    isActive:       { type: Boolean, default: true },

    // Dealer-specific fields
    dealerId:       { type: String, default: '' },           // e.g. TVSD-0001
    businessName:   { type: String, default: '' },
    businessLocation: { type: String, default: '' },
    dealerState:    { type: String, default: '' },
    dealerApproved: { type: Boolean, default: false },
    dealerRequestedAt: Date,

    // Dealer invoice branding — editable by the dealer
    invoiceSettings: { type: invoiceSettingsSchema, default: () => ({}) },
  },
  { timestamps: true }
);

// Fixed pre-save hook — only hash when modified
userSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

userSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

export default mongoose.model('User', userSchema);