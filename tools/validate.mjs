#!/usr/bin/env node
// @ts-check
/**
 * Checks Flamepack documents, of version 5 (SPEC.md) or 4 (SPEC-4.md), and prints
 * them as collapsed stacks to see what a viewer will draw. No dependency.
 *
 *   node tools/validate.mjs [--collapsed] <file.fpk[.gz]>...
 *
 * Exits with 1 when a document breaks a rule of the spec.
 */
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {gunzipSync} from 'node:zlib';

const OPERATION_COLUMNS = ['name', 'start', 'duration', 'thread', 'detail', 'status', 'failed', 'error', 'async',
                           'bytesIn', 'bytesOut'];

/** The columns of operations a version 5 document must have when it has operations. */
const OPERATION_REQUIRED = ['name', 'start', 'duration'];

/** Frame types above this are reserved. */
const LAST_TYPE = 5;

/**
 * What a document decodes to, whatever its version.
 *
 * @typedef {object} Decoded
 * @property {string[]} strings
 * @property {number[]} parent of each node, -1 for a root
 * @property {number[]} name of each node, an index in strings
 * @property {number[]} type of each node
 * @property {number[]} stack of each sample, its node, -1 for none
 * @property {number[]} weight of each sample
 */

/**
 * @param {any} doc
 * @returns {{errors: string[]} & Decoded} the rules it breaks, and what decoded of it
 */
