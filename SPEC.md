# Flamepack, version 5

Status: draft. jheap and mountain-graph write it for a heap, and jfr-web, jheap and
mountain-graph read it; jfr-web's server still writes [version 4](SPEC-4.md), which they
read too. [tools/upgrade.mjs](tools/upgrade.mjs) converts a version 4 document to version 5;
[Differences from version 4](#differences-from-version-4) lists what a reader of both must
know.

Flamepack is a JSON document holding the stack samples of a profile, from which a
viewer draws flame graphs, timelines and tables. It is close to the collapsed stacks
of [FlameGraph](https://github.com/brendangregg/FlameGraph) (`main;parse;read 12`),
with three differences:

- **Packed.** Each name is written once, in a front-coded dictionary, and each stack
  once, as a node of a prefix tree shared by all stacks. A sample refers to a node.
- **Sample by sample.** A row can be a single sample with its time, thread and
  operation, so a viewer can filter by interval, thread or operation without going
  back to the source. A row can also stand for many samples, through its weight, as
  a line of collapsed stacks does.
- **Enriched.** Frame types (compiled, interpreted, native…), operations (requests,
  jobs) with their timings, and per-sample metrics.

Everything but the stacks and their samples is optional: a member a profile has no
use for is left out, and reads as its default. A heap has no times, threads or
operations; a converted collapsed-stacks file has nothing but stacks and weights.

The format comes from [jfr-web](https://github.com/pcdv/jfr-web), which writes it from
JFR recordings, but it does not depend on Java: a producer for any language fills the
same members (see [A minimal document](#a-minimal-document)).

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## Implementations

| Project | Version 4 | Version 5 |
|---|---|---|
| [jfr-web](https://github.com/pcdv/jfr-web) | writes (`ProfileWriter.java`), reads (`profile/profile.js`) | |
| [jheap](https://github.com/pcdv/jheap) | writes and reads (`profile/document.rs`) | |
| [mountain-graph](https://github.com/pcdv/mountain-graph) | writes (`profile/heap.js`), reads (`load.js`), also version 3 | |
| this repository | `tools/validate.mjs` checks | `tools/validate.mjs` checks, `tools/upgrade.mjs` writes from version 4 |

## File

- A document is a single JSON object (RFC 8259), encoded in UTF-8.
- The file name SHOULD end in `.fpk`, or `.fpk.gz` when it is gzipped. Readers SHOULD
  also accept `.flamepack.json` and `.flamepack.json.gz`, the names of version 4, and
  SHOULD detect gzip from its first two bytes (`1f 8b`) rather than from the name.
  A writer SHOULD write plain text unless asked to compress, so that the file opens in
  any editor. Served over HTTP, it is `application/json`, possibly with
  `Content-Encoding: gzip`.
- To help browsing many files, a tool SHOULD name the ones it writes
  `name-date-kind.fpk`: what was profiled, the date as `20261027` or `20261027T1432`
  so that names sort by time, and the kind of profile, `meta.kind`.
  This is a convention for people; no reader depends on it.
- All indexes count from 0. Where an index may be absent, it is -1.
- Integers MUST stay within ±2^53, so that JavaScript reads them exactly.
- Several columns are written as **differences**: each value is the difference with
  the previous one, the first one's with 0. A reader sums them as it goes. This keeps
  the numbers small where they mostly grow, which is what makes the document compress.

## Overview

```json
{"version": 5,
 "unit": "ms",
 "weights": [10],
 "start": "2026-10-25T09:00:00Z", "end": 50000000,
 "strings": [" MainThread", " compute", " main", " parse_body", "&header", " read_file"],
 "stacks": {"depth": [0, 1, 1, 1, 2], "name": [2, 5, 4, 3, 1]},
 "samples": {"time": [0, 10, 10, 10, 10], "stack": [2, 1, 1, 1, 0]},
 "threads": [[0, 1]]}
```

Decoded, these are the collapsed stacks:

```
main;read_file 10
main;parse_header 10
main;parse_body 10
main;parse_body;compute 20
```

## Members

| Member | Type | Content | When absent |
|---|---|---|---|
| `version` | integer | `5` | REQUIRED |
| `minor` | integer | the minor version, see [Versions](#versions) | `0` |
| `unit` | string | what weights count: `"ms"` (time), `"bytes"` (memory) or `"count"` (occurrences) | REQUIRED |
| `weights` | number[] | the weight of a sample of each kind, for samples with no `samples.weight` | `[1]` |
| `start` | string | when the profile starts, as an ISO-8601 instant; `""` when it has no wall-clock time | `""` |
| `end` | number | when it ends, in ns since `start`; `0` when unknown | `0` |
| `strings` | string[] | the dictionary, front-coded | REQUIRED |
| `stacks` | object | the stack tree, as columns | REQUIRED |
| `samples` | object | the samples, as columns | REQUIRED |
| `threads` | `[integer, integer][]` | the threads | one thread, with no name and id 0 |
| `operations` | object | the operations, as columns | no operations |
| `meta` | object | what produced the profile, and of what | nothing known |

A reader fills each absent member, and each absent column below, with its default; it
then reads the document as if the member had been written. A writer SHOULD leave out a
member or a column that holds only its default.

### `strings`

Every name the document uses: frames, threads, operations, details and errors.

- Each string MUST appear once: viewers merge frames by string index, so a name
  written twice would split into two frames.
- Strings SHOULD be sorted by UTF-16 code unit (the order of JavaScript's default
  sort and Java's `String.compareTo`), which makes the front coding effective.
  Readers MUST NOT rely on the order.
- Each string is **front-coded** against the previous one. Its first character is a
  code: its code point minus 32 is the length *p* of the prefix it shares with the
  previous decoded string, counted in UTF-16 code units. The rest of the encoded
  string follows that prefix. So `"&header"` after `"parse_body"` is `"parse_"`
  (`&` is 38, *p* = 6) followed by `header`.
- *p* MUST be between 0 and 95, so the code is a character from U+0020 to U+007F,
  and at most the length of the previous string. The previous string of the first
  one is `""`, so its code is always a space.
- A writer MUST NOT end the prefix between the two halves of a surrogate pair, which
  would leave a lone surrogate in the JSON.

Decoding, in JavaScript:

```js
let previous = '';
const strings = doc.strings.map(s => previous = previous.substring(0, s.charCodeAt(0) - 32) + s.substring(1));
```

### `stacks`

The stack tree: a node for each distinct path from a root frame, the paths' common
beginnings shared. Nodes are written depth first, in pre-order, as an object of
columns, all of the same length, one entry per node. Node *i* is entry *i* of each.

| Column | Type | Content | When absent |
|---|---|---|---|
| `depth` | integer[] | 0 for a root (the outermost frame, e.g. `main` or a thread's entry point); otherwise its parent's depth plus 1 | REQUIRED |
| `name` | integer[] | the frame's name, an index in `strings` | REQUIRED |
| `type` | integer[] | one of the [frame types](#frame-types) | all 0 |

The parent of a node is the last node written before it with a depth one less. So a
node's depth MUST be at most the previous node's depth plus 1, and the first node's
depth MUST be 0. Two children of one node SHOULD NOT have the same name and type.

Decoding, in JavaScript:

```js
const {depth, name} = doc.stacks, n = depth.length, type = doc.stacks.type ?? new Array(n).fill(0);
const parent = new Int32Array(n), last = [];
for (let i = 0; i < n; i++) {
  parent[i] = depth[i] === 0 ? -1 : last[depth[i] - 1];
  last[depth[i]] = i;
}
```

#### Frame types

| Type | Name | Meaning |
|---|---|---|
| 0 | compiled | an ordinary frame. Producers with no notion of types write 0, or no `type` column |
| 1 | inlined | a method inlined into its caller by a JIT compiler |
| 2 | interpreted | a method run by an interpreter |
| 3 | native | native code: a JNI method, a C extension, a system call |
| 4 | synthetic | not code: a marker such as `(truncated)`, the bottom of a stack cut short |
| 5 | allocated | in a memory profile, the type of what was allocated, on top of the stack that allocated it |
| 6 and up | | reserved |

The type belongs to the node: the same method compiled in one stack and interpreted
in another makes two nodes. Viewers merge frames by name and MAY show the share of
each type, e.g. in colours or a tooltip.

### `samples`

An object of columns, all of the same length, one entry per sample: the length of
`stack` is the number of samples. Samples MUST be sorted by time.

| Column | Type | Content | When absent |
|---|---|---|---|
| `stack` | integer[] | the node of the sample's innermost frame, plus 1, written as differences; so 0 once summed is a sample with no stack. Its path is that node and its ancestors, any node, not only a leaf | REQUIRED |
| `time` | number[] | time since `start`, in ms, written as differences, hence never negative. SHOULD be integers | all 0 |
| `thread` | integer[] | an index in `threads` | all 0 |
| `operation` | integer[] | an index in `operations`; -1 outside any operation | all -1 |
| `kind` | integer[] | an index in `weights`, picking the sample's weight when there is no `weight` column | all 0 |
| `weight` | number[] | the weight of each sample, in `unit`, overriding `weights` | |
| `objects` | number[] | for a heap: the number of objects each sample stands for, `weight` being their bytes | |

The weight of sample *i* is `weight[i]` when `weight` is present, otherwise
`weights[kind[i]]`. jfr-web gives its two kinds of time samples, of threads running
Java code and of threads running native code, weights of their own: JFR takes them at
different intervals.

A sample without a stack still counts: its weight goes to its operation or thread.

Decoding the stacks, in JavaScript:

```js
let sum = 0;
const stack = doc.samples.stack.map(d => (sum += d) - 1);   // -1 for no stack
```

Samples sorted by stack, as a producer that merges them per stack writes them, have
differences of 1 or a little more: such a column costs almost nothing compressed.

### `threads`

One `[name, id]` pair per thread: `name` an index in `strings`, or -1 for a thread with
no name; `id` an integer chosen by the producer (the JVM's thread id, an OS thread id),
or -1 when unknown. Viewers show a thread as `[name tid=id]`, under the samples outside
operations.

When `threads` is absent, the document has one thread, with no name and id 0: the
samples of a heap, or of a profile that does not tell threads apart.

### `operations`

What the program was doing when sampled, beyond its stack: a request it served, a job
it ran. Viewers group samples by operation name, and can compute counts and
percentiles of durations from these columns.

An object of columns, all of the same length, one entry per operation. The `id` of an
operation is its index.

| Column | Type | Content | When absent |
|---|---|---|---|
| `name` | integer[] | an index in `strings`, e.g. `GET /users/:id` | REQUIRED |
| `start` | number[] | the start in ns since `start`, written as differences; negative when it started before the previous one | REQUIRED |
| `duration` | number[] | in ns | REQUIRED |
| `thread` | integer[] | the thread that ran it, or that ended it if it was asynchronous: an index in `threads`; -1 when unknown | all -1 |
| `detail` | integer[] | an index in `strings` (e.g. the request's parameters), -1 for none | all -1 |
| `error` | integer[] | an index in `strings`, the error's message, -1 for none | all -1 |
| `failed` | integer[] | 1 if it failed, else 0 | all 0 |
| `async` | integer[] | 1 if it was asynchronous, possibly ending on another thread than it started on, else 0 | all 0 |
| `status` | integer[] | for a request, its HTTP status; 0 for none | all 0 |
| `bytesIn` | number[] | for a request, the bytes received; 0 if unknown | all 0 |
| `bytesOut` | number[] | for a request, the bytes sent; 0 if unknown | all 0 |

Operations are listed in any order. Their times are in ns, unlike the samples', so
that their totals and percentiles are exact.

### `meta`

What a viewer can show about the profile, all optional strings:

| Member | Content |
|---|---|
| `producer` | the program that wrote the document, and its version: `jheap 0.4.0` |
| `title` | a short name for the profile: `checkout service, 60 s of CPU` |
| `description` | what was profiled, and how |
| `kind` | the kind of profile, for file names and lists: `wall`, `cpu`, `alloc`, `heap` or `count`; a producer MAY use another word |

A producer MAY add other members to `meta`, prefixed with its own name (`jfr-web.settings`).

### Data of a tool

Any tool MAY store what it likes in a document, to get it back when the file is opened
again, or by whoever it is shared with: mountain-graph can save its view settings, so
that the same landscape shows.

- It goes in one top-level member named after the tool (`heap` for jheap), or in
  `meta`, as above. A tool never writes in another's member.
- It is not part of the profile: validators ignore it, and a reader that does not know
  it drops it.
- A tool that rewrites a document SHOULD keep the members it does not know, or the data
  of the others is lost.
- It SHOULD stay small beside the profile, and a tool SHOULD say what it stores: a file
  that is shared carries it, and paths or host names in it go with the file.

## Kinds of profiles

| Profile | `unit` | Samples |
|---|---|---|
| Time | `ms` | one per stack sample, with `time`, `thread` and `operation`; its weight the sampling interval, from `weights` |
| Allocations | `bytes` | one per allocation sample, with `time` and `thread`, its weight in `weight`; the allocated type on top of each stack, of type 5 |
| Heap | `bytes` | one per path from a GC root to the objects at its end, with `weight` and `objects`; no `time`, `threads` or `operations`, `start` and `end` absent |
| Counts | `count` | one per distinct stack, with its occurrences in `weight`: collapsed stacks converted |

## A minimal document

A producer that knows only stacks and weights, such as a profiler for another
language or a converter from collapsed stacks, writes `version`, `unit`, `strings`,
`stacks` (`depth` and `name`) and `samples` (`stack`, and `weight` unless all samples
weigh the same), one sample per distinct stack:

```json
{"version": 5, "unit": "count",
 "strings": [" main", " parse", " read"],
 "stacks": {"depth": [0, 1, 1], "name": [0, 1, 2]},
 "samples": {"stack": [1, 1, 1], "weight": [3, 12, 5]}}
```

[examples/minimal.fpk](examples/minimal.fpk) is such a document.

## Extensions and versions

- Readers MUST ignore members they do not know. A producer MAY add members, at any
  level, when ignoring them leaves the rest of the document correct; it SHOULD name
  them after itself or put them in `meta`. jheap adds a top-level `heap` member with
  its own report.

### Versions

- `version` is the major version. A change that a reader of the previous version would
  misread, such as a new required member or a new meaning for an existing one, raises
  it. Readers MUST refuse a major version they do not know rather than misread it. A
  reader MAY read older ones.
- `minor` counts the additions to a major version that its readers can ignore: an
  optional member or column whose absence means what it meant before. A writer SHOULD
  set the lowest minor that has all it writes. Readers MUST read any minor of a major
  version they know.

This is version 5.0.

History, before the format had a name:

1. operations had names only;
2. their other columns added;
3. `start` and `end` added;
4. `unit`, and `samples.weight` for allocation samples. A version 3 document reads as
   version 4 with `unit` `"ms"`;
5. everything optional but the stacks and their samples; stacks as columns, samples'
   stacks as differences; see below.

## Differences from version 4

A reader of both versions decodes a version 4 document as follows, then goes on as
for version 5:

| Version 4 | Version 5 |
|---|---|
| every member required, every column of `samples` and `operations` too | all optional but `version`, `unit`, `strings`, `stacks`, `samples.stack`, and `name`, `start` and `duration` of `operations` |
| `stacks`: pairs `depth, frame`, `frame` = `string << 3 \| type` | `stacks`: columns `depth`, `name`, `type` |
| `samples.stack`: the node, -1 for none | the node plus 1, as differences |
| `weights`: two numbers, `kind` 0 or 1 | any number of weights, `kind` an index in them |
| `unit`: `ms` or `bytes` | also `count` |
| `operations.thread`: the name of the thread, an index in `strings` | the thread, an index in `threads` |
| thread names and ids required | a thread's name or id may be -1 |
| `start` `"null"` from jfr-web when unknown | `""`, or absent |
| no `minor`, no `meta` | `minor`, `meta` |

`tools/upgrade.mjs` converts a version 4 document. An operation's thread becomes the
first thread of its name; a thread known only from an operation is added, with id -1.

## Known quirks of version 5

- Samples have times in ms and operations in ns: the samples' differences stay small
  numbers, the operations' totals exact.
- Frames have no source file or line.
- `status`, `bytesIn` and `bytesOut` are shaped after HTTP requests; being optional,
  they cost nothing to other operations.
