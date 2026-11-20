import kit from './config/kit.json' with { type: 'json' };

export const targets = kit.targets;
export const roasts = Object.keys(kit.roasts);
export const processes = kit.processes;
export const stepTypes = new Set(['Bloom', 'Pour', 'Stir', 'Swirl', 'Wait', 'Press']);
export const temperatureRange = kit.limits.temperature;
export const defaultTarget = 'v60_hot';

function midpoint(left, right) {
  return Math.round((left + right) / 2);
}

export function lookupReferences(bean, targetId) {
  const target = Object.hasOwn(targets, targetId) && targets[targetId];
  const roast = Object.hasOwn(kit.roasts, bean.roast) && kit.roasts[bean.roast];
  if (!target || !roast) throw new Error('Choose a roast level and brew method.');

  const references = [`${kit.grindSource}: ${target.range.join('–')} clicks from zero for ${target.label}.`];
  const assumptions = [];
  if (target.brewer === 'AeroPress') {
    const temperature = target.temperature + roast.aeroPressTempOffset;
    assumptions.push(`${temperature}°C is a provisional ${target.label} starting temperature based on roast alone.`);
    return { temperature, references, assumptions };
  }

  const processIndex = processes.indexOf(bean.process);
  if (processIndex < 0 || processIndex > 6) {
    assumptions.push(`Using the ${bean.roast} roast-only temperature because the process has no chart entry.`);
    return { temperature: roast.fallback, references, assumptions };
  }

  const row = roast.v60 ?? kit.roasts['medium-light'].v60.map(
    (value, index) => midpoint(value, kit.roasts['medium-dark'].v60[index]),
  );
  if (!roast.v60) assumptions.push('Medium roast temperature is interpolated between medium-light and medium-dark.');
  const temperature = processIndex === 6 ? midpoint(row[2], row[3]) : row[processIndex];
  if (processIndex === 6) assumptions.push('Unspecified honey uses the average of yellow and red honey.');
  references.push(`${kit.temperatureSource}: ${bean.roast}, ${bean.process} → ${temperature}°C.`);
  return { temperature, references, assumptions };
}

export function buildBaseline(bean, targetId = defaultTarget) {
  const { temperature, references, assumptions } = lookupReferences(bean, targetId);
  const target = targets[targetId];
  const clicks = target.clicks + (target.adjustGrind ? kit.roasts[bean.roast].clickOffset : 0);
  let start = 0;
  const steps = target.timeline.map(([type, label, duration, weight, notes]) => {
    const step = {
      type, label, weight, notes,
      startMin: Math.floor(start / 60),
      startSec: start % 60,
      durMin: Math.floor(duration / 60),
      durSec: duration % 60,
    };
    start += duration;
    return step;
  });

  return {
    name: `${bean.name} · ${target.label}`,
    bean: bean.name,
    target: targetId,
    brewer: target.brewer,
    coffee: target.coffee,
    water: target.water,
    ice: target.ice ?? 0,
    temp: temperature,
    clicks,
    steps,
    references,
    assumptions,
  };
}

const roundingTolerance = 1e-9;
const inRange = (value, [min, max], tolerance = 0) =>
  Number.isFinite(value) && value >= min - tolerance && value <= max + tolerance;
const isWaterAddingStep = step => step.type === 'Bloom' || step.type === 'Pour';

export function brewRatioOptions(targetId) {
  const target = targets[targetId];
  const [minimum, maximum] = kit.limits.ratio;
  const presets = target.ratioPresets ?? Array.from(
    { length: (maximum - minimum) * 2 + 1 }, (_, index) => minimum + index / 2,
  );
  const defaultRatio = (target.water + (target.ice ?? 0)) / target.coffee;
  return [...new Set([...presets, defaultRatio])].sort((left, right) => left - right);
}

function roundGrams(weight, minimum = 0, maximum = Infinity) {
  const rounded = Math.round(weight * 10);
  const lowerBound = Math.ceil(minimum * 10 - roundingTolerance);
  const upperBound = Math.floor(maximum * 10 + roundingTolerance);
  return Math.min(upperBound, Math.max(lowerBound, rounded)) / 10;
}

