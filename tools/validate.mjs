#!/usr/bin/env node
// @ts-check
/**
 * Checks Flamepack documents against SPEC.md, and prints them as collapsed
 * stacks to see what a viewer will draw. No dependency.
 *
 *   node tools/validate.mjs [--collapsed] <file.flamepack.json[.gz]>...
 *
 * Exits with 1 when a document breaks a rule of the spec.
 */
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {gunzipSync} from 'node:zlib';

const OPERATION_COLUMNS = ['name', 'start', 'duration', 'thread', 'detail', 'status', 'failed', 'error', 'async',
                           'bytesIn', 'bytesOut'];

/**
 * @param {any} doc
 * @returns {{errors: string[], strings: string[], parent: number[], frame: number[]}} the
 *          rules it breaks, and what decoded of it
 */
export function validate(doc) {
  /** @type {string[]} */
  const errors = [];
  const fail = (/** @type {string} */ m) => errors.push(m);
  /** @type {string[]} */
  const strings = [];
  /** @type {number[]} */
  const parent = [], frame = [];
  const result = () => ({errors, strings, parent, frame});

  if (!doc || typeof doc !== 'object' || Array.isArray(doc))
    return fail('the document is not a JSON object'), result();
  if (doc.version !== 4)
    return fail(`version is ${JSON.stringify(doc.version)}, not 4`), result();
  if (doc.unit !== 'ms' && doc.unit !== 'bytes')
    fail(`unit is ${JSON.stringify(doc.unit)}, not "ms" or "bytes"`);
  if (!Array.isArray(doc.weights) || doc.weights.length !== 2 || !doc.weights.every(isNumber))
    fail('weights is not two numbers');
  if (typeof doc.start !== 'string')
    fail('start is not a string');
  else if (doc.start !== '' && Number.isNaN(Date.parse(doc.start)))
    fail(`start ${JSON.stringify(doc.start)} is not an ISO-8601 instant`);
  if (!isNumber(doc.end))
    fail('end is not a number');

  // strings, front-coded
  if (!Array.isArray(doc.strings))
    return fail('strings is not an array'), result();
  let previous = '';
  for (let i = 0; i < doc.strings.length; i++) {
    const s = doc.strings[i];
    if (typeof s !== 'string' || s.length === 0) {
      fail(`strings[${i}] is not a non-empty string`);
      return result();
    }
    const p = s.charCodeAt(0) - 32;
    if (p < 0 || p > 95)
      fail(`strings[${i}] starts with U+${s.charCodeAt(0).toString(16).padStart(4, '0')}, not a prefix length`);
    else if (p > previous.length)
      fail(`strings[${i}] shares ${p} units with a previous string of ${previous.length}`);
    strings.push(previous = previous.substring(0, p) + s.substring(1));
  }
  const seen = new Map();
  strings.forEach((s, i) => {
    if (seen.has(s))
      fail(`strings[${i}] repeats strings[${seen.get(s)}], ${JSON.stringify(s)}`);
    seen.set(s, i);
  });
  const isString = (/** @type {any} */ v) => Number.isInteger(v) && v >= 0 && v < strings.length;

  // stacks, depth first
  if (!Array.isArray(doc.stacks) || doc.stacks.length % 2 !== 0 || !doc.stacks.every(Number.isInteger))
    return fail('stacks is not an array of integer pairs'), result();
  /** @type {number[]} */
  const last = [];
  for (let i = 0; i < doc.stacks.length / 2; i++) {
    const depth = doc.stacks[2 * i], f = doc.stacks[2 * i + 1];
    if (depth < 0 || depth > last.length) {
      fail(`node ${i} is ${depth} deep, under no node ${depth - 1} deep`);
      return result();
    }
    if (f < 0 || f > 0x7fffffff || !isString(f >>> 3))
      fail(`node ${i} has frame ${f}, which names no string`);
    else if ((f & 7) > 5)
      fail(`node ${i} has frame type ${f & 7}, which is reserved`);
    parent.push(depth === 0 ? -1 : last[depth - 1]);
    frame.push(f);
    last.length = depth;
    last.push(i);
  }
  const nodes = parent.length;

  // threads
  const threads = Array.isArray(doc.threads) ? doc.threads : (fail('threads is not an array'), []);
  threads.forEach((/** @type {any} */ t, /** @type {number} */ i) => {
    if (!Array.isArray(t) || t.length !== 2 || !isString(t[0]) || !Number.isInteger(t[1]))
      fail(`threads[${i}] is not [string index, integer id]`);
  });

  // operations
  const o = doc.operations;
  let operations = 0;
  if (!o || typeof o !== 'object')
    fail('operations is not an object');
  else {
    const missing = OPERATION_COLUMNS.filter(c => !Array.isArray(o[c]) || !o[c].every(isNumber));
    if (missing.length)
      fail(`operations lacks the number columns ${missing.join(', ')}`);
    else {
      operations = o.name.length;
      const uneven = OPERATION_COLUMNS.filter(c => o[c].length !== operations);
      if (uneven.length)
        fail(`operations' columns ${uneven.join(', ')} are not of the length of name, ${operations}`);
      else
        for (let i = 0; i < operations; i++) {
          if (!isString(o.name[i]) || !isString(o.thread[i]))
            fail(`operation ${i} has a name or thread that is no string index`);
          if ((o.detail[i] !== -1 && !isString(o.detail[i])) || (o.error[i] !== -1 && !isString(o.error[i])))
            fail(`operation ${i} has a detail or error that is neither -1 nor a string index`);
          if (o.duration[i] < 0)
            fail(`operation ${i} has a negative duration`);
          for (const c of ['failed', 'async'])
            if (o[c][i] !== 0 && o[c][i] !== 1)
              fail(`operation ${i} has ${c} ${o[c][i]}, not 0 or 1`);
        }
    }
  }

  // samples
  const s = doc.samples;
  if (!s || typeof s !== 'object')
    return fail('samples is not an object'), result();
  const columns = ['time', 'stack', 'thread', 'operation', 'kind'];
  for (const c of ['weight', 'objects'])
    if (c in s)
      columns.push(c);
  const missing = columns.filter(c => !Array.isArray(s[c]) || !s[c].every(isNumber));
  if (missing.length)
    return fail(`samples lacks the number columns ${missing.join(', ')}`), result();
  const n = s.time.length;
  const uneven = columns.filter(c => s[c].length !== n);
  if (uneven.length)
    return fail(`samples' columns ${uneven.join(', ')} are not of the length of time, ${n}`), result();
  for (let i = 0; i < n; i++) {
    const at = `sample ${i}`;
    if (s.time[i] < 0)
      fail(`${at} is earlier than the previous one: samples are not sorted by time`);
    if (s.stack[i] !== -1 && !(Number.isInteger(s.stack[i]) && s.stack[i] >= 0 && s.stack[i] < nodes))
      fail(`${at} has stack ${s.stack[i]}, neither -1 nor a node`);
    if (!(Number.isInteger(s.thread[i]) && s.thread[i] >= 0 && s.thread[i] < threads.length))
      fail(`${at} has thread ${s.thread[i]}, not an index in threads`);
    if (s.operation[i] !== -1 && !(Number.isInteger(s.operation[i]) && s.operation[i] >= 0 && s.operation[i] < operations))
      fail(`${at} has operation ${s.operation[i]}, neither -1 nor an operation`);
    if (s.kind[i] !== 0 && s.kind[i] !== 1)
      fail(`${at} has kind ${s.kind[i]}, not 0 or 1`);
    if (errors.length > 20)
      break;
  }
  return result();
}

