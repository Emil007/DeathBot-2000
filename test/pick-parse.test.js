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
