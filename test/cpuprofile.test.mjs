// @ts-check
// A V8 CPU profile converted by tools/cpuprofile.mjs draws what its call tree says.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validate, collapsed} from '../tools/validate.mjs';
import {basename} from 'node:path';
import {convert, outputName} from '../tools/cpuprofile.mjs';

/**
 * @param {number} id
 * @param {string} functionName
 * @param {number[]} [children]
 * @param {string} [url]
 */
const node = (id, functionName, children, url = '') =>
  ({id, callFrame: {functionName, url, lineNumber: url ? 9 : -1}, children});

// main (two nodes of one frame, told apart by their column in V8) calls a and b; the rest is idle
const PROFILE = {
  nodes: [node(1, '(root)', [2, 3, 4, 5]), node(2, '(idle)'), node(3, 'main', [6], 'file:///src/app.js'),
          node(4, 'main', [7], 'file:///src/app.js'), node(5, '(program)'), node(6, 'a'), node(7, 'b')],
  startTime: 1000, endTime: 1000 + 10_000,
  samples: [2, 6, 6, 2, 7, 5, 2],
  timeDeltas: [1000, 1000, 1000, 1000, 1000, 1000, 1000],
};

/**
 * @param {any} doc
 * @returns {string[]} its collapsed stacks, sorted
 */
function draw(doc) {
  const v = validate(doc);
  assert.deepEqual(v.errors, []);
  return collapsed(v).sort();
}

test('idle samples are left out, the same frames merge, and a sample weighs its interval', () => {
  assert.deepEqual(draw(convert(PROFILE)), ['(program) 1', 'main (app.js:10);a 2', 'main (app.js:10);b 1']);
});

test('--keep-idle keeps them', () => {
  assert.ok(draw(convert(PROFILE, {keepIdle: true})).includes('(idle) 3'));
});

test('the times of the samples left stay what they were', () => {
  const doc = convert(PROFILE);
  assert.deepEqual(doc.samples.time, [2, 1, 2, 1]);
  assert.equal(doc.end, 10_000_000);
});

test('a negative delta, a sample earlier than the one before, leaves the samples in time order', () => {
  const doc = convert({...PROFILE, samples: [6, 7, 6], timeDeltas: [3000, 2000, -4000]});
  assert.ok(doc.samples.time.every((/** @type {number} */ d) => d >= 0));
  // each weighs the median delta, 2 ms
  assert.deepEqual(draw(doc), ['main (app.js:10);a 4', 'main (app.js:10);b 2']);
});

test('the thread has a name, main unless told otherwise', () => {
  /** @param {any} doc */
  const names = doc => {
    const v = validate(doc);
    assert.deepEqual(v.errors, []);
    return doc.threads.map((/** @type {number[]} */ t) => v.strings[t[0]]);
  };
  assert.deepEqual(names(convert(PROFILE)), ['main']);
  assert.deepEqual(names(convert(PROFILE, {thread: 'worker'})), ['worker']);
});

test('the output is named name-date-cpu.fpk after the input', () => {
  assert.equal(basename(outputName('AgentHost-CPU-20261027T055457.457Z.cpuprofile.txt')), 'AgentHost-20261027T0554-cpu.fpk');
  assert.equal(basename(outputName('x/app.cpuprofile')), 'app-cpu.fpk');
  assert.equal(basename(outputName('20261027.cpuprofile.gz')), '20261027-cpu.fpk');
});

test('names are front-coded so that the document decodes to them', () => {
  const doc = convert(PROFILE);
  let previous = '';
  const names = doc.strings.map((/** @type {string} */ s) => previous = previous.substring(0, s.charCodeAt(0) - 32) + s.substring(1));
  assert.deepEqual(names, [...names].sort());
  assert.ok(names.includes('main (app.js:10)'));
});
