#!/usr/bin/env node
// @ts-check
/**
 * Converts a V8 CPU profile (.cpuprofile: Node's --cpu-prof, Chrome DevTools, VS Code's
 * host profiles) to a Flamepack document of version 5. No dependency.
 *
 *   node tools/cpuprofile.mjs [--keep-idle] [--thread <name>] <in.cpuprofile[.txt]> [<out.fpk[.gz]>]
 *
 * The output is gzipped when its name ends in .gz; without one, it is named
 * name-date-cpu.fpk after the input. The thread is called main unless --thread says
 * otherwise (a profile is of one thread, and does not name it). V8 records the idle time as samples
 * of a node called (idle), which usually are nearly all of them; they are left out
 * unless --keep-idle is given, and the times of the others stay what they were.
 */
import {readFileSync, writeFileSync} from 'node:fs';
import {basename, dirname, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {gunzipSync, gzipSync} from 'node:zlib';

/** The frame type of a frame that is not code: (program), (idle), (garbage collector). */
const SYNTHETIC = 4;

/**
 * @typedef {object} CallFrame
 * @property {string} functionName
 * @property {string} url
 * @property {number} lineNumber from 0, -1 when unknown
 *
 * @typedef {object} Node
 * @property {number} id
 * @property {CallFrame} callFrame
 * @property {number[]} [children]
 *
 * @typedef {object} CpuProfile
 * @property {Node[]} nodes
 * @property {number} startTime in µs
 * @property {number} endTime in µs
 * @property {number[]} samples the id of each sample's node
 * @property {number[]} timeDeltas in µs, the first since startTime
 */

/**
 * @param {CallFrame} frame
 * @returns {string} `function (file:line)`, with the file's name only: a path is of no use to a viewer
 */
function frameName({functionName, url, lineNumber}) {
  if (functionName.startsWith('('))
    return functionName;
  const file = url.substring(Math.max(url.lastIndexOf('/'), url.lastIndexOf('\\')) + 1);
  const where = file === '' ? '' : lineNumber >= 0 ? ` (${file}:${lineNumber + 1})` : ` (${file})`;
  return (functionName === '' ? '(anonymous)' : functionName) + where;
}

/**
 * @param {string[]} sorted distinct strings, in UTF-16 order
 * @returns {string[]} front-coded, as the spec's `strings`
 */
function frontCode(sorted) {
  let previous = '';
  return sorted.map(s => {
    let p = 0;
    const max = Math.min(previous.length, s.length, 95);
    while (p < max && previous.charCodeAt(p) === s.charCodeAt(p))
      p++;
    // a prefix must not end between the two halves of a surrogate pair
    if (p > 0 && (s.charCodeAt(p - 1) & 0xFC00) === 0xD800)
      p--;
    previous = s;
    return String.fromCharCode(32 + p) + s.substring(p);
  });
}

/**
 * @param {CpuProfile} profile
 * @param {{keepIdle?: boolean, thread?: string}} [options] thread: the name of the thread the profile is of
 * @returns {any} the same samples, as a document of version 5
 */
export function convert(profile, {keepIdle = false, thread = 'main'} = {}) {
  const {nodes, samples, timeDeltas} = profile;
  /** @type {Map<number, Node>} */
  const byId = new Map(nodes.map(n => [n.id, n]));

  // the frames, once each, in order
  const frames = new Set();
  /** @type {Map<number, {name: string, type: number}>} */
  const frameOf = new Map();
  for (const n of nodes) {
    const name = frameName(n.callFrame);
    frameOf.set(n.id, {name, type: n.callFrame.functionName.startsWith('(') ? SYNTHETIC : 0});
    frames.add(name);
  }
  frames.add(thread);
  const strings = [...frames].sort();
  const index = new Map(strings.map((s, i) => [s, i]));

  // the stack tree, depth first. The root is no frame: its children are the roots. Two nodes
  // with the same frame under one parent (V8 tells them apart by column, or script) merge.
  /** @type {number[]} */
  const depth = [], name = [], type = [];
  /** @type {Map<number, number>} V8 node id → node of the tree, plus 1 */
  const stackOf = new Map();
  const root = nodes[0];
  stackOf.set(root.id, 0);

  /**
   * @param {Node} parent
   * @param {number} d
   */
  const visit = (parent, d) => {
    /** @type {Map<string, number>} */
    const seen = new Map();
    /** @type {Map<number, Node[]>} the V8 nodes that merge into each tree node */
    const merged = new Map();
    /** @type {number[]} */
    const order = [];
    for (const id of parent.children ?? []) {
      const child = /** @type {Node} */ (byId.get(id)), f = /** @type {any} */ (frameOf.get(id));
      const key = `${f.name}\n${f.type}`;
      let slot = seen.get(key);
      if (slot === undefined) {
        seen.set(key, slot = order.length);
        order.push(id);
        merged.set(id, []);
      }
      /** @type {Node[]} */ (merged.get(order[slot])).push(child);
    }
    for (const first of order) {
      const f = /** @type {any} */ (frameOf.get(first));
      depth.push(d);
      name.push(/** @type {number} */ (index.get(f.name)));
      type.push(f.type);
      const at = depth.length;
      // the children of all the nodes that merged are those of the merged node
      const group = /** @type {Node[]} */ (merged.get(first));
      for (const g of group)
        stackOf.set(g.id, at);
      visit({id: first, callFrame: group[0].callFrame, children: group.flatMap(g => g.children ?? [])}, d + 1);
    }
  };
  visit(root, 0);

  // the samples: the interval is the usual gap between two, so that a sample weighs what it stood for
  const sorted = [...timeDeltas].sort((a, b) => a - b);
  const interval = sorted.length ? Math.round(sorted[sorted.length >> 1]) / 1000 : 1;
  /** @type {number[]} */
  const stack = [], time = [];
  let previousStack = 0, previousTime = 0, clock = 0;
  /** @type {{s: number, t: number}[]} */
  const kept = [];
  samples.forEach((id, i) => {
    clock += timeDeltas[i];
    if (!keepIdle && byId.get(id)?.callFrame.functionName === '(idle)')
      return;
    kept.push({s: stackOf.get(id) ?? 0, t: Math.round(clock / 1000)});
  });
  // V8's deltas can be negative, a sample then earlier than the one before: the spec wants them in time order
  // (a stable sort, so that samples of one millisecond stay in the order they came in)
  kept.sort((a, b) => a.t - b.t);
  for (const {s, t} of kept) {
    stack.push(s - previousStack);
    previousStack = s;
    time.push(t - previousTime);
    previousTime = t;
  }

  /** @type {any} */
  const out = {version: 5, unit: 'ms'};
  out.weights = [interval];
  out.end = Math.round((profile.endTime - profile.startTime) * 1000);
  out.strings = frontCode(strings);
  out.stacks = type.every(t => t === 0) ? {depth, name} : {depth, name, type};
  out.samples = time.every(t => t === 0) ? {stack} : {time, stack};
  out.threads = [[index.get(thread), -1]];
  out.meta = {producer: 'flamepack tools/cpuprofile.mjs', kind: 'cpu'};
  return out;
}

/**
 * @param {string} file a .cpuprofile, possibly gzipped, whatever its name
 * @returns {CpuProfile}
 */
export function readProfile(file) {
  let bytes = readFileSync(file);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b)
    bytes = gunzipSync(bytes);
  const profile = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(profile.nodes) || !Array.isArray(profile.samples) || !Array.isArray(profile.timeDeltas))
    throw new Error(`${file}: not a .cpuprofile (nodes, samples and timeDeltas expected)`);
  return profile;
}

