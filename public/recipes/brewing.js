export function timelineFor(steps = []) {
  return steps.map(step => {
    const start = Number(step.startMin || 0) * 60 + Number(step.startSec || 0);
    const duration = Number(step.durMin || 0) * 60 + Number(step.durSec || 0);
    return { ...step, start, end: start + duration };
  }).filter(step => Number.isFinite(step.end) && step.start >= 0 && step.end > step.start)
    .sort((left, right) => left.start - right.start);
}

export function brewDuration(timeline) {
  return timeline.reduce((end, step) => Math.max(end, step.end), 0);
}

export function brewPosition(timeline, elapsed) {
  const end = brewDuration(timeline);
  const active = timeline.findLastIndex(step => step.start <= elapsed && elapsed < step.end);
  const next = timeline.findIndex(step => step.start > elapsed);
  return { active, next, end, remaining: Math.max(0, (timeline[active]?.end ?? timeline[next]?.start ?? end) - elapsed) };
}

export function moveTimelineStep(steps, index, offset) {
  const destination = index + offset;
  if (index < 0 || index >= steps.length || destination < 0 || destination >= steps.length) return steps;
  const ordered = [...steps];
  [ordered[index], ordered[destination]] = [ordered[destination], ordered[index]];
  let elapsed = Number(steps[0].startMin || 0) * 60 + Number(steps[0].startSec || 0);
  return ordered.map((step, position) => {
    const start = elapsed;
    const original = steps[position];
    const next = steps[position + 1];
    const originalEnd = (Number(original.startMin || 0) + Number(original.durMin || 0)) * 60 +
      Number(original.startSec || 0) + Number(original.durSec || 0);
    const nextStart = next ? Number(next.startMin || 0) * 60 + Number(next.startSec || 0) : originalEnd;
    const gap = Math.max(0, nextStart - originalEnd);
    elapsed += Number(step.durMin || 0) * 60 + Number(step.durSec || 0) + gap;
    return { ...step, startMin: Math.floor(start / 60), startSec: start % 60 };
  });
}

export function formatClock(seconds) {
  const value = Math.max(0, Math.ceil(seconds));
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

export function brewDate(value) {
  const date = value?.toDate ? value.toDate()
    : Number.isFinite(value?.seconds) ? new Date(value.seconds * 1000) : new Date(value ?? NaN);
  return Number.isFinite(date.getTime()) ? date : null;
}

const dateKey = date => [date.getFullYear(), date.getMonth() + 1, date.getDate()].join('-');

export function summarizeJournal(entries, now = new Date()) {
  const methodCount = new Map();
  const beanCount = new Map();
  const byDate = new Map();
  let ratingTotal = 0;
  let ratings = 0;
  for (const entry of entries) {
    const day = brewDate(entry.date);
    const rating = entry.rating >= 1 && entry.rating <= 5 ? Number(entry.rating) : 0;
    if (entry.method) methodCount.set(entry.method, (methodCount.get(entry.method) ?? 0) + 1);
    if (entry.bean) beanCount.set(entry.bean, (beanCount.get(entry.bean) ?? 0) + 1);
    if (rating) {
      ratingTotal += rating;
      ratings += 1;
    }
    if (day) {
      const key = dateKey(day);
      const bucket = byDate.get(key) ?? { count: 0, ratingTotal: 0, ratings: 0 };
      bucket.count += 1;
      if (rating) {
        bucket.ratingTotal += rating;
        bucket.ratings += 1;
      }
      byDate.set(key, bucket);
    }
  }
  const sorted = counts => [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const days = Array.from({ length: 14 }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (13 - index));
    const bucket = byDate.get(dateKey(date));
    return { date, count: bucket?.count ?? 0, rating: bucket?.ratings ? bucket.ratingTotal / bucket.ratings : null };
  });
  return {
    total: entries.length,
    average: ratings ? ratingTotal / ratings : null,
    favoriteMethod: sorted(methodCount)[0]?.[0] ?? null,
    topBeans: sorted(beanCount).slice(0, 5),
    days,
  };
}
