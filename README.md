# Flamepack

A JSON format for stack samples, to draw flame graphs from: the collapsed stacks of
[FlameGraph](https://github.com/brendangregg/FlameGraph), packed with a string
dictionary and a shared stack tree, and enriched with each sample's time, thread and
operation, frame types and per-sample metrics.

```
main;parse_body;compute 20          →   {"version": 4, "unit": "ms",
main;read_file 10                        "strings": [" MainThread", " compute", " main", ...],
                                         "stacks": [0, 16, 1, 40, ...],
                                         "samples": {"time": [...], "stack": [...], ...}, ...}
```

Files end in `.flamepack.json`, or `.flamepack.json.gz` when gzipped.

- [SPEC.md](SPEC.md): the format, version 4.
- [schema/flamepack-4.schema.json](schema/flamepack-4.schema.json): its shape, as a JSON Schema.
- [examples/](examples/): a minimal profile, a server's with operations, a heap's.
- [tools/validate.mjs](tools/validate.mjs): checks documents against the spec, with no
  dependency: `node tools/validate.mjs [--collapsed] <file>...`. `npm test` checks the examples.

## Who reads and writes it

- [jfr-web](https://github.com/pcdv/jfr-web), where the format comes from, writes it from JFR
  recordings (time and allocation samples) and draws it.
- [jheap](https://github.com/pcdv/jheap) writes the paths of a JVM heap dump as one.
- [mountain-graph](https://github.com/pcdv/mountain-graph) draws any of them as a landscape.

Nothing in the format is specific to Java: a profiler for another language, or a converter
from collapsed stacks, can write it and have it drawn by these tools. See "A minimal document"
in the spec.

## License

Apache License 2.0.
