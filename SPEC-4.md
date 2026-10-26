# Flamepack, version 4

Status: superseded by [version 5](SPEC.md). This describes version 4 as jfr-web, jheap
and mountain-graph write and read it, for readers that still meet such files.

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

Version 4 comes from [jfr-web](https://github.com/pcdv/jfr-web), which writes it from
JFR recordings. Its field names show that origin, but the format does not depend on
Java: a producer for any language fills the same fields (see
[A minimal document](#a-minimal-document)).

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## Implementations

| Project | Writes | Reads |
|---|---|---|
| [jfr-web](https://github.com/pcdv/jfr-web) | `ProfileWriter.java`: time samples and allocation samples of a JFR recording | `profile/profile.js` |
| [jheap](https://github.com/pcdv/jheap) | `profile/document.rs`: the paths of a heap dump | `profile/document.rs` |
| [mountain-graph](https://github.com/pcdv/mountain-graph) | `profile/heap.js`: an exported heap | `load.js`, a copy of jfr-web's `profile.js`; also reads version 3 |

## File

- A document is a single JSON object (RFC 8259), encoded in UTF-8.
- The file name SHOULD end in `.flamepack.json`, or `.flamepack.json.gz` when it is
  gzipped. Readers SHOULD detect gzip from its first two bytes (`1f 8b`) rather than
  from the name. Served over HTTP, it is `application/json`, possibly with
  `Content-Encoding: gzip`.
- All indexes count from 0. Where an index may be absent, it is -1.
- Integers MUST stay within ±2^53, so that JavaScript reads them exactly.

## Overview

```json
{"version": 4,
 "unit": "ms",
 "weights": [10, 10],
 "start": "2026-10-25T09:00:00Z", "end": 50000000,
 "strings": [" MainThread", " compute", " main", " parse_body", "&header", " read_file"],
 "stacks": [0, 16, 1, 40, 1, 32, 1, 24, 2, 8],
 "samples": {"time": [0, 10, 10, 10, 10], "stack": [1, 2, 3, 4, 4],
             "thread": [0, 0, 0, 0, 0], "operation": [-1, -1, -1, -1, -1], "kind": [0, 0, 0, 0, 0]},
 "threads": [[0, 1]],
 "operations": {"name": [], "start": [], "duration": [], "thread": [], "detail": [], "status": [],
                "failed": [], "error": [], "async": [], "bytesIn": [], "bytesOut": []}}
```

Decoded, these are the collapsed stacks:

```
main;read_file 10
main;parse_header 10
main;parse_body 10
main;parse_body;compute 20
```

## Members

All the members below are REQUIRED unless marked optional.

| Member | Type | Content |
|---|---|---|
| `version` | integer | `4` |
| `unit` | string | what weights count: `"ms"` (time) or `"bytes"` (memory) |
| `weights` | `[number, number]` | the weight of a sample of kind 0 and of kind 1, for samples with no `samples.weight` |
| `start` | string | when the profile starts, as an ISO-8601 instant; `""` when it has no wall-clock time |
| `end` | number | when it ends, in ns since `start`; `0` when unknown |
| `strings` | string[] | the dictionary, front-coded |
| `stacks` | integer[] | the stack tree, as pairs `depth, frame` |
| `samples` | object | the samples, as columns |
| `threads` | `[integer, integer][]` | the threads |
| `operations` | object | the operations, as columns |

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
beginnings shared. Nodes are written depth first, in pre-order, each as two integers:

- `depth`: 0 for a root (the outermost frame, e.g. `main` or a thread's entry point);
  otherwise its parent's depth plus 1. The parent of a node is the last node written
  before it at depth - 1. So a node's depth MUST be at most the previous node's depth
  plus 1, and the first node's depth MUST be 0.
- `frame`: `string << 3 | type`, i.e. `string * 8 + type`, where `string` is an index
  in `strings` and `type` is one of the [frame types](#frame-types). Frames MUST fit in
  a signed 32-bit integer, so a document holds at most 2^28 strings.

Node *i* is the pair at positions 2*i* and 2*i* + 1. Two children of one node SHOULD
NOT have the same frame.

Decoding, in JavaScript:

```js
const n = doc.stacks.length / 2, parent = new Int32Array(n), frame = new Int32Array(n), last = [];
for (let i = 0; i < n; i++) {
  const depth = doc.stacks[2 * i];
  parent[i] = depth === 0 ? -1 : last[depth - 1];
  frame[i] = doc.stacks[2 * i + 1];
  last[depth] = i;
}
```

#### Frame types

| Type | Name | Meaning |
|---|---|---|
| 0 | compiled | an ordinary frame. Producers with no notion of types write 0 |
| 1 | inlined | a method inlined into its caller by a JIT compiler |
| 2 | interpreted | a method run by an interpreter |
| 3 | native | native code: a JNI method, a C extension, a system call |
| 4 | synthetic | not code: a marker such as `(truncated)`, the bottom of a stack cut short |
| 5 | allocated | in a memory profile, the type of what was allocated, on top of the stack that allocated it |
| 6, 7 | | reserved |

The type belongs to the node: the same method compiled in one stack and interpreted
in another makes two nodes. Viewers merge frames by name and MAY show the share of
each type, e.g. in colours or a tooltip.

### `samples`

An object of columns, all of the same length, one entry per sample. Samples MUST be
sorted by time.

| Column | Type | Content |
|---|---|---|
| `time` | number[] | time since `start`, in ms, written as the difference with the previous sample's (the first one's since `start`), hence never negative. SHOULD be integers |
| `stack` | integer[] | the node of the sample's innermost frame, its path being that node and its ancestors; -1 when the sample has no stack. Any node, not only a leaf |
| `thread` | integer[] | an index in `threads` |
| `operation` | integer[] | an index in `operations`; -1 outside any operation |
| `kind` | integer[] | 0 or 1, picking the sample's weight in `weights` when there is no `weight` column. jfr-web uses 1 for samples of a thread running native code, 0 for all others |
| `weight` | number[] | optional: the weight of each sample, in `unit`, overriding `weights` |
| `objects` | number[] | optional, for a heap: the number of objects each sample stands for, `weight` being their bytes |

The weight of sample *i* is `weight[i]` when `weight` is present, otherwise
`weights[kind[i]]`.

A sample without a stack still counts: its weight goes to its operation or thread.

### `threads`

One `[name, id]` pair per thread: `name` an index in `strings`, `id` an integer chosen
by the producer (the JVM's thread id, an OS thread id). Viewers show a thread as
`[name tid=id]`, under the samples outside operations. Every document whose samples
are not empty has at least one thread.

### `operations`

What the program was doing when sampled, beyond its stack: a request it served, a job
it ran. Viewers group samples by operation name, and can compute counts and
percentiles of durations from these columns.

An object of eleven columns, all REQUIRED and all of the same length, one entry per
operation; all empty when there are none. The `id` of an operation is its index.

| Column | Type | Content |
|---|---|---|
| `name` | integer[] | an index in `strings`, e.g. `GET /users/:id` |
| `start` | number[] | the start in ns since `start`, written as the difference with the previous operation's; negative when it started before the previous one |
| `duration` | number[] | in ns |
| `thread` | integer[] | the name of the thread that ran it, or that ended it if it was asynchronous: an index in `strings`, not in `threads` |
| `detail` | integer[] | an index in `strings` (e.g. the request's parameters), -1 for none |
| `status` | integer[] | the HTTP status of a request, 0 for other operations |
| `failed` | integer[] | 1 if it failed, else 0 |
| `error` | integer[] | an index in `strings`, the error's message, -1 for none |
| `async` | integer[] | 1 if it was asynchronous, possibly ending on another thread than it started on, else 0 |
| `bytesIn` | number[] | bytes received, 0 if unknown |
| `bytesOut` | number[] | bytes sent, 0 if unknown |

Operations are listed in any order; times in ns keep the totals and percentiles
exact.

## Kinds of profiles

| Profile | `unit` | Samples |
|---|---|---|
| Time | `ms` | one per stack sample, its weight the sampling interval, from `weights` |
| Allocations | `bytes` | one per allocation sample, its weight in `weight`; the allocated type on top of each stack, of type 5 |
| Heap | `bytes` | one per path from a GC root to the objects at its end, all at time 0, with `weight` and `objects`; `start` is `""`, `end` 0, one thread named `all`, no operations |

## A minimal document

A producer that knows only stacks and weights, such as a profiler for another
language or a converter from collapsed stacks, writes:

- `unit` `"ms"` (or `"bytes"`), `weights` `[w, w]`, all `kind` 0;
- one sample per stack sample, or one per distinct stack with its total in `weight`;
- `time` all 0 if it has no times, `start` `""` and `end` 0;
- one thread, or one per thread it knows;
- `operation` all -1, and the eleven `operations` columns empty;
- frame types 0, 3 for native code, 4 for markers.

[examples/v4/minimal.flamepack.json](examples/v4/minimal.flamepack.json) is such a document.

## Extensions and versions

- Readers MUST ignore members they do not know. A producer MAY add members, at any
  level, when ignoring them leaves the rest of the document correct. Such an addition
  keeps the version. `samples.objects` was added this way, and jheap adds a top-level
  `heap` member with its own report.
- Any other change, such as a new required member or a new meaning for an existing one,
  raises the version. Readers MUST refuse a version they do not know rather than
  misread it. A reader MAY read older versions.

History, before the format had a name:

1. operations had names only;
2. their other columns added;
3. `start` and `end` added;
4. `unit`, and `samples.weight` for allocation samples. A version 3 document reads as
   version 4 with `unit` `"ms"`.

## Known quirks of version 4

To be considered for version 5; listed here so producers and readers are not
surprised.

- `unit` has no value for plain counts: collapsed stacks converted to Flamepack must
  pretend their counts are ms.
- `kind` and the two `weights` are specific to JFR's Java and native samples.
- The eleven `operations` columns are required even when empty, and are shaped after
  HTTP requests (`status`, `bytesIn`, `bytesOut`).
- `operations.thread` is a string index, while `samples.thread` is an index in
  `threads`.
- jfr-web writes `start` as `"null"` when the recording's start is unknown.
- Samples have times in ms and operations in ns.
- Frames have no source file or line.
- Readers check the version for equality, so even an addition that older readers
  could ignore cannot be signalled without breaking them; a minor version would allow
  it.
- There is no metadata about the producer or the profiled program.
