/**
 * The domain: explain output in, verdicts out. No I/O, no dependencies, no
 * Mongoose. Everything here is a pure function over plain objects, which is what
 * makes it testable against static fixtures and immune to driver and ODM
 * versions alike.
 */
export * from './errors.ts';
export * from './finding.ts';
export * from './json.ts';
export * from './normalize.ts';
export * from './plan-node.ts';
export * from './rules/index.ts';
export * from './suggest/index.ts';
export * from './units.ts';
