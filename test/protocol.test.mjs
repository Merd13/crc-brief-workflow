import { test } from "node:test";
import assert from "node:assert/strict";
import { createDecoder, encodeMessage, MAX_OUTGOING } from "../host/protocol.mjs";

function collect() {
  const messages = [];
  const errors = [];
  const feed = createDecoder(
    (message) => messages.push(message),
    (error) => errors.push(error.message),
  );
  return { messages, errors, feed };
}

test("a message is a 4-byte little-endian length and then UTF-8 JSON", () => {
  const frame = encodeMessage({ a: "é" });
  const json = Buffer.from('{"a":"é"}', "utf8");
  assert.equal(frame.readUInt32LE(0), json.length);
  assert.deepEqual(frame.subarray(4), json);
});

test("round trip", () => {
  const { messages, errors, feed } = collect();
  feed(encodeMessage({ id: 1, type: "ping" }));
  assert.deepEqual(messages, [{ id: 1, type: "ping" }]);
  assert.deepEqual(errors, []);
});

test("two messages in one chunk", () => {
  const { messages, feed } = collect();
  feed(Buffer.concat([encodeMessage({ n: 1 }), encodeMessage({ n: 2 })]));
  assert.deepEqual(messages, [{ n: 1 }, { n: 2 }]);
});

test("one message split at every byte offset", () => {
  const frame = encodeMessage({ text: "héllo wörld", list: [1, 2, 3] });
  for (let cut = 1; cut < frame.length; cut++) {
    const { messages, errors, feed } = collect();
    feed(frame.subarray(0, cut));
    assert.equal(messages.length, 0, `cut ${cut}`);
    feed(frame.subarray(cut));
    assert.deepEqual(messages, [{ text: "héllo wörld", list: [1, 2, 3] }], `cut ${cut}`);
    assert.deepEqual(errors, []);
  }
});

test("a length over the limit is reported and nothing is delivered", () => {
  const { messages, errors, feed } = collect();
  const header = Buffer.alloc(4);
  header.writeUInt32LE(64 * 1024 * 1024 + 1, 0);
  feed(header);
  assert.equal(messages.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /too large/);
});

test("invalid JSON is reported and the next message still arrives", () => {
  const { messages, errors, feed } = collect();
  const bad = Buffer.from("{nope", "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(bad.length, 0);
  feed(Buffer.concat([header, bad, encodeMessage({ ok: true })]));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not valid JSON/);
  assert.deepEqual(messages, [{ ok: true }]);
});

test("an outgoing message over Chrome's 1 MB limit is refused", () => {
  assert.equal(MAX_OUTGOING, 1024 * 1024);
  assert.throws(() => encodeMessage({ body: "x".repeat(MAX_OUTGOING) }), /too large/);
});
