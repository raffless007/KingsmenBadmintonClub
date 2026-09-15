import test from "node:test";
import assert from "node:assert/strict";
import { validBadmintonScore } from "../netlify/functions/api.mjs";

test("badminton scoring enforces a two point lead through 29", () => {
  assert.equal(validBadmintonScore(21, 19).valid, true);
  assert.equal(validBadmintonScore(20, 19).valid, false);
  assert.equal(validBadmintonScore(22, 20).valid, true);
  assert.equal(validBadmintonScore(29, 28).valid, false);
  assert.equal(validBadmintonScore(30, 29).valid, true);
});

test("badminton scoring rejects draws and scores over the cap", () => {
  assert.equal(validBadmintonScore(21, 21).valid, false);
  assert.equal(validBadmintonScore(31, 29).valid, false);
  assert.equal(validBadmintonScore(-1, 21).valid, false);
});