export function validate(doc) {
  /** @type {string[]} */
  const errors = [];
  const fail = (/** @type {string} */ m) => errors.push(m);
  /** @type {Decoded} */
  const decoded = {strings: [], parent: [], name: [], type: [], stack: [], weight: []};
  const result = () => ({errors, ...decoded});

  if (!doc || typeof doc !== 'object' || Array.isArray(doc))
    return fail('the document is not a JSON object'), result();
  if (doc.version !== 4 && doc.version !== 5)
    return fail(`version is ${JSON.stringify(doc.version)}, not 4 or 5`), result();
  const v5 = doc.version === 5;
  /**
   * @param {string} member
   * @returns {boolean} whether it is there; when it is not, whether version 4 requires it
   */
  const present = member => {
    if (member in doc)
      return true;
    if (!v5)
      fail(`${member} is missing`);
    return false;
  };

  if (v5 && 'minor' in doc && !(Number.isInteger(doc.minor) && doc.minor >= 0))
    fail('minor is not a non-negative integer');
  const units = v5 ? ['ms', 'bytes', 'count'] : ['ms', 'bytes'];
  if (!units.includes(doc.unit))
    fail(`unit is ${JSON.stringify(doc.unit)}, not ${units.map(u => JSON.stringify(u)).join(' or ')}`);
  /** @type {number[]} */
  let weights = [1];
  if (present('weights')) {
    if (!Array.isArray(doc.weights) || !doc.weights.every(isNumber) || (v5 ? doc.weights.length < 1 : doc.weights.length !== 2))
      fail(v5 ? 'weights is not a non-empty array of numbers' : 'weights is not two numbers');
    else
      weights = doc.weights;
  }
  if (present('start')) {
    if (typeof doc.start !== 'string')
      fail('start is not a string');
    else if (doc.start !== '' && Number.isNaN(Date.parse(doc.start)))
      fail(`start ${JSON.stringify(doc.start)} is not an ISO-8601 instant`);
  }
  if (present('end') && !isNumber(doc.end))
    fail('end is not a number');
  if (v5 && 'meta' in doc) {
    if (!doc.meta || typeof doc.meta !== 'object' || Array.isArray(doc.meta))
      fail('meta is not an object');
    else
      for (const m of ['producer', 'title', 'description', 'kind'])
        if (m in doc.meta && typeof doc.meta[m] !== 'string')
          fail(`meta.${m} is not a string`);
  }

  // strings, front-coded
  if (!Array.isArray(doc.strings))
    return fail('strings is not an array'), result();
  const strings = decoded.strings;
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

  // stacks, depth first: pairs in version 4, columns in version 5
  /** @type {number[]} */
  let depth, name, type;
  if (v5) {
    const st = doc.stacks;
    if (!st || typeof st !== 'object' || Array.isArray(st))
      return fail('stacks is not an object'), result();
    const missing = ['depth', 'name'].filter(c => !isIntegers(st[c]));
    if (missing.length)
      return fail(`stacks lacks the integer columns ${missing.join(', ')}`), result();
    depth = st.depth;
    name = st.name;
    if ('type' in st && !isIntegers(st.type))
      return fail('stacks.type is not an array of integers'), result();
    type = st.type ?? new Array(depth.length).fill(0);
    const uneven = ['name', 'type'].filter(c => c in st && st[c].length !== depth.length);
    if (uneven.length)
      return fail(`stacks' columns ${uneven.join(', ')} are not of the length of depth, ${depth.length}`), result();
  }
  else {
    if (!isIntegers(doc.stacks) || doc.stacks.length % 2 !== 0)
      return fail('stacks is not an array of integer pairs'), result();
    depth = [];
    name = [];
    type = [];
    for (let i = 0; i < doc.stacks.length / 2; i++) {
      const f = doc.stacks[2 * i + 1];
      if (f < 0 || f > 0x7fffffff)
        fail(`node ${i} has frame ${f}, out of a signed 32-bit integer`);
      depth.push(doc.stacks[2 * i]);
      name.push(f >>> 3);
      type.push(f & 7);
    }
  }
  /** @type {number[]} */
  const last = [];
  for (let i = 0; i < depth.length; i++) {
    if (depth[i] < 0 || depth[i] > last.length) {
      fail(`node ${i} is ${depth[i]} deep, under no node ${depth[i] - 1} deep`);
      return result();
    }
    if (!isString(name[i]))
      fail(`node ${i} has name ${name[i]}, which is no string`);
    if (type[i] < 0 || type[i] > LAST_TYPE)
      fail(`node ${i} has frame type ${type[i]}, which is reserved`);
    decoded.parent.push(depth[i] === 0 ? -1 : last[depth[i] - 1]);
    last.length = depth[i];
    last.push(i);
  }
  decoded.name = name;
  decoded.type = type;
  const nodes = depth.length;

  // threads
  /** @type {any[]} */
  let threads = v5 ? [[-1, 0]] : [];
  if (present('threads')) {
    if (!Array.isArray(doc.threads))
      fail('threads is not an array');
    else
      threads = doc.threads;
  }
  threads.forEach((t, i) => {
    if (!Array.isArray(t) || t.length !== 2 || !(isString(t[0]) || (v5 && t[0] === -1)) || !Number.isInteger(t[1]))
      fail(`threads[${i}] is not [${v5 ? 'string index or -1' : 'string index'}, integer id]`);
  });
  const isThread = (/** @type {any} */ v) => Number.isInteger(v) && v >= 0 && v < threads.length;

  // operations
  let operations = 0;
  if (present('operations')) {
    const o = doc.operations;
    if (!o || typeof o !== 'object' || Array.isArray(o))
      fail('operations is not an object');
    else {
      const required = v5 ? OPERATION_REQUIRED : OPERATION_COLUMNS;
      const missing = required.filter(c => !(c in o));
      const columns = OPERATION_COLUMNS.filter(c => c in o);
      const notNumbers = columns.filter(c => !Array.isArray(o[c]) || !o[c].every(isNumber));
      if (missing.length)
        fail(`operations lacks the columns ${missing.join(', ')}`);
      else if (notNumbers.length)
        fail(`operations' columns ${notNumbers.join(', ')} are not arrays of numbers`);
      else {
        operations = o.name.length;
        const uneven = columns.filter(c => o[c].length !== operations);
        if (uneven.length)
          fail(`operations' columns ${uneven.join(', ')} are not of the length of name, ${operations}`);
        else
          for (let i = 0; i < operations; i++) {
            const at = `operation ${i}`;
            if (!isString(o.name[i]))
              fail(`${at} has a name that is no string index`);
            if ('thread' in o && !(v5 ? o.thread[i] === -1 || isThread(o.thread[i]) : isString(o.thread[i])))
              fail(`${at} has thread ${o.thread[i]}, ${v5 ? 'neither -1 nor an index in threads' : 'no string index'}`);
            for (const c of ['detail', 'error'])
              if (c in o && o[c][i] !== -1 && !isString(o[c][i]))
                fail(`${at} has ${c} ${o[c][i]}, neither -1 nor a string index`);
            if (o.duration[i] < 0)
              fail(`${at} has a negative duration`);
            for (const c of ['failed', 'async'])
              if (c in o && o[c][i] !== 0 && o[c][i] !== 1)
                fail(`${at} has ${c} ${o[c][i]}, not 0 or 1`);
            if (errors.length > 20)
              break;
          }
      }
    }
  }

  // samples
  const s = doc.samples;
  if (!s || typeof s !== 'object' || Array.isArray(s))
    return fail('samples is not an object'), result();
  const required = v5 ? ['stack'] : ['time', 'stack', 'thread', 'operation', 'kind'];
  const columns = ['time', 'stack', 'thread', 'operation', 'kind', 'weight', 'objects'].filter(c => c in s);
  const missing = required.filter(c => !(c in s));
  if (missing.length)
    return fail(`samples lacks the columns ${missing.join(', ')}`), result();
  const notNumbers = columns.filter(c => !Array.isArray(s[c]) || !s[c].every(isNumber));
  if (notNumbers.length)
    return fail(`samples' columns ${notNumbers.join(', ')} are not arrays of numbers`), result();
  const by = v5 ? 'stack' : 'time', n = s[by].length;
  const uneven = columns.filter(c => s[c].length !== n);
  if (uneven.length)
    return fail(`samples' columns ${uneven.join(', ')} are not of the length of ${by}, ${n}`), result();
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const at = `sample ${i}`;
    const stack = v5 ? (sum += s.stack[i]) - 1 : s.stack[i];
    if (s.time && s.time[i] < 0)
      fail(`${at} is earlier than the previous one: samples are not sorted by time`);
    if (stack !== -1 && !(Number.isInteger(stack) && stack >= 0 && stack < nodes))
      fail(`${at} has stack ${stack}${v5 ? ' once summed' : ''}, neither -1 nor a node`);
    if (!isThread(s.thread ? s.thread[i] : 0))
      fail(`${at} has thread ${s.thread?.[i] ?? 0}, not an index in threads`);
    if (s.operation && s.operation[i] !== -1 && !(Number.isInteger(s.operation[i]) && s.operation[i] >= 0 && s.operation[i] < operations))
      fail(`${at} has operation ${s.operation[i]}, neither -1 nor an operation`);
    const kind = s.kind ? s.kind[i] : 0;
    if (!s.weight && !(Number.isInteger(kind) && kind >= 0 && kind < weights.length))
      fail(`${at} has kind ${kind}, not an index in weights`);
    decoded.stack.push(stack);
    decoded.weight.push(s.weight ? s.weight[i] : weights[kind]);
    if (errors.length > 20)
      break;
  }
  return result();
}

