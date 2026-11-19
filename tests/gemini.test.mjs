import assert from 'node:assert/strict';
import test from 'node:test';
import { applySuggestion, createGeminiClient, makePrompt, normalizeSettings, readSettings, writeSettings } from '../public/recipes/gemini.js';
import { buildBaseline } from '../public/recipes/recipe-engine.js';

const bean = {
  name: 'Beans',
  roast: 'medium',
  process: 'Washed',
  tastingNotes: 'cocoa',
  notes: 'private journal entry',
};
const baseline = buildBaseline(bean);
const settings = { key: 'test-key', model: 'test-model' };

function reply(answer) {
  return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] });
}

function fakeClient(responses) {
  let time = 0;
  const calls = [];
  const waits = [];
  const client = createGeminiClient({
    fetchRequest: async (url, options) => {
      calls.push({ url, options });
      return responses.shift();
    },
    now: () => time,
    pause: async duration => {
      waits.push(duration);
      time += duration;
    },
  });
  return { client, calls, waits };
}

test('Gemini sees chart matches and supplied bag details', () => {
  const prompt = makePrompt(bean, baseline);
  assert.match(prompt, /medium, Washed → 94°C/);
  assert.match(prompt, /Timemore C3S/);
  assert.match(prompt, /cocoa/);
  assert.doesNotMatch(prompt, /private journal entry/);
});

test('a valid adjustment changes exactly one recipe field', () => {
  const result = applySuggestion(baseline, { adjustment: 'temperature', delta: -2, why: 'Try a cooler brew.' });
  assert.deepEqual(result.recipe, { ...baseline, temp: 92 });
  assert.equal(result.adjustment, 'temperature');
  assert.equal(applySuggestion(baseline, { adjustment: 'grind', delta: 3, why: 'Try coarser.' }), null);
  assert.equal(applySuggestion(baseline, { adjustment: 'none', delta: 1, why: 'Keep it.' }), null);
  assert.equal(applySuggestion(baseline, { adjustment: 'water', delta: -2, why: 'Try less.' }), null);
});

test('a suggestion at a grinder limit preserves the allowed recipe and explains the cap', () => {
  const atLimit = { ...baseline, clicks: 18 };
  const result = applySuggestion(atLimit, { adjustment: 'grind', delta: 1, why: 'Try coarser.' });
  assert.deepEqual(result.recipe, atLimit);
  assert.equal(result.adjustment, 'none');
  assert.match(result.why, /suggested 19 clicks.*limit is 18 clicks/);
});

test('request retries a rate limit once using Retry-After', async () => {
  const rateLimit = new Response(null, { status: 429, headers: { 'Retry-After': '15' } });
  const { client, calls, waits } = fakeClient([rateLimit, reply({ adjustment: 'none', delta: 0, why: 'Keep the baseline.' })]);
  const retries = [];
  const result = await client.refine(settings, bean, baseline, { onRetry: seconds => retries.push(seconds) });
  assert.equal(result.adjustment, 'none');
  assert.deepEqual(waits, [15_000]);
  assert.deepEqual(retries, [15]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent');
  assert.equal(calls[0].options.headers['x-goog-api-key'], 'test-key');
  assert.equal(JSON.parse(calls[0].options.body).generationConfig.responseMimeType, 'application/json');
});

test('malformed replies retry once and key failures do not retry', async () => {
  const { client, calls, waits } = fakeClient([Response.json({}), Response.json({})]);
  await assert.rejects(client.refine(settings, bean, baseline), /unreadable/);
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [12_000]);
  const badKey = fakeClient([new Response(null, { status: 403 })]);
  await assert.rejects(badKey.client.testKey(settings), /did not accept/);
  assert.equal(badKey.calls.length, 1);
});

test('settings persist in browser storage and can be removed', () => {
  const values = new Map();
  const storage = {
    getItem: key => values.get(key),
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
  assert.throws(() => normalizeSettings('key', '../model'), /valid Gemini model/);
  writeSettings(storage, settings);
  assert.deepEqual(readSettings(storage), settings);
  writeSettings(storage, { key: '' });
  assert.equal(readSettings(storage).key, '');
});
