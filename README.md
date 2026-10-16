# aggregate-explain

> `explain()` tells you everything and explains nothing.

```
$ npx aggregate-explain explain.json

  Pipeline: 4.2s · 1 finding
  shop.orders · 1,840,000 docs examined · 1,840,000 returned · mongod 7.0.14

  ! $group (stage 2) spilled to disk
      usedDisk: true · 3 spills · 89MB written · 412,000 records
      spilledDataStorageSize: 40MB on disk

      The stage exceeded its 100MB in-memory limit and wrote to disk to
      finish. It completed rather than erroring because spilling was allowed —
      the default on modern servers, and what `allowDiskUse: true` buys on
      older ones — and that disk write is where the wall-clock time went.
```

Works on any explain output: mongosh, the driver, or Mongoose 5 through 9.
No connection, no agent, no account.

## Use it

```bash
# a file
npx aggregate-explain explain.json

# or a pipe
mongosh --quiet --eval 'JSON.stringify(
  db.orders.explain("executionStats").aggregate(pipeline)
)' | npx aggregate-explain
```

Exit codes are the CI contract: `0` no findings, `1` findings, `2` the input
could not be read. `--json` gives the same report as a stable machine payload,
`--min-severity high` raises the bar for failing a build.

### Index suggestions

Pass the collection's index list and an index analysis comes with the findings:

```bash
mongosh --quiet --eval 'JSON.stringify({
  indexes: db.orders.getIndexes(),
  documentCount: db.orders.estimatedDocumentCount()
})' > indexes.json

npx aggregate-explain explain.json --indexes indexes.json
```

```
  = Index analysis · shop.applications (COLLSCAN)
      equality organisationId
      sort     —
      range    —
      key      { organisationId: 1 }
      existing _id_ { _id: 1 } · status_1 { status: 1 }
      counts   1,240,000 read · 3,100 matched (0.3%) · 4,010,000 in the
               collection

      Suggested:
        db.applications.createIndex({ organisationId: 1 })

      Single-field equality, no index leads with this field, and the filter is
      selective. It still costs you on every write to this collection.
```

The analysis always runs. The **command** is printed only when the case is
unambiguous: a single-field equality match, no index leading with that field, a
filter selective enough to be worth one — and the collection's full index list
in hand. Everything else gets the E-S-R order and a sentence naming what made it
ambiguous, because compound, sort and range cases turn on write volume and
cardinality that no explain output carries.

Without `--indexes` there is no command at all. The plan names only the indexes
*this query* considered, and a `COLLSCAN` plan names none — so "I saw no index"
and "there is no index" look identical from here, and recommending a duplicate
of an index already there is the most common way these tools give bad advice.

### As a library

```ts
import { analyzeExplain } from 'aggregate-explain';

const report = analyzeExplain(await collection.aggregate(pipeline).explain('executionStats'), {
  collection: { indexes, documentCount }, // optional; without it, no commands
});
for (const finding of report.findings) console.log(finding.title);
```

### With Mongoose

```ts
import { analyzePipeline } from 'aggregate-explain/mongoose';

const report = await analyzePipeline(Order, pipeline);
```

It reads the collection's indexes and document count for you — best-effort, and
a collection that will not answer costs you the suggestion, not the report. Pass
`{ withCollectionContext: false }` to skip the two extra round trips.

Mongoose is an optional peer dependency. Importing the core never resolves it.

## What it checks

| Rule | Fires on |
|---|---|
| `disk-spill` | `usedDisk` on any stage — the 3–6 second mystery that looks like nothing on a CPU graph |
| `collection-scan` | a `COLLSCAN`, with the filter that ran unindexed |
| `unselective-index` | an index that is used and still is not helping — usually wrong field order |
| `scan-ratio` | far more documents read than returned, when nothing more specific explains it |
| `unindexed-sort` | a sort no index provides — one dataset-growth away from a spill |

Each rule returns a verdict or nothing. When the data needed to decide is
missing it says so in a note; it never guesses. Every ratio has an absolute
floor, because 400 documents examined to return 40 is a 10:1 ratio and
completely fine — a tool that always finds something gets ignored.

## How it is built

```
core     explainOutput → Report          pure function, zero dependencies
plugin   Model.aggregate() wrapper       optional subpath, thin
```

`explain()` output is produced by the MongoDB **server**; Mongoose and the
driver only pass it through. So the part that does the work has no ODM
dependency at all, which is what makes it version-proof by construction and
testable against static fixtures — no database, no connection.

**The real compatibility matrix is MongoDB server version, not Mongoose
version.** The normaliser collapses four layouts into one internal tree —
aggregation `stages` array, pushed-down (`optimizedPipeline`), slot-based
execution (`explainVersion: "2"`), and sharded — so no rule has to know which
one it is looking at. A rule that had to branch on plan shape would be a rule
that silently finds nothing on the shape its author did not own.

```
src/
  domain/          the model and the rules — no I/O, no dependencies
    normalize.ts     four explain layouts → one tree
    plan-node.ts     that tree
    rules/           one file per rule, plus the registry that orders them
    suggest/         E-S-R analysis, and the gates that stop a bad suggestion
  application/
    analyze.ts       the use case: explain in, report out
  infrastructure/
    input/           the only file that touches the disk
  presentation/      argv, exit codes, and the two renderers
  mongoose/          the only place the Mongoose 5→9 matrix applies
test/
  fixtures/          the payloads and the verdict each must produce
```

## Not in scope

APM and dashboards (OpenTelemetry and Sentry own that), query rewriting, schema
analysis, index management, and anything that needs a database connection in the
core.

Index suggestions stay constrained, as above: only unambiguous cases, always
with the existing indexes and the document counts printed alongside. Every index
slows writes and costs RAM, and a tool that once tanked someone's write
throughput gets uninstalled.

## What implementing it corrected

Two assumptions in the original design were wrong, both found while implementing:

1. **Aggregation explain is sometimes a `stages` array.** The plan says it never
   is. Both shapes are real: stages the optimiser can push into the query layer
   produce the `find()`-shaped tree with `optimizedPipeline: true`, and stages it
   cannot — `$group` above all, the flagship rule's subject — stay in the
   aggregation layer and report their own spill counters inside `stages`. The
   normaliser handles both; `test/fixtures/explain/` covers both.
2. **Sharded aggregation explain nests under a `shards` object**, keyed by shard
   name, not an array. The array form exists too, in the `find`-shaped output, so
   both are accepted.

Also worth stating plainly: the stage numbers in a finding are positions in the
**executed** pipeline, not in the pipeline as written. The optimiser merges,
reorders and absorbs stages into `$cursor`, so the two do not reliably line up,
and pointing at the wrong line of somebody's code is worse than not pointing.

## Development

```bash
npm test        # the fixture table, executed
npm run build
```

`test/fixtures/explain/README.md` explains how to capture more fixtures. The
false-positive ones matter most.
