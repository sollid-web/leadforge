import { z } from "zod";

export function isValidSenderAddress(value: string) {
  if (/[\r\n]/.test(value)) return false;
  const match = value.match(/^(?:([^<>]+?)\s*<([^<>]+)>|([^<>]+))$/);
  const address = match?.[2] ?? match?.[3];
  if (!address || (match?.[1] !== undefined && !match[1].trim())) return false;
  return z.string().email().safeParse(address.trim()).success;
}