export function applyBrewRatio(recipe, ratio, capacity) {
  const target = Object.hasOwn(targets, recipe.target) && targets[recipe.target];
  const { coffee, water, ice, steps } = recipe;
  const [minimum, maximum] = kit.limits.ratio;
  if (!target || !Number.isFinite(ratio) || ratio <= 0 || (!target.concentrate && !inRange(ratio, kit.limits.ratio))) {
    throw new Error('Choose a supported ratio for this brew method.');
  }
  if (!inRange(coffee, kit.limits.coffee)) {
    throw new Error(`Enter a coffee dose between ${kit.limits.coffee.join(' and ')} g before changing the ratio.`);
  }

  const total = target.concentrate ? roundGrams(coffee * ratio)
    : roundGrams(coffee * ratio, coffee * minimum, coffee * maximum);
  let hotWater = total;
  let newIce = 0;
  if (target.ice) {
    const fraction = water / (water + ice);
    const split = inRange(fraction, kit.limits.hotFraction, roundingTolerance) ? fraction : target.water / (target.water + target.ice);
    const [minimumHot, maximumHot] = kit.limits.hotFraction;
    hotWater = roundGrams(total * split, total * minimumHot, total * maximumHot);
    newIce = roundGrams(total - hotWater);
  }
  if (recipe.target === 'aeropress_inverted' && capacity > 0 && hotWater > capacity) {
    throw new Error('This ratio exceeds your inverted brewer capacity. Choose a lower ratio or reduce the coffee dose.');
  }

  const finalPour = steps.findLastIndex(isWaterAddingStep);
  const previousWater = steps[finalPour]?.weight;
  if (!Number.isFinite(previousWater) || previousWater <= 0) {
    throw new Error('Add a water weight to the final pour or bloom before changing the ratio.');
  }
  let priorWeight = 0;
  const scaledSteps = steps.map((step, index) => {
    if (!isWaterAddingStep(step)) return step;
    const weight = index === finalPour ? hotWater : roundGrams(step.weight / previousWater * hotWater);
    if (!Number.isFinite(step.weight) || weight <= priorWeight || weight > hotWater) {
      throw new Error('Set increasing water weights on all pours before changing the ratio.');
    }
    priorWeight = weight;
    return { ...step, weight };
  });

  return { water: hotWater, ice: newIce, steps: recipeSteps(scaledSteps, newIce) };
}

export function validateRecipe(recipe, capacity) {
  const { coffee, water, ice, temp, clicks, steps } = recipe;
  const target = Object.hasOwn(targets, recipe.target) && targets[recipe.target];
  if (!target) return ['Choose a valid brew method.'];

  const errors = [];
  if (recipe.brewer !== target.brewer) errors.push(`Brewer must be ${target.brewer} for this recipe.`);
  if (!inRange(coffee, kit.limits.coffee)) errors.push('Coffee must be 10–30 g.');
  if (!inRange(temp, temperatureRange)) errors.push(`Temperature must be ${temperatureRange.join('–')}°C.`);
  if (!Number.isInteger(clicks) || !inRange(clicks, target.range)) {
    errors.push(`Grind must be ${target.range.join('–')} whole C3S clicks from zero.`);
  }
  if (!(water > 0) || !Number.isFinite(water)) errors.push('Enter a positive hot-water weight.');
  if (recipe.target === 'aeropress_inverted' && (!Number.isFinite(capacity) || capacity < water)) {
    errors.push('Enter your inverted setup’s usable water capacity and keep the recipe within it.');
  }
  const total = water + ice;
  if (target.ice && (!(ice > 0) || !inRange(water / total, kit.limits.hotFraction, roundingTolerance))) {
    errors.push('Enter the ice weight. Hot water must be 55–70% of the combined water and ice.');
  }
  if (!target.ice && ice !== 0) errors.push('Choose an iced brew method to include ice.');
  if (!target.concentrate && !inRange(total / coffee, kit.limits.ratio, roundingTolerance)) {
    errors.push('Total water and ice must be 14–18 times the coffee weight.');
  }

  let end = 0;
  let weight = 0;
  for (const step of steps) {
    const { startMin, startSec, durMin, durSec } = step;
    const timeFields = [startMin, startSec, durMin, durSec];
    const start = startMin * 60 + startSec;
    const duration = durMin * 60 + durSec;
    if (!timeFields.every(value => Number.isInteger(value) && value >= 0) || start < end || duration <= 0) {
      errors.push('Timeline steps need valid times, positive durations, and must not overlap.');
      break;
    }
    end = start + duration;
    if (!stepTypes.has(step.type)) {
      errors.push(`Unsupported step type: ${step.type}.`);
      break;
    }
    if (isWaterAddingStep(step)) {
      if (!(step.weight > weight) || !Number.isFinite(step.weight) || step.weight > water + kit.limits.weightTolerance) {
        errors.push('Bloom and pour weights must increase up to the hot-water weight.');
        break;
      }
      weight = step.weight;
    } else if (step.weight != null) {
      errors.push('Only bloom and pour steps can add water.');
      break;
    }
  }
  if (weight <= 0 || Math.abs(weight - water) > kit.limits.weightTolerance) {
    errors.push('The final water-adding step must match the hot-water weight.');
  }
  if (target.brewer === 'AeroPress' && steps.at(-1)?.type !== 'Press') {
    errors.push('An AeroPress timeline must end with a Press step.');
  }
  return errors;
}

export function mapRecipe(recipe) {
  return {
    name: recipe.name,
    bean: recipe.bean,
    brewer: recipe.brewer,
    coffee: recipe.coffee,
    water: recipe.water,
    temp: recipe.temp,
    grind: `${recipe.clicks} clicks, C3S`,
    steps: recipeSteps(recipe.steps, recipe.ice),
  };
}

function recipeSteps(steps, ice) {
  return steps.map((step, index) => {
    if (index !== 0 || !ice) return { ...step };
    const notes = (step.notes ?? '').replace(/^Add [\d.]+ g ice to the serving vessel\.\s*/, '');
    return { ...step, notes: `Add ${ice} g ice to the serving vessel. ${notes}`.trim() };
  });
}
