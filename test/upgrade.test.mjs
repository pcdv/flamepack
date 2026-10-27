// @ts-check
// The version 5 examples draw what the version 4 ones do, and so does each version 4
// example converted by tools/upgrade.mjs.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readDocument, validate, collapsed} from '../tools/validate.mjs';
import {upgrade} from '../tools/upgrade.mjs';

const EXAMPLES = ['minimal', 'server', 'heap'];

/**
 * @param {any} doc
 * @returns {string[]} its collapsed stacks, sorted
 */
function draw(doc) {
  const v = validate(doc);
  assert.deepEqual(v.errors, []);
  return collapsed(v).sort();
}

for (const name of EXAMPLES) {
  const v4 = readDocument(`examples/v4/${name}.fpk`);

  test(`${name}: upgraded, the same stacks`, () => {
    const v5 = upgrade(v4);
    assert.equal(v5.version, 5);
    assert.deepEqual(draw(v5), draw(v4));
  });

  // the version 5 minimal example is the spec's, a count profile of its own
  if (name !== 'minimal')
    test(`${name}: the version 5 example, the same stacks`, () => {
      assert.deepEqual(draw(readDocument(`examples/${name}.fpk`)), draw(v4));
    });
}

test('an operation keeps its thread, as an index in threads', () => {
  const v5 = upgrade(readDocument('examples/v4/server.fpk'));
  const names = validate(v5).strings;
  assert.deepEqual(v5.operations.thread.map((/** @type {number} */ t) => names[v5.threads[t][0]]),
                   ['worker-1', 'worker-2']);
});

test('samples with no time are sorted by stack, the differences then small', () => {
  const v5 = upgrade(readDocument('examples/v4/heap.fpk'));
  assert.ok(!('time' in v5.samples));
  assert.ok(v5.samples.stack.slice(1).every((/** @type {number} */ d) => d >= 0));
});

test('version 4 rules still hold for version 4', () => {
  const v4 = readDocument('examples/v4/minimal.fpk');
  const {threads, ...without} = v4;
  assert.equal(validate(without).errors[0], 'threads is missing');
});

test('a version 5 document needs only stacks and samples', () => {
  const doc = {version: 5, unit: 'count', strings: [' main'], stacks: {depth: [0], name: [0]}, samples: {stack: [1, 0]}};
  assert.deepEqual(draw(doc), ['main 2']);
});
