import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function encryptionKey() {
  const encoded = process.env.OWNER_DATA_ENCRYPTION_KEY;
  if (!encoded) throw new Error("OWNER_DATA_ENCRYPTION_KEY is required to handle private listing details");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("OWNER_DATA_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  return key;
}

export function encryptPrivateData(value: unknown) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    keyVersion: "v1",
  };
}

export function decryptPrivateData(encrypted: { ciphertext: string; iv: string; auth_tag: string }) {
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(encrypted.iv, "base64"));
  decipher.setAuthTag(Buffer.from(encrypted.auth_tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(plaintext) as Record<string, string>;
}
