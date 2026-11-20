import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyBrewRatio, brewRatioOptions, buildBaseline, lookupReferences, mapRecipe, processes, roasts, targets, validateRecipe,
} from '../public/recipes/recipe-engine.js';

const bean = { name: 'Test bean', roast: 'medium', process: 'Washed' };

test('all target, roast and process combinations produce valid baselines', () => {
  let combinations = 0;
  for (const target of Object.keys(targets)) {
    for (const roast of roasts) {
      for (const process of ['', ...processes]) {
        const recipe = buildBaseline({ ...bean, roast, process }, target);
        assert.deepEqual(validateRecipe(recipe, recipe.water), [], `${target}, ${roast}, ${process}`);
        combinations += 1;
      }
    }
  }
  assert.equal(combinations, 420);
});

test('medium V60 uses the chart midpoint and unknown processes show a fallback', () => {
  const lightWashed = lookupReferences({ ...bean, roast: 'light' }, 'v60_hot');
  assert.equal(lightWashed.temperature, 95);
  assert.match(lightWashed.references.at(-1), /light, Washed → 95°C/);
  for (const [process, expected] of Object.entries({
    Washed: 94, 'Washed + ferment': 93, 'Yellow honey': 92,
    'Red honey': 91, Natural: 90, 'Natural + ferment': 89,
  })) {
    const result = lookupReferences({ ...bean, process }, 'v60_iced');
    assert.equal(result.temperature, expected);
    assert.match(result.assumptions.join(' '), /interpolated/);
  }
  const fallback = lookupReferences({ ...bean, process: 'Anaerobic' }, 'v60_hot');
  assert.match(fallback.assumptions.join(' '), /roast-only/);
  const aero = lookupReferences(bean, 'aeropress_iced');
  assert.equal(aero.temperature, 92);
  assert.match(aero.assumptions.join(' '), /provisional.*based on roast alone/);
  assert.equal(lookupReferences({ ...bean, roast: 'light', process: 'Natural' }, 'aeropress_inverted').temperature, 94);
  assert.equal(lookupReferences({ ...bean, roast: 'dark' }, 'aeropress_inverted').temperature, 89);
});

test('iced timelines share accounting but keep distinct steps', () => {
  const v60 = buildBaseline(bean, 'v60_iced');
  const aero = buildBaseline(bean, 'aeropress_iced');
  assert.equal(v60.steps.at(-1).type, 'Wait');
  assert.equal(aero.steps.at(-1).type, 'Press');
  assert.equal(v60.steps.at(-1).weight, null);
  const mapped = mapRecipe(v60);
  assert.equal(mapped.water, 150);
  assert.equal(mapped.steps.filter(step => step.weight !== null).at(-1).weight, 150);
  assert.match(mapped.steps[0].notes, /^Add 100 g ice/);
  assert.match(mapRecipe({ ...v60, ice: 105, steps: mapped.steps }).steps[0].notes,
    /^Add 105 g ice to the serving vessel\. Wet/);
});

test('invalid edits are rejected before saving', () => {
  const v60 = buildBaseline(bean);
  const overlap = structuredClone(v60);
  overlap.steps[1].startSec = 30;
  const wrongWeight = structuredClone(v60);
  wrongWeight.steps[2].weight = 245;
  assert.match(validateRecipe(overlap).join(' '), /must not overlap/);
  assert.match(validateRecipe(wrongWeight).join(' '), /final water-adding step/);
  assert.match(validateRecipe({ ...v60, clicks: 20, temp: 105 }).join(' '), /Temperature.*Grind/);
  assert.match(validateRecipe({ ...v60, coffee: 10 }).join(' '), /14–18 times/);
  assert.match(validateRecipe({ ...buildBaseline(bean, 'v60_iced'), ice: 0 }).join(' '), /ice weight/);
  const inverted = buildBaseline(bean, 'aeropress_inverted');
  assert.match(validateRecipe(inverted, 200).join(' '), /capacity/);
  assert.deepEqual(validateRecipe(inverted, 210), []);
});

test('selecting a V60 ratio preserves timing and scales cumulative pour weights', () => {
  const baseline = buildBaseline(bean);
  const adjusted = applyBrewRatio(baseline, 16);
  assert.equal(adjusted.water, 240);
  assert.deepEqual(adjusted.steps.map(step => step.weight), [43.2, 144, 240, null, null]);
  assert.deepEqual(adjusted.steps.map(({ weight, ...step }) => step), baseline.steps.map(({ weight, ...step }) => step));
  const restored = applyBrewRatio({ ...baseline, ...adjusted }, 250 / 15);
  assert.equal(restored.water, 250);
  assert.equal(restored.steps.at(2).weight, 250);
});

test('iced ratio includes ice, preserves the split, and replaces the ice instruction', () => {
  const baseline = buildBaseline(bean, 'v60_iced');
  const edited = { ...baseline, ice: 75, water: 150, steps: mapRecipe(baseline).steps };
  const adjusted = { ...edited, ...applyBrewRatio(edited, 16) };
  assert.equal(adjusted.water, 160);
  assert.equal(adjusted.ice, 80);
  assert.equal(adjusted.steps.at(2).weight, 160);
  assert.match(adjusted.steps[0].notes, /^Add 80 g ice to the serving vessel\. Wet/);
  assert.deepEqual(validateRecipe(adjusted), []);
});

test('ratio presets validate across decimal doses and respect inverted capacity', () => {
  for (const target of Object.keys(targets)) {
    for (const coffee of [10, 10.4, 15.3, 18, 29.9, 30]) {
      const baseline = { ...buildBaseline(bean, target), coffee };
      for (const ratio of brewRatioOptions(target)) {
        const adjusted = { ...baseline, ...applyBrewRatio(baseline, ratio) };
        assert.deepEqual(validateRecipe(adjusted, adjusted.water), [], `${target}, ${coffee} g, 1:${ratio}`);
      }
    }
  }
  const inverted = buildBaseline(bean, 'aeropress_inverted');
  assert.throws(() => applyBrewRatio(inverted, 17, 210), /exceeds your inverted brewer capacity/);
  assert.equal(applyBrewRatio(inverted, 14, 210).water, 196);
  assert.throws(() => applyBrewRatio({ ...inverted, steps: [] }, 14, 210), /final pour or bloom/);
});
