import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeExplain } from '../../src/index.ts';
import { FIXTURES, loadFixture } from '../fixtures/index.ts';

/**
 * The table from `../fixtures/index.ts`, executed. One test per payload, each
 * asserting the verdict that payload must produce.
 */

for (const fixture of FIXTURES) {
  test(`${fixture.file}: ${fixture.describes}`, () => {
    const report = analyzeExplain(loadFixture(fixture.file));

    assert.deepEqual(
      report.findings.map((finding) => finding.rule).sort(),
      [...fixture.expectedRules].sort(),
      `wrong verdict for ${fixture.file}`,
    );

    for (const [key, expected] of Object.entries(fixture.expectedSummary ?? {})) {
      assert.equal(
        report.summary[key as keyof typeof report.summary],
        expected,
        `summary.${key} for ${fixture.file}`,
      );
    }

    if (fixture.expectsInconclusiveNote === true) {
      assert.ok(
        report.notes.some((note) => note.kind === 'inconclusive'),
        'expected an inconclusive note',
      );
    }
  });
}

test('every finding states its evidence and what it means', () => {
  for (const fixture of FIXTURES) {
    for (const finding of analyzeExplain(loadFixture(fixture.file)).findings) {
      assert.ok(finding.title.length > 0, `${fixture.file}: finding has no verdict`);
      assert.ok(finding.evidence.length > 0, `${fixture.file}: ${finding.rule} has no numbers`);
      assert.ok(
        finding.explanation.length > 0,
        `${fixture.file}: ${finding.rule} explains nothing — that is the tool that already exists`,
      );
    }
  }
});
