import test from 'node:test';
import assert from 'node:assert/strict';
import { extractDates, toLocalDate } from '../src/store/date-extract.js';

test('extracts ISO dates', () => {
  assert.deepEqual(extractDates('Shipped on 2003-12-11 after review.'), ['2003-12-11']);
});

test('extracts written-month dates with a year', () => {
  assert.deepEqual(extractDates('Met on Jan 20, 2003 to discuss.'), ['2003-01-20']);
  assert.deepEqual(extractDates('Deadline is January 5, 2024'), ['2024-01-05']);
});

test('does not extract ambiguous slash dates', () => {
  assert.deepEqual(extractDates('Filed on 01/22/2022 per the form.'), []);
});

test('does not extract written-month dates without a year', () => {
  assert.deepEqual(extractDates('We met on Jan 20 to discuss.'), []);
});

test('ignores version strings and issue refs', () => {
  assert.deepEqual(extractDates('Bumped to v1.2.3, see issue #2024 for context.'), []);
});

test('skips dates inside fenced code blocks', () => {
  const body = [
    'Some notes.',
    '```',
    'const date = "2020-01-01";',
    '```',
    'Actual date: 2021-05-06',
  ].join('\n');
  assert.deepEqual(extractDates(body), ['2021-05-06']);
});

test('rejects invalid calendar dates', () => {
  assert.deepEqual(extractDates('Bad date 2024-13-40 appears here.'), []);
});

test('dedupes and sorts multiple dates', () => {
  assert.deepEqual(
    extractDates('Started 2024-03-01, then again 2024-01-15, and 2024-03-01 once more.'),
    ['2024-01-15', '2024-03-01']
  );
});

test('toLocalDate converts a UTC instant to the given timezone\'s calendar date', () => {
  // 2026-08-19T01:17:20Z is still 2026-08-18 in US Pacific (UTC-7 in August, DST).
  assert.equal(toLocalDate('2026-08-19T01:17:20.792Z', 'America/Los_Angeles'), '2026-08-18');
  // Same instant is already 2026-08-19 in UTC itself.
  assert.equal(toLocalDate('2026-08-19T01:17:20.792Z', 'UTC'), '2026-08-19');
  // And late morning UTC crosses into the next day for a timezone far ahead of UTC.
  assert.equal(toLocalDate('2026-08-18T23:30:00.000Z', 'Pacific/Auckland'), '2026-08-19');
});

test('toLocalDate defaults to the OS-resolved timezone when none is passed', () => {
  const osZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.equal(toLocalDate('2026-08-19T01:17:20.792Z'), toLocalDate('2026-08-19T01:17:20.792Z', osZone));
});
