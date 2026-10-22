import { z } from "zod";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function validatePasswordByteLength(password: string): boolean {
  return Buffer.byteLength(password, "utf8") <= 72;
}

const emailSchema = z
  .string()
  .trim()
  .email()
  .max(320)
  .transform(normalizeEmail);

const passwordSchema = z
  .string()
  .min(8)
  .max(72)
  .refine(
    validatePasswordByteLength,
    "Password must be no more than 72 UTF-8 bytes.",
  );

export const credentialsSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});
