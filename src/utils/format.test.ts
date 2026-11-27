import assert from "node:assert/strict";
import test from "node:test";
import { formatBytes, formatBytesCompact, groupByKey } from "./format.ts";

test("formatBytes formats zero, invalid, and scaled units consistently", () => {
  assert.equal(formatBytes(0), "-");
  assert.equal(formatBytes(null, "0 B"), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(1024 * 1024 * 2.5), "2.5 MB");
  assert.equal(formatBytesCompact(0), "");
  assert.equal(formatBytesCompact(512 * 1024), "512 KB");
  assert.equal(formatBytesCompact(3.25 * 1024 * 1024), "3.3 MB");
});

test("groupByKey preserves insertion order with native Object.groupBy and Safari 17.0-17.3 fallback", () => {
  const items = [
    { id: 1, bucket: "today" },
    { id: 2, bucket: "later" },
    { id: 3, bucket: "today" },
  ];

  const groupedNative = groupByKey(items, (x) => x.bucket);
  assert.deepEqual(Object.keys(groupedNative), ["today", "later"]);
  assert.deepEqual(
    groupedNative.today.map((x) => x.id),
    [1, 3]
  );
  assert.deepEqual(
    groupedNative.later.map((x) => x.id),
    [2]
  );

  // Simulate Safari 17.0-17.3 where Object.groupBy is unavailable
  const objCtor = Object as unknown as { groupBy?: unknown };
  const originalGroupBy = objCtor.groupBy;
  try {
    objCtor.groupBy = undefined;
    const groupedFallback = groupByKey(items, (x) => x.bucket);
    assert.deepEqual(groupedFallback, groupedNative);
  } finally {
    objCtor.groupBy = originalGroupBy;
  }
});
