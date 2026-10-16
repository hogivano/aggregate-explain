# Explain fixtures

Each file is one `explain("executionStats")` payload, and each has a row in
`../index.ts` naming the verdict it must produce. That table is the test suite.

## Provenance

These are hand-built to the shapes documented in the MongoDB manual, covering
the four layouts the normaliser has to collapse — aggregation `stages` array,
pushed-down (`optimizedPipeline`), slot-based (`explainVersion: "2"`), and
sharded — across server 6.0, 7.0 and 8.0.

They are **not a substitute for captured output.** Replace and extend them with
payloads from real clusters as you get access to them; a fixture captured from a
server is evidence, and a fixture written from documentation is a hypothesis.
`@mongodb-js/atlas-local` makes generating the real thing practical in CI.

## Adding one

1. Capture it:

   ```js
   JSON.stringify(db.orders.explain('executionStats').aggregate(pipeline))
   ```

2. Drop it in here, named `<what-it-shows>-<server version>.json`.
3. Add a row to `FIXTURES` in `../index.ts` with the rules it must produce.

A payload that should produce **no** findings is worth more than another that
produces one. False positives are what get a tool uninstalled.
