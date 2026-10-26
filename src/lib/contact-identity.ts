import { createHash } from "node:crypto";

export type ContactIdentityInput = {
  name?: string;
  email?: string;
  phone?: string;
};

export function contactFingerprint(contactType: string, contact: ContactIdentityInput) {
  const email = contact.email?.trim().toLocaleLowerCase("en");
  const phoneDigits = contact.phone?.replace(/\D/g, "");
  const phone = phoneDigits ? `${contact.phone?.trim().startsWith("+") ? "+" : ""}${phoneDigits}` : undefined;
  const name = contact.name?.trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
  const identity = [email ? `email:${email}` : "", phone ? `phone:${phone}` : ""].filter(Boolean).join("|")
    || (name ? `name:${name}` : "");
  return identity ? createHash("sha256").update(`${contactType}:${identity}`).digest("hex") : null;
}