/**
 * @param {number} v
 * @returns {boolean}
 */
function isNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * @param {any} doc a valid document
 * @param {{strings: string[], parent: number[], frame: number[]}} decoded
 * @returns {string[]} its collapsed stacks, a line per path with its total weight, in first-seen order
 */
export function collapsed(doc, {strings, parent, frame}) {
  const s = doc.samples;
  /** @type {Map<string, number>} */
  const lines = new Map();
  for (let i = 0; i < s.time.length; i++) {
    const path = [];
    for (let node = s.stack[i]; node >= 0; node = parent[node])
      path.push(strings[frame[node] >>> 3]);
    const key = path.reverse().join(';') || '(no stack)';
    const w = s.weight ? s.weight[i] : doc.weights[s.kind[i]];
    lines.set(key, (lines.get(key) ?? 0) + w);
  }
  return [...lines].map(([k, w]) => `${k} ${w}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const print = args.includes('--collapsed');
  const files = args.filter(a => a !== '--collapsed');
  if (!files.length) {
    console.error('usage: node tools/validate.mjs [--collapsed] <file.flamepack.json[.gz]>...');
    process.exit(2);
  }
  let ok = true;
  for (const file of files) {
    let bytes = readFileSync(file);
    if (bytes[0] === 0x1f && bytes[1] === 0x8b)
      bytes = gunzipSync(bytes);
    let doc;
    try {
      doc = JSON.parse(bytes.toString('utf8'));
    }
    catch (e) {
      console.log(`${file}: not JSON: ${/** @type {Error} */ (e).message}`);
      ok = false;
      continue;
    }
    const v = validate(doc);
    if (v.errors.length) {
      ok = false;
      console.log(`${file}: invalid`);
      v.errors.forEach(e => console.log(`  ${e}`));
    }
    else {
      console.log(`${file}: valid, ${doc.samples.time.length} samples, ${v.parent.length} nodes, ${v.strings.length} strings`);
      if (print)
        collapsed(doc, v).forEach(l => console.log(`  ${l}`));
    }
  }
  process.exit(ok ? 0 : 1);
}
