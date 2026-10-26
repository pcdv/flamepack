# Flamepack

A JSON format for stack samples, to draw flame graphs from: the collapsed stacks of
[FlameGraph](https://github.com/brendangregg/FlameGraph), packed with a string
dictionary and a shared stack tree, and enriched with each sample's time, thread and
operation, frame types and per-sample metrics. Everything but the stacks is optional.

```
main;parse 12          →   {"version": 5, "unit": "count",
main;read 5                 "strings": [" main", " parse", " read"],
main 3                      "stacks": {"depth": [0, 1, 1], "name": [0, 1, 2]},
                            "samples": {"stack": [1, 1, 1], "weight": [3, 12, 5]}}
```

Files end in `.flamepack.json`, or `.flamepack.json.gz` when gzipped.

- [SPEC.md](SPEC.md): the format, version 5 (draft). [SPEC-4.md](SPEC-4.md): version 4, which
  jfr-web's server still writes, and every tool below reads.
- [schema/](schema/): the shape of each version, as a JSON Schema.
- [examples/](examples/): a minimal profile, a server's with operations, a heap's; the same in
  version 4 under [examples/v4/](examples/v4/).
- [tools/validate.mjs](tools/validate.mjs): checks documents of either version against the
  spec, with no dependency: `node tools/validate.mjs [--collapsed] <file>...`.
- [tools/upgrade.mjs](tools/upgrade.mjs): converts a version 4 document to version 5:
  `node tools/upgrade.mjs <in> <out>`.
- `npm test` checks the examples, and that converting them changes nothing they draw.

## Who reads and writes it

- [jfr-web](https://github.com/pcdv/jfr-web), where the format comes from, writes it from JFR
  recordings (time and allocation samples), as version 4, and draws versions 4 and 5.
- [jheap](https://github.com/pcdv/jheap) writes the paths of a JVM heap dump as one, version 5,
  and reads both.
- [mountain-graph](https://github.com/pcdv/mountain-graph) draws any of them as a landscape, and
  writes the heaps it exports, and the reduced ones, as version 5.

Nothing in the format is specific to Java: a profiler for another language, or a converter
from collapsed stacks, can write it and have it drawn by these tools. See "A minimal document"
in the spec.

## License

Apache License 2.0.
