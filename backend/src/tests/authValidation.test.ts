import assert from "node:assert/strict";
import test from "node:test";
import {
  credentialsSchema,
  normalizeEmail,
  validatePasswordByteLength,
} from "../services/authValidation.js";

test("normalizes email addresses before persistence", () => {
  assert.equal(normalizeEmail("  Person@Example.COM "), "person@example.com");
});

test("validates and normalizes credential payloads", () => {
  const parsed = credentialsSchema.parse({
    email: "  Person@Example.COM ",
    password: "correct horse battery staple",
  });
  assert.equal(parsed.email, "person@example.com");
  assert.equal(parsed.password, "correct horse battery staple");
});

test("rejects malformed email and short password", () => {
  assert.equal(
    credentialsSchema.safeParse({
      email: "not-an-email",
      password: "short",
    }).success,
    false,
  );
});

test("rejects bcrypt inputs exceeding the UTF-8 byte limit", () => {
  assert.equal(validatePasswordByteLength("a".repeat(72)), true);
  assert.equal(validatePasswordByteLength("a".repeat(73)), false);
  assert.equal(validatePasswordByteLength("é".repeat(37)), false);
});
