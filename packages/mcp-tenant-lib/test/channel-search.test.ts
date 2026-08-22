import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChannelMatches, scoreChannelMatch } from '../src/channel-search.js';

test('exact match scores 1', () => {
  assert.equal(scoreChannelMatch('pets', 'pets'), 1);
});

test('case-insensitive matching', () => {
  assert.equal(scoreChannelMatch('PETS', 'pets'), 1);
});

test('word-stem match: "pets" finds "pet_food_memory" via the shared word "pet"', () => {
  const matches = findChannelMatches('pets', ['pet_food_memory', 'totally_unrelated']);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.name, 'pet_food_memory');
});

test('typo tolerance: "pests" finds "pets_discussion"', () => {
  const matches = findChannelMatches('pests', ['pets_discussion', 'unrelated_thing']);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.name, 'pets_discussion');
});

test('unrelated names score below the default threshold and are excluded', () => {
  const matches = findChannelMatches('pets', ['totally_unrelated', 'onboarding_flow']);
  assert.deepEqual(matches, []);
});

test('results are ranked highest score first', () => {
  const matches = findChannelMatches('pets', ['pets', 'pet_food_memory']);
  assert.equal(matches[0]!.name, 'pets');
  assert.ok(matches[0]!.score >= matches[1]!.score);
});

test('findChannelMatches respects a custom minScore', () => {
  const looser = findChannelMatches('pets', ['prefs'], 0);
  assert.ok(looser.length >= 1, 'a low enough threshold should surface even a weak coincidental match');
  const stricter = findChannelMatches('pets', ['prefs'], 0.99);
  assert.deepEqual(stricter, []);
});
