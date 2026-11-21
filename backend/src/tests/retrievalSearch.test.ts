import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../database/prisma.js";
import { escapeRegex, searchCode } from "../services/retrieval.js";

function mockRawQuery(rows: unknown[]) {
  const original = Object.getOwnPropertyDescriptor(prisma, "$queryRawUnsafe");
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  Object.defineProperty(prisma, "$queryRawUnsafe", {
    configurable: true,
    value: async (sql: string, ...values: unknown[]) => {
      calls.push({ sql, values });
      return rows;
    },
  });
  return {
    calls,
    restore() {
      if (original) {
        Object.defineProperty(prisma, "$queryRawUnsafe", original);
      } else {
        delete (prisma as { $queryRawUnsafe?: unknown }).$queryRawUnsafe;
      }
    },
  };
}

test("full-text search uses PostgreSQL search vectors and parameterized filters", async () => {
  const mock = mockRawQuery([]);
  try {
    const result = await searchCode(
      "authorized-branch",
      "booking redirect error",
      "full_text",
      {
        filePath: "src/controllers/bookingController.ts",
        className: "BookingController",
        symbolType: "method",
        language: "typescript",
      },
      10,
    );

    assert.deepEqual(result, []);
    assert.equal(mock.calls.length, 1);
    const { sql, values } = mock.calls[0];
    assert.match(sql, /search_vector @@ websearch_to_tsquery\('english'/);
    assert.match(sql, /ts_rank_cd/);
    assert.match(sql, /file_path = \$[0-9]/);
    assert.match(sql, /class_name = \$[0-9]/);
    assert.match(sql, /symbol_type = \$[0-9]/);
    assert.match(sql, /language = \$[0-9]/);
    assert.equal(values[0], "authorized-branch");
    assert.equal(values[1], "src/controllers/bookingController.ts");
    assert.equal(values[2], "BookingController");
    assert.equal(values[3], "method");
    assert.equal(values[4], "typescript");
    assert.equal(values[5], "booking redirect error");
  } finally {
    mock.restore();
  }
});

test("identifier search matches exact identifiers and escapes regex input", async () => {
  const mock = mockRawQuery([{
    id: "chunk-1",
    filePath: "src/booking.ts",
    content: "export const MAX_RETRIES = 3;\nexport function createBooking() {}",
    startLine: 4,
    endLine: 5,
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    language: "typescript",
    symbolName: "createBooking",
    symbolType: "function",
    className: null,
    functionSignature: "createBooking(input: BookingInput)",
  }]);
  try {
    const create = await searchCode(
      "branch",
      "createBooking",
      "identifier",
      {},
      10,
    );
    assert.equal(create.length, 1);
    assert.equal(create[0].retrievalSources?.[0], "identifier");

    const { sql, values } = mock.calls[0];
    assert.match(sql, /symbol_name/);
    assert.match(sql, /class_name/);
    assert.match(sql, /function_signature/);
    assert.match(sql, /content ~/);
    assert.equal(
      values[1],
      "(^|[^[:alnum:]_$])createBooking([^[:alnum:]_$]|$)",
    );

    assert.equal(escapeRegex("createBookingHistory"), "createBookingHistory");
    assert.equal(escapeRegex("$handle.redirect"), "\\$handle\\.redirect");
  } finally {
    mock.restore();
  }
});

test("branch isolation is always represented as an injected SQL parameter", async () => {
  const mock = mockRawQuery([]);
  try {
    await searchCode("00000000-0000-4000-8000-000000000001", "MAX_RETRIES", "identifier");
    const { sql, values } = mock.calls[0];
    assert.match(sql, /branch_index_id = \$1::uuid/);
    assert.equal(values[0], "00000000-0000-4000-8000-000000000001");
  } finally {
    mock.restore();
  }
});
