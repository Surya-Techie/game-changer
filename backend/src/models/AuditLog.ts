import { Schema, model, Types } from "mongoose";

const auditLogSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", index: true },
    email: { type: String },
    role: { type: String },
    method: { type: String, required: true },
    path: { type: String, required: true },
    status: { type: Number, required: true },
    ip: { type: String },
    userAgent: { type: String },
    bodyHash: { type: String }, // sha256 of redacted body, never raw secrets
    durationMs: { type: Number },
    createdAt: { type: Date, default: () => new Date(), index: true },
  },
  { versionKey: false }
);

auditLogSchema.index({ createdAt: -1 });
// Auto-purge after 90 days so the collection stays bounded. Tunable via
// AUDIT_TTL_DAYS env (re-syncIndexes() to apply changes — see scripts/syncIndexes).
const AUDIT_TTL_SEC = Number(process.env.AUDIT_TTL_DAYS ?? 90) * 24 * 60 * 60;
auditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: AUDIT_TTL_SEC });

export const AuditLog = model("AuditLog", auditLogSchema);
