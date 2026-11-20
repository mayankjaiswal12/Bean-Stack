import assert from 'node:assert/strict';
import test from 'node:test';
import { brewDuration, brewPosition, formatClock, moveTimelineStep, summarizeJournal, timelineFor } from '../public/recipes/brewing.js';

test('the timer follows recipe time, including gaps and exact step boundaries', () => {
  const timeline = timelineFor([
    { type: 'Pour', startMin: 1, durSec: 30 },
    { type: 'Bloom', startSec: 5, durSec: 40 },
    { type: 'Invalid', startSec: 10, durSec: 0 },
  ]);
  assert.deepEqual(timeline.map(step => [step.start, step.end]), [[5, 45], [60, 90]]);
  assert.equal(brewDuration(timeline), 90);
  assert.deepEqual(brewPosition(timeline, 0), { active: -1, next: 0, end: 90, remaining: 5 });
  assert.equal(formatClock(brewPosition(timeline, 44.1).remaining), '00:01');
  assert.deepEqual(brewPosition(timeline, 45), { active: -1, next: 1, end: 90, remaining: 15 });
  assert.equal(brewPosition(timeline, 60).active, 1);
  assert.equal(brewPosition(timeline, 90).remaining, 0);
  assert.equal(formatClock(60.1), '01:01');
});

test('reordering retimes the copied steps and preserves gaps and duration', () => {
  const steps = [
    { label: 'Bloom', startSec: 5, durSec: 30 },
    { label: 'Pour', startSec: 45, durSec: 20 },
  ];
  const result = moveTimelineStep(steps, 1, -1);
  assert.deepEqual(timelineFor(result).map(step => [step.label, step.start, step.end]), [
    ['Pour', 5, 25],
    ['Bloom', 35, 65],
  ]);
  assert.equal(steps[0].label, 'Bloom');
  assert.equal(moveTimelineStep(steps, 0, -1), steps);
});

test('analytics use logged brews, ignore unrated entries in averages, and keep empty dates honest', () => {
  const today = new Date(2026, 10, 20, 12);
  const entries = [
    { date: new Date(2026, 10, 20, 10), bean: 'Mooley', method: 'Hot V60', rating: 4 },
    { date: new Date(2026, 10, 20, 11), bean: 'Mooley', method: 'Hot V60', rating: 0 },
    { date: new Date(2026, 10, 19, 11), bean: 'Decaf', method: 'AeroPress', rating: 2 },
  ];
  const stats = summarizeJournal(entries, today);
  assert.equal(stats.total, 3);
  assert.equal(stats.average, 3);
  assert.equal(stats.favoriteMethod, 'Hot V60');
  assert.deepEqual(stats.topBeans, [['Mooley', 2], ['Decaf', 1]]);
  assert.equal(stats.days.at(-1).count, 2);
  assert.equal(stats.days.at(-1).rating, 4);
  assert.equal(stats.days[0].rating, null);
  assert.equal(summarizeJournal([], today).average, null);
});
