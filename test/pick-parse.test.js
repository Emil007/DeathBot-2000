const { test } = require("node:test");
const assert = require("node:assert");
const { parsePickList, nameKey } = require("../src/discord/pick-parse");

test("one name per line", () => {
  const { names } = parsePickList("Alice\nBob\nCarol");
  assert.deepStrictEqual(names, ["Alice", "Bob", "Carol"]);
});

test("semicolon separators", () => {
  const { names } = parsePickList("Alice; Bob; Carol");
  assert.deepStrictEqual(names, ["Alice", "Bob", "Carol"]);
});

test("en/em dash and spaced hyphen", () => {
  const { names } = parsePickList("Alice – Bob — Carol - Dan");
  assert.deepStrictEqual(names, ["Alice", "Bob", "Carol", "Dan"]);
});

// F19b: Die Anleitung sagt: „Ein Bindestrich schneidet nur mit Leerzeichen
// links und rechts.” Ein einseitiger Strich (`Foo– Bar`) trennt NICHT.
test("F19b: dash with space on ONE side does NOT split (per announce text)", () => {
  const { names } = parsePickList("Foo– Bar foo-dur");
  assert.deepStrictEqual(names, ["Foo– Bar foo-dur"], "one-sided dash must stay one name");
  const { names: n2 } = parsePickList("Foo —Bar");
  assert.deepStrictEqual(n2, ["Foo —Bar"]);
});

test("F19b: dash with spaces on BOTH sides still splits", () => {
  const { names } = parsePickList("Foo – Bar");
  assert.deepStrictEqual(names, ["Foo", "Bar"]);
});

test("hyphen with spaces on one side is a separator too", () => {
  const { names } = parsePickList("Alice - Bob");
  assert.deepStrictEqual(names, ["Alice", "Bob"]);
});

test("Jean-Luc stays one name", () => {
  const { names } = parsePickList("Jean-Luc Picard");
  assert.deepStrictEqual(names, ["Jean-Luc Picard"]);
});

test("Müller, Hans stays one name (comma is not a separator)", () => {
  const { names } = parsePickList("Müller, Hans");
  assert.deepStrictEqual(names, ["Müller, Hans"]);
});

test("empty lines and whitespace ignored", () => {
  const { names } = parsePickList("\n  \nAlice\n\n  \nBob\n");
  assert.deepStrictEqual(names, ["Alice", "Bob"]);
});

test("duplicates within one paste are merged and reported", () => {
  const { names, duplicates } = parsePickList("Alice\nAlice\nBob");
  assert.deepStrictEqual(names, ["Alice", "Bob"]);
  assert.strictEqual(duplicates.length, 1);
});

test("empty input returns error", () => {
  const res = parsePickList("");
  assert.ok(res.error);
  assert.deepStrictEqual(res.names, []);
});

test("nameKey normalizes accents and case for dedup", () => {
  assert.strictEqual(nameKey("Jürgen Müller"), nameKey("Jurgen Muller"));
});

// F10: Überzählige eindeutige Tokens über maxNames werden MITgezählt
// (recognized) statt beim ersten Überhang abgebrochen zu werden.
test("F10: overhang beyond maxNames is counted in recognized", () => {
  const { names, recognized, truncated } = parsePickList(
    "A1; A2; A3; A4; A5",
    { maxNames: 3 }
  );
  assert.deepStrictEqual(names, ["A1", "A2", "A3"]);
  assert.strictEqual(recognized, 5, "all unique tokens counted, not just the kept ones");
  assert.strictEqual(truncated, true);
});

test("F10: duplicates still do not count into recognized overhang", () => {
  const { names, recognized, duplicates } = parsePickList(
    "A1; A2; A1; A3;",
    { maxNames: 2 }
  );
  assert.deepStrictEqual(names, ["A1", "A2"]);
  assert.strictEqual(duplicates.length, 1);
  assert.strictEqual(recognized, 3, "A3 is unique overhang (A1-dup does not count)");
});