/**
 * @param {any} v
 * @returns {boolean}
 */
function isNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * @param {any} v
 * @returns {v is number[]}
 */
function isIntegers(v) {
  return Array.isArray(v) && v.every(Number.isInteger);
}

/**
 * @param {Decoded} decoded a valid document's
 * @returns {string[]} its collapsed stacks, a line per path with its total weight, in first-seen order
 */
export function collapsed({strings, parent, name, stack, weight}) {
  /** @type {Map<string, number>} */
  const lines = new Map();
  for (let i = 0; i < stack.length; i++) {
    const path = [];
    for (let node = stack[i]; node >= 0; node = parent[node])
      path.push(strings[name[node]]);
    const key = path.reverse().join(';') || '(no stack)';
    lines.set(key, (lines.get(key) ?? 0) + weight[i]);
  }
  return [...lines].map(([k, w]) => `${k} ${w}`);
}

/**
 * @param {string} file
 * @returns {boolean} whether it starts with the gzip magic bytes
 */
function isGzip(file) {
  const bytes = readFileSync(file);
  return bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * @param {string} file
 * @returns {any} the document in it, gzipped or not
 */
export function readDocument(file) {
  let bytes = readFileSync(file);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b)
    bytes = gunzipSync(bytes);
  return JSON.parse(bytes.toString('utf8'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const print = args.includes('--collapsed');
  const files = args.filter(a => a !== '--collapsed');
  if (!files.length) {
    console.error('usage: node tools/validate.mjs [--collapsed] <file.fpk[.gz]>...');
    process.exit(2);
  }
  let ok = true;
  for (const file of files) {
    let doc;
    try {
      doc = readDocument(file);
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
      console.log(`${file}: valid, ${isGzip(file) ? 'gzip' : 'plain'}, version ${doc.version}, ${v.stack.length} samples, ${v.parent.length} nodes, ` +
                  `${v.strings.length} strings`);
      if (print)
        collapsed(v).forEach(l => console.log(`  ${l}`));
    }
  }
  process.exit(ok ? 0 : 1);
}
