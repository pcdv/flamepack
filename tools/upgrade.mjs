#!/usr/bin/env node
// @ts-check
/**
 * Converts a Flamepack document of version 4 to version 5, leaving out what holds
 * its default. No dependency.
 *
 *   node tools/upgrade.mjs <in.flamepack.json[.gz]> <out.flamepack.json[.gz]>
 *
 * The output is gzipped when its name ends in .gz.
 */
import {writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {gzipSync} from 'node:zlib';
import {readDocument, validate} from './validate.mjs';

/** The members of version 4, which are converted; the others are copied. */
const MEMBERS = new Set(['version', 'unit', 'weights', 'start', 'end', 'strings', 'stacks', 'samples', 'threads',
                         'operations']);

/** The optional columns of operations, with their defaults. */
const OPERATION_DEFAULTS = {detail: -1, error: -1, failed: 0, async: 0, status: 0, bytesIn: 0, bytesOut: 0};

/**
 * @param {number[]} column
 * @param {number} value
 * @returns {boolean} whether it holds nothing else
 */
const only = (column, value) => column.every(v => v === value);

/**
 * @param {any} doc a valid document of version 4
 * @returns {any} the same profile, of version 5
 */
export function upgrade(doc) {
  if (doc.version !== 4)
    throw new Error(`version ${doc.version}, not 4`);
  const s = doc.samples, n = s.time.length;
  /** @type {any} */
  const out = {version: 5, unit: doc.unit};

  // a kind only when the samples have two; one weight when they share it
  const kinds = !only(s.kind, 0);
  if (!s.weight) {
    const weights = kinds ? doc.weights : [doc.weights[0]];
    if (!(weights.length === 1 && weights[0] === 1))
      out.weights = weights;
  }
  else if (kinds)
    out.weights = doc.weights;
  // jfr-web wrote "null" for a start it did not know
  if (doc.start !== '' && doc.start !== 'null')
    out.start = doc.start;
  if (doc.end !== 0)
    out.end = doc.end;
  out.strings = doc.strings;

  /** @type {number[]} */
  const depth = [], name = [], type = [];
  for (let i = 0; i < doc.stacks.length; i += 2) {
    depth.push(doc.stacks[i]);
    name.push(doc.stacks[i + 1] >>> 3);
    type.push(doc.stacks[i + 1] & 7);
  }
  out.stacks = only(type, 0) ? {depth, name} : {depth, name, type};

  // samples with no time in any order: by stack, the differences then mostly 1
  const order = [...Array(n).keys()];
  if (only(s.time, 0))
    order.sort((a, b) => s.stack[a] - s.stack[b] || a - b);
  /** @type {Record<string, number[]>} */
  const samples = {};
  let previous = 0;
  samples.stack = order.map(i => {
    const d = s.stack[i] + 1 - previous;
    previous = s.stack[i] + 1;
    return d;
  });
  if (!only(s.time, 0))
    samples.time = s.time;
  if (!only(s.thread, 0))
    samples.thread = order.map(i => s.thread[i]);
  if (!only(s.operation, -1))
    samples.operation = order.map(i => s.operation[i]);
  if (kinds)
    samples.kind = order.map(i => s.kind[i]);
  for (const c of ['weight', 'objects'])
    if (Array.isArray(s[c]))
      samples[c] = order.map(i => s[c][i]);
  out.samples = samples;

  // an operation's thread was a name: the first thread of that name, or a new one
  const threads = doc.threads.map((/** @type {number[]} */ t) => [...t]);
  const o = doc.operations;
  if (o.name.length) {
    /** @type {Map<number, number>} */
    const byName = new Map();
    threads.forEach((/** @type {number[]} */ t, /** @type {number} */ i) => byName.has(t[0]) || byName.set(t[0], i));
    const thread = o.thread.map((/** @type {number} */ name) => {
      let t = byName.get(name);
      if (t === undefined) {
        byName.set(name, t = threads.length);
        threads.push([name, -1]);
      }
      return t;
    });
    /** @type {Record<string, number[]>} */
    const operations = {name: o.name, start: o.start, duration: o.duration, thread};
    for (const [c, value] of Object.entries(OPERATION_DEFAULTS))
      if (!only(o[c], value))
        operations[c] = o[c];
    out.threads = threads;
    out.operations = operations;
  }
  else
    out.threads = threads;

  for (const [k, v] of Object.entries(doc))
    if (!MEMBERS.has(k))
      out[k] = v;
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error('usage: node tools/upgrade.mjs <in.flamepack.json[.gz]> <out.flamepack.json[.gz]>');
    process.exit(2);
  }
  const doc = readDocument(input);
  const errors = validate(doc).errors;
  if (errors.length) {
    console.error(`${input}: invalid`);
    errors.forEach(e => console.error(`  ${e}`));
    process.exit(1);
  }
  const json = JSON.stringify(upgrade(doc));
  writeFileSync(output, output.endsWith('.gz') ? gzipSync(json, {level: 9}) : json);
}
