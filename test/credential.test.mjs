import { test } from "node:test";
import assert from "node:assert/strict";
import { pickCredential } from "../lib/credential.mjs";

test("api key only", () => {
  assert.deepEqual(pickCredential({ apiKey: "sk-ant-x", oauthToken: "" }), { ok: true, kind: "api_key" });
});

test("subscription token only", () => {
  assert.deepEqual(pickCredential({ apiKey: "", oauthToken: "tok" }), { ok: true, kind: "oauth_token" });
});

test("none names both secrets", () => {
  const r = pickCredential({ apiKey: " ", oauthToken: "" });
  assert.equal(r.ok, false);
  assert.match(r.error, /CRC_ANTHROPIC_API_KEY.*CRC_CLAUDE_CODE_OAUTH_TOKEN/);
});

test("an unset secret counts as none", () => {
  assert.equal(pickCredential({ apiKey: undefined, oauthToken: undefined }).ok, false);
});

test("both is refused", () => {
  const r = pickCredential({ apiKey: "a", oauthToken: "b" });
  assert.equal(r.ok, false);
  assert.match(r.error, /Keep only one/);
});