/**
 * @param {string} input
 * @returns {string} `name-date-cpu.fpk` beside the input: its name before a date such as 20261027T055457,
 *   without a trailing "cpu", then that date to the minute; the whole name without its extensions if it has no date
 */
export function outputName(input) {
  const base = basename(input).replace(/(\.txt|\.gz)*$/, '').replace(/\.cpuprofile$/, '');
  const m = /^(.*?)[-_.]?(\d{8}(?:T\d{4})?)\d*.*$/.exec(base);
  const stem = (m ? m[1] : base).replace(/[-_.]?cpu$/i, '');
  return join(dirname(input), `${[stem, m?.[2], 'cpu'].filter(Boolean).join('-')}.fpk`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  let keepIdle = false, thread, bad = false;
  /** @type {string[]} */
  const files = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--keep-idle')
      keepIdle = true;
    else if (args[i] === '--thread')
      (thread = args[++i]) ?? (bad = true);
    else
      files.push(args[i]);
  }
  const [input, output = input && outputName(input)] = files;
  if (!input || files.length > 2 || bad) {
    console.error('usage: node tools/cpuprofile.mjs [--keep-idle] [--thread <name>] <in.cpuprofile[.txt]> [<out.fpk[.gz]>]');
    process.exit(2);
  }
  const json = JSON.stringify(convert(readProfile(input), {keepIdle, thread}));
  writeFileSync(output, output.endsWith('.gz') ? gzipSync(json, {level: 9}) : json);
  console.log(output);
}
