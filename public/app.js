import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js";
import { getFirestore, collection, addDoc, setDoc, doc, serverTimestamp, query, orderBy, onSnapshot, deleteDoc }
from "https://www.gstatic.com/firebasejs/9.22.0/firebase-firestore.js";
import { firebaseConfig } from './firebase-config.js';
import { applyBrewRatio, brewRatioOptions, buildBaseline, defaultTarget, mapRecipe, processes, roasts, targets, validateRecipe }
  from './recipes/recipe-engine.js';
import { createGeminiClient, defaultModel, normalizeSettings, readSettings, writeSettings }
  from './recipes/gemini.js';
import { brewDuration, formatClock, moveTimelineStep, timelineFor } from './recipes/brewing.js';
import { createWorkspace, empty, escapeText } from './workspace.js';

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// STATE
let steps = [];
let allRecipes = [];
let allBeans = [];
let editingStepIndex = null;
let editingRecipeId = null;
let editingBeanId = null;
let beanEditorOrigin = 'beans';
let generatedRecipe = null;
let recipeDirty = false;
const pendingRecipes = [];
const gemini = createGeminiClient();
let geminiTest = null;

const field = id => document.getElementById(id);
const workspace = createWorkspace({
  newRecipe() {
    if (field('btnSaveRecipe').disabled) return;
    if ((recipeDirty || (generatedRecipe && !editingRecipeId)) && !confirm('Discard the current recipe draft?')) return;
    resetRecipeForm();
    workspace.showPage('editor');
    field('recipeName').focus();
  },
  newBean(origin) {
    if (field('btnAddBean').disabled) return;
    resetBeanForm();
    showBeanEditor(origin);
  },
  openRecipe: id => window.loadRecipe(id),
  deleteRecipe: id => window.deleteRecipe(id),
  openBean: id => window.editBean(id),
  deleteBean: id => window.deleteBean(id),
  generateBean,
  improveRecipe,
});
const addOption = (select, value, label = value) => select.add(new Option(label, value));
for (const roast of roasts) addOption(field('trackedRoast'), roast, roast[0].toUpperCase() + roast.slice(1));
for (const process of processes) addOption(field('trackedProcess'), process);
const brewMethodInputs = Object.entries(targets).map(([id, target]) => {
  addOption(field('generatedTarget'), id, target.label);
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.value = id;
  input.checked = id === defaultTarget;
  const label = document.createElement('label');
  label.append(input, target.label);
  field('brewMethodChoices').append(label);
  return input;
});

const settingsDialog = field('geminiSettings');
const settingsStatus = field('geminiSettingsStatus');
const currentSettings = () => normalizeSettings(field('geminiKey').value, field('geminiModel').value);

field('btnGeminiSettings').addEventListener('click', () => {
  const settings = readSettings(localStorage);
  field('geminiKey').value = settings.key;
  field('geminiModel').value = settings.model;
  settingsStatus.textContent = '';
  settingsDialog.showModal();
});
field('btnCloseGemini').addEventListener('click', () => settingsDialog.close());
settingsDialog.addEventListener('close', () => {
  geminiTest?.abort();
  field('geminiKey').value = '';
});
field('btnSaveGemini').addEventListener('click', () => {
  try {
    const settings = currentSettings();
    if (!settings.key) throw new Error('Enter a Gemini API key.');
    writeSettings(localStorage, settings);
    settingsStatus.textContent = 'Settings saved in this browser.';
    workspace.updateConnection();
  } catch (error) {
    settingsStatus.textContent = error.message;
  }
});
field('btnClearGemini').addEventListener('click', () => {
  try {
    writeSettings(localStorage, { key: '' });
    geminiTest?.abort();
    clearGeminiSuggestion(generatedRecipe);
    field('geminiKey').value = '';
    field('geminiModel').value = defaultModel;
    settingsStatus.textContent = 'Gemini key cleared.';
    workspace.updateConnection();
  } catch {
    settingsStatus.textContent = 'Could not clear settings in this browser.';
  }
});
field('btnTestGemini').addEventListener('click', async () => {
  const button = field('btnTestGemini');
  const controller = new AbortController();
  geminiTest = controller;
  button.disabled = true;
  try {
    const settings = currentSettings();
    if (!settings.key) throw new Error('Enter a Gemini API key.');
    settingsStatus.textContent = 'Checking Gemini key and model…';
    await gemini.testKey(settings, { signal: controller.signal });
    if (!controller.signal.aborted) settingsStatus.textContent = 'Gemini key and model worked.';
  } catch (error) {
    if (!controller.signal.aborted) settingsStatus.textContent = error.message;
  } finally {
    geminiTest = null;
    button.disabled = false;
  }
});

// STEP TYPES with colors
const defaultTypes = [
  { name: 'Pour', color: '#fde68F', showWeight: true },
  { name: 'Wait', color: '#bfdbfe', showWeight: false },
  { name: 'Swirl', color: '#d8b4fe', showWeight: false },
  { name: 'Stir', color: '#fda4af', showWeight: false },
  { name: 'Bloom', color: '#fcd34d', showWeight: true },
  { name: 'Press', color: '#a7f3d0', showWeight: false }
];

function readStepTypes() {
  try {
    const saved = JSON.parse(localStorage.getItem('stepTypes'));
    if (Array.isArray(saved) && saved.length && saved.every(type =>
      typeof type?.name === 'string' && typeof type.color === 'string')) return saved;
  } catch {
    // Fall back to the built-in types if browser storage cannot be read.
  }
  return defaultTypes.map(type => ({ ...type }));
}

let stepTypes = readStepTypes();
if (!stepTypes.some(type => type.name === 'Press')) {
  stepTypes.push({ ...defaultTypes.at(-1) });
}

function saveTypes() {
  localStorage.setItem('stepTypes', JSON.stringify(stepTypes));
  renderTypeSelect();
}

function editorStepTypes() {
  if (!generatedRecipe) return stepTypes;
  return defaultTypes.map(type => ({
    ...type,
    color: stepTypes.find(saved => saved.name === type.name)?.color ?? type.color,
  }));
}

function renderTypeSelect() {
  const select = field('stepType');
  const currentValue = select.value;
  const types = editorStepTypes();
  select.replaceChildren();
  for (const type of types) addOption(select, type.name);
  if (types.some(type => type.name === currentValue)) select.value = currentValue;
  updateColorAndWeight();
}

function updateColorAndWeight() {
  const selectedType = editorStepTypes().find(type => type.name === field('stepType').value);
  if (selectedType) {
    document.getElementById('stepColor').value = selectedType.color;
    // Show/hide target weight based on step type
    const weightField = document.getElementById('stepWeight').closest('label');
    if (selectedType.showWeight) {
      weightField.style.display = 'block';
      weightField.parentElement.style.gridTemplateColumns = '1fr 1fr';
    } else {
      weightField.style.display = 'none';
      weightField.parentElement.style.gridTemplateColumns = '1fr';
    }
  }
}

document.getElementById('stepType').addEventListener('change', updateColorAndWeight);

// MANAGE TYPES MODAL
field('btnEditTypes').addEventListener('click', () => {
  renderTypesEditor();
  field('typesDialog').showModal();
});
field('addTypeBtn').addEventListener('click', () => {
  stepTypes.push({ name: 'New Type', color: '#a5f5fc', showWeight: false });
  renderTypesEditor();
  field('typesEditor').querySelectorAll('input[type="text"]')[stepTypes.length - 1]?.focus();
});
field('closeTypesBtn').addEventListener('click', () => field('typesDialog').close());
field('typesDialog').addEventListener('close', () => {
  try {
    saveTypes();
  } catch {
    renderTypeSelect();
    workspace.toast('Step types are available until this page reloads. Browser storage is unavailable.');
  }
});

function renderTypesEditor() {
  const editor = document.getElementById('typesEditor');
  editor.innerHTML = stepTypes.map((type, idx) => `
    <div class="type-row">
      <input type="text" value="${escapeText(type.name)}" aria-label="Step type name" onchange="updateTypeName(${idx}, this.value)" placeholder="Type name">
      <input type="color" value="${escapeText(type.color)}" aria-label="Step type color" onchange="updateTypeColor(${idx}, this.value)">
      <label style="display:flex; align-items:center; gap:4px; margin:0; font-size:11px; white-space:nowrap">
        <input type="checkbox" ${type.showWeight ? 'checked' : ''} onchange="updateTypeWeight(${idx}, this.checked)" style="width:auto; margin:0">
        Weight
      </label>
      <button class="btn delete" onclick="deleteType(${idx})">Delete</button>
    </div>
  `).join('');
}

window.updateTypeName = (idx, name) => {
  stepTypes[idx].name = name;
};

window.updateTypeColor = (idx, color) => {
  stepTypes[idx].color = color;
};

window.updateTypeWeight = (idx, show) => {
  stepTypes[idx].showWeight = show;
};

window.deleteType = (idx) => {
  if (stepTypes.length <= 1) {
    workspace.toast('Keep at least one step type.');
    return;
  }
  if (confirm(`Delete "${stepTypes[idx].name}"?`)) {
    stepTypes.splice(idx, 1);
    renderTypesEditor();
  }
};

// Initialize
renderTypeSelect();

// RATIO CALC
function brewAmounts() {
  return {
    coffee: Number(field('recipeDose').value),
    water: Number(field('recipeWater').value),
    ice: generatedRecipe ? Number(field('generatedIce').value) : 0,
  };
}

function renderRatioOptions(target) {
  const select = field('generatedRatio');
  const current = new Option('Current ratio', '');
  current.disabled = true;
  select.replaceChildren(current);
  for (const ratio of brewRatioOptions(target)) {
    addOption(select, String(ratio), `1:${Number(ratio.toFixed(1))}`);
  }
}

function calcRatio() {
  const { coffee, water, ice } = brewAmounts();
  const total = water + ice;
  const ratio = coffee > 0 && total > 0 ? (total / coffee).toFixed(1) : '';
  field('recipeRatio').value = ratio || '-';
  field('manualRatioLabel').hidden = Boolean(generatedRecipe);
  field('generatedRatioLabel').hidden = !generatedRecipe;
  if (!generatedRecipe) return;

  const select = field('generatedRatio');
  const current = select.options[0];
  const matched = Array.from(select.options).find(option => option.value && Number(option.value).toFixed(1) === ratio);
  current.textContent = ratio ? `1:${Number(ratio)} (current)` : 'Choose a ratio';
  current.hidden = Boolean(matched);
  select.value = matched?.value ?? '';
}

function recipeClicks(grind) {
  return Number(/^\s*(\d+)\s*clicks?(?:,\s*C3S)?\s*$/i.exec(grind)?.[1]);
}

field('generatedRatio').addEventListener('change', event => {
  const draft = generatedRecipe;
  if (!draft || field('btnSaveRecipe').disabled) {
    calcRatio();
    return;
  }

  const amounts = brewAmounts();
  const capacity = Number(field('generatedCapacity').value);
  let adjusted;
  try {
    if (editingStepIndex !== null) throw new Error('Finish or cancel the step edit before changing the ratio.');
    adjusted = applyBrewRatio({ ...amounts, target: draft.target, steps }, Number(event.target.value), capacity);
  } catch (error) {
    calcRatio();
    field('generatedErrors').textContent = error.message;
    field('generatedErrors').focus();
    return;
  }

  field('recipeWater').value = adjusted.water;
  field('generatedIce').value = adjusted.ice;
  steps = adjusted.steps;
  draft.changed = true;
  recipeDirty = true;
  field('generatedErrors').textContent = '';
  calcRatio();
  renderSteps();

  if (draft.baseline) {
    const nextBaseline = {
      ...draft.baseline,
      ...adjusted,
      coffee: amounts.coffee,
      temp: Number(field('recipeTemp').value),
      clicks: recipeClicks(field('recipeGrind').value),
    };
    if (validateRecipe(nextBaseline, capacity || nextBaseline.water).length === 0) {
      refineGeneratedRecipe(draft, nextBaseline);
    } else {
      clearGeminiSuggestion(draft);
    }
  }
});
document.getElementById('recipeDose').addEventListener('input', calcRatio);
document.getElementById('recipeWater').addEventListener('input', calcRatio);
field('generatedIce').addEventListener('input', calcRatio);
document.querySelector('[data-page="editor"]').addEventListener('input', event => {
  if (event.target.closest('#stepEditor') || ['generatedTarget', 'generatedRatio'].includes(event.target.id)) return;
  recipeDirty = true;
  if (generatedRecipe) generatedRecipe.changed = true;
});
calcRatio();

function openGeneratedRecipe({ bean, target, recipe = buildBaseline(bean, target), position = 1, total = 1 }) {
  const errors = validateRecipe(recipe, recipe.water);
  if (errors.length) throw new Error(errors.join(' '));
  const mapped = mapRecipe(recipe);

  resetRecipeForm();
  generatedRecipe = { bean, target, baseline: recipe };
  renderRatioOptions(target);
  renderTypeSelect();
  field('generatedRecipePanel').hidden = false;
  field('recipeMethodLabel').hidden = true;
  field('recipeMethod').value = target;
  field('editorTitle').textContent = 'Generated recipe';
  field('editorSubtitle').textContent = 'Review the brewing parameters and live timeline before saving.';
  field('generatedBatch').hidden = total === 1;
  field('generatedBatch').textContent = `Recipe ${position} of ${total}`;
  field('generatedTarget').value = target;
  field('generatedTarget').disabled = total > 1;
  field('generatedIceLabel').hidden = recipe.ice === 0;
  field('generatedIce').value = recipe.ice;
  field('generatedCapacityLabel').hidden = target !== 'aeropress_inverted';
  field('generatedBeanProfile').textContent = [
    `Roast ${bean.roast}`,
    `Process ${bean.process || 'unknown'}`,
    bean.roastDate && `Roasted ${bean.roastDate}`,
    bean.tastingNotes && `Bag notes ${bean.tastingNotes}`,
  ].filter(Boolean).join(' · ');
  field('generatedReferences').textContent = [...recipe.references, ...recipe.assumptions].join(' ');
  field('btnCancelEdit').style.display = 'inline-block';

  field('recipeName').value = mapped.name;
  field('beanName').value = mapped.bean;
  field('recipeBrewer').value = mapped.brewer;
  field('recipeDose').value = mapped.coffee;
  field('recipeWater').value = mapped.water;
  field('recipeTemp').value = mapped.temp;
  field('recipeGrind').value = mapped.grind;
  steps = mapped.steps.map(step => ({
    ...step,
    color: editorStepTypes().find(type => type.name === step.type)?.color ?? '#fde68f',
  }));
  calcRatio();
  renderSteps();
  workspace.showPage('editor');
  refineGeneratedRecipe(generatedRecipe, recipe);
}

function clearGeminiSuggestion(draft) {
  draft?.aiRequest?.abort();
  if (draft) draft.suggestion = null;
  field('generatedAiStatus').hidden = true;
  field('generatedAiWhy').hidden = true;
  field('btnApplyGemini').hidden = true;
}

async function refineGeneratedRecipe(draft, baseline) {
  clearGeminiSuggestion(draft);
  const settings = readSettings(localStorage);
  const status = field('generatedAiStatus');
  status.hidden = false;
  if (!settings.key) {
    status.textContent = 'Chart-based recipe. Gemini is off.';
    return;
  }
  const controller = new AbortController();
  draft.aiRequest = controller;
  status.textContent = 'Checking for a Gemini adjustment. The chart-based recipe is ready.';
  try {
    const result = await gemini.refine(settings, draft.bean, baseline, {
      signal: controller.signal,
      onRetry: seconds => {
        if (generatedRecipe !== draft || controller.signal.aborted) return;
        status.textContent = `Gemini will retry in ${seconds} seconds. The chart-based recipe is ready.`;
      },
    });
    if (generatedRecipe !== draft || controller.signal.aborted) return;
    if (!result) {
      status.textContent = 'Using the chart-based recipe. Gemini did not return an adjustment within the recipe limits.';
      return;
    }
    const { recipe, adjustment, why } = result;
    status.textContent = adjustment === 'none' ? 'Using the chart-based recipe.' : 'Optional Gemini suggestion';
    const explanation = field('generatedAiWhy');
    explanation.hidden = false;
    explanation.textContent = adjustment === 'temperature' ? `${recipe.temp}°C. ${why}`
      : adjustment === 'grind' ? `${recipe.clicks} clicks from zero. ${why}` : why;
    if (adjustment !== 'none') {
      draft.suggestion = { baseline, ...result };
      field('btnApplyGemini').hidden = false;
    }
  } catch (error) {
    if (generatedRecipe === draft && !controller.signal.aborted) {
      status.textContent = `${error.message} The chart-based recipe is ready.`;
    }
  }
}

field('btnApplyGemini').addEventListener('click', () => {
  const suggestion = generatedRecipe?.suggestion;
  if (!suggestion || field('btnSaveRecipe').disabled) return;
  const { baseline, recipe, adjustment } = suggestion;
  const fieldId = adjustment === 'temperature' ? 'recipeTemp' : 'recipeGrind';
  const input = field(fieldId);
  if (input.value !== String(mapRecipe(baseline)[adjustment === 'temperature' ? 'temp' : 'grind'])) {
    field('generatedAiStatus').textContent = 'Your edited value was kept. You can still enter the suggested value manually.';
    return;
  }
  input.value = adjustment === 'temperature' ? recipe.temp : mapRecipe(recipe).grind;
  generatedRecipe.changed = true;
  recipeDirty = true;
  field('btnApplyGemini').hidden = true;
  field('generatedAiStatus').textContent = 'Gemini suggestion applied.';
});

function recipeEditorHasDraft() {
  return field('btnSaveRecipe').disabled || recipeDirty || editingRecipeId || generatedRecipe || steps.length ||
    field('recipeName').value || field('beanName').value || field('recipeBrewer').value ||
    field('recipeGrind').value || field('recipeMethod').value || field('recipeDescription').value ||
    field('recipeNotes').value || field('recipeDose').value !== '18' ||
    field('recipeWater').value !== '300' || field('recipeTemp').value !== '94';
}

function selectedBrewMethods() {
  const selected = brewMethodInputs.filter(input => input.checked).map(input => input.value);
  return selected.length ? selected : [defaultTarget];
}

function queueRecipes(bean, methods, water) {
  pendingRecipes.push(...methods.map((target, index) => ({
    bean, target, recipe: buildBaseline(bean, target, water), position: index + 1, total: methods.length,
  })));
  showNextBeanRecipe();
}

function showNextBeanRecipe() {
  if (!pendingRecipes.length) return;
  if (recipeEditorHasDraft()) {
    field('beanGeneratorStatus').textContent = 'Queued recipes will open after you save or cancel the current draft.';
    field('btnCancelEdit').style.display = 'inline-block';
    workspace.showPage('editor');
    workspace.toast('Finish the current draft to review your queued recipes.');
    return;
  }
  openGeneratedRecipe(pendingRecipes[0]);
  pendingRecipes.shift();
  field('beanGeneratorStatus').textContent = pendingRecipes.length
    ? 'Another bean recipe will open after you save or cancel the current draft.' : '';
}

field('generatedTarget').addEventListener('change', event => {
  if (field('btnSaveRecipe').disabled ||
      (generatedRecipe.changed && !confirm('Switch brew method and discard the current recipe edits?'))) {
    event.target.value = generatedRecipe.target;
    return;
  }
  openGeneratedRecipe({ bean: generatedRecipe.bean, target: event.target.value });
});

field('btnBrewSavedBean').addEventListener('click', () => {
  const bean = allBeans.find(item => item.id === editingBeanId);
  if (!bean?.roast) {
    field('beanGeneratorStatus').textContent = 'Choose a roast level and save the bean before generating.';
    field('trackedRoast').focus();
    return;
  }
  field('beanEditor').close();
  queueRecipes(bean, selectedBrewMethods());
});

function showBeanEditor(origin = 'beans') {
  beanEditorOrigin = origin;
  workspace.showPage(origin);
  field('trackedBrewMethods').hidden = origin === 'assistant';
  field('btnBrewSavedBean').hidden = origin === 'assistant' || !editingBeanId;
  field('beanEditorTitle').textContent = editingBeanId ? 'Edit coffee bean' : 'Add coffee bean';
  if (!field('beanEditor').open) field('beanEditor').showModal();
  field('trackedBeanName').focus();
}

function generateBean(bean, target, water) {
  if (!bean) return;
  const fromAssistant = water !== undefined;
  if (!roasts.includes(bean.roast)) {
    window.editBean(bean.id, fromAssistant ? 'assistant' : 'beans');
    field('beanGeneratorStatus').textContent = 'Choose a roast level and save the bean before generating.';
    field('trackedRoast').focus();
    return;
  }
  try {
    queueRecipes(bean, [target], water);
  } catch (error) {
    if (fromAssistant) field('assistantStatus').textContent = error.message;
    else workspace.toast(error.message);
  }
}

function improveRecipe(recipe) {
  const status = field('assistantStatus');
  if (!readSettings(localStorage).key) {
    status.textContent = 'Connect Gemini in AI settings to review a saved recipe.';
    return;
  }
  const bean = allBeans.find(item => item.name?.trim().toLowerCase() === recipe.bean?.trim().toLowerCase() &&
    roasts.includes(item.roast));
  if (!bean) {
    status.textContent = 'Save this recipe’s bean with a roast level in My Beans to get recommendations.';
    return;
  }
  const target = recipe.generatedTarget || recipe.method ||
    (/v60/i.test(recipe.brewer) ? 'v60_hot' : /aeropress/i.test(recipe.brewer) ? 'aeropress_black' : '');
  if (!Object.hasOwn(targets, target)) {
    status.textContent = 'Choose a supported V60 or AeroPress brew method in the recipe editor.';
    return;
  }
  const baseline = {
    ...buildBaseline(bean, target), ...recipe, target,
    ice: recipe.ice || 0,
    clicks: recipeClicks(recipe.grind),
  };
  const errors = validateRecipe(baseline, recipe.brewerCapacity);
  if (errors.length) {
    status.textContent = errors[0];
    return;
  }
  if (!window.loadRecipe(recipe.id)) return;
  generatedRecipe = { bean, target, baseline };
  renderRatioOptions(target);
  field('generatedRecipePanel').hidden = false;
  field('recipeMethodLabel').hidden = true;
  field('generatedTarget').value = target;
  field('generatedTarget').disabled = true;
  field('generatedIceLabel').hidden = !targets[target].ice;
  field('generatedIce').value = baseline.ice;
  field('generatedCapacityLabel').hidden = target !== 'aeropress_inverted';
  field('generatedCapacity').value = recipe.brewerCapacity || '';
  field('generatedReferences').textContent = [...baseline.references, ...baseline.assumptions].join(' ');
  renderTypeSelect();
  calcRatio();
  refineGeneratedRecipe(generatedRecipe, baseline);
}

field('closeBeanEditor').addEventListener('click', () => {
  if (!field('btnAddBean').disabled) field('beanEditor').close();
});

// RENDER STEPS
function renderSteps() {
  const container = document.getElementById('stepsList');
  const timeline = timelineFor(steps);
  const duration = brewDuration(timeline);
  field('editorDuration').textContent = duration ? formatClock(duration) : '';
  const bar = field('editorTimelineBar');
  bar.replaceChildren();
  for (const step of timeline) {
    const segment = document.createElement('span');
    segment.style.width = `${(step.end - step.start) / duration * 100}%`;
    segment.style.backgroundColor = step.color || '#79543b';
    bar.append(segment);
  }
  field('brewDraft').disabled = !duration;
  if (steps.length === 0) {
    container.innerHTML = empty('timer', 'No steps yet', 'Add a step to begin building your brew timeline.');
    return;
  }

  container.innerHTML = steps.map((step, idx) => {
    const totalSecs = (step.startMin || 0) * 60 + (step.startSec || 0);
    const durSecs = (step.durMin || 0) * 60 + (step.durSec || 0);
    const formatTime = (s) => {
      const m = Math.floor(s / 60);
      const sec = s % 60;
      return m > 0 ? `${m}:${sec.toString().padStart(2, '0')}` : `${sec}s`;
    };

    return `
      <div class="step" tabindex="0">
        <div class="color-bar"></div>
        <div class="content">
          <div class="title">${escapeText(step.label || step.type)}${step.label && step.label !== step.type ? ` <small>${escapeText(step.type)}</small>` : ''}</div>
          <div class="meta">${formatTime(totalSecs)} → ${formatTime(totalSecs + durSecs)}${step.weight ? ' • ' + escapeText(step.weight) + 'g' : ''}</div>
          ${step.notes ? `<div class="notes">${escapeText(step.notes)}</div>` : ''}
          <div class="row-controls">
            <button class="btn outline" onclick="editStep(${idx})">Edit</button>
            <button class="btn outline" data-move-step="${idx}" data-offset="-1" ${idx === 0 ? 'disabled' : ''} aria-label="Move step up">↑</button>
            <button class="btn outline" data-move-step="${idx}" data-offset="1" ${idx === steps.length - 1 ? 'disabled' : ''} aria-label="Move step down">↓</button>
            <button class="btn warn" onclick="deleteStep(${idx})">Delete</button>
          </div>
        </div>
      </div>
    `;
  }).join('');
  container.querySelectorAll('.color-bar').forEach((bar, index) => {
    bar.style.backgroundColor = steps[index].color || '#79543b';
    if (!bar.style.backgroundColor) bar.style.backgroundColor = '#79543b';
  });
}

// ADD/UPDATE STEP
document.getElementById('btnAddStep').addEventListener('click', () => {
  const type = field('stepType').value;
  const showsWeight = editorStepTypes().find(item => item.name === type)?.showWeight;
  const stepData = {
    type,
    label: document.getElementById('stepLabel').value,
    color: document.getElementById('stepColor').value,
    startMin: parseInt(document.getElementById('startMin').value) || 0,
    startSec: parseInt(document.getElementById('startSec').value) || 0,
    durMin: parseInt(document.getElementById('durMin').value) || 0,
    durSec: parseInt(document.getElementById('durSec').value) || 0,
    weight: showsWeight ? Number(field('stepWeight').value) || null : null,
    notes: document.getElementById('stepNotes').value
  };

  if (editingStepIndex !== null) {
    steps[editingStepIndex] = stepData;
  } else {
    steps.push(stepData);
  }

  recipeDirty = true;
  if (generatedRecipe) generatedRecipe.changed = true;
  resetStepForm();
  renderSteps();
});

field('btnCancelStep').addEventListener('click', resetStepForm);

function resetStepForm() {
  editingStepIndex = null;
  document.getElementById('btnAddStep').textContent = 'Add Step';
  document.getElementById('stepCardTitle').textContent = 'Add Step';
  document.getElementById('btnCancelStep').style.display = 'none';
  document.getElementById('stepLabel').value = '';
  document.getElementById('startMin').value = '0';
  document.getElementById('startSec').value = '0';
  document.getElementById('durMin').value = '0';
  document.getElementById('durSec').value = '0';
  document.getElementById('stepWeight').value = '';
  document.getElementById('stepNotes').value = '';
  updateColorAndWeight();
}

window.editStep = (idx) => {
  editingStepIndex = idx;
  const step = steps[idx];
  document.getElementById('stepType').value = step.type;
  document.getElementById('stepLabel').value = step.label || '';
  document.getElementById('startMin').value = step.startMin || 0;
  document.getElementById('startSec').value = step.startSec || 0;
  document.getElementById('durMin').value = step.durMin || 0;
  document.getElementById('durSec').value = step.durSec || 0;
  document.getElementById('stepWeight').value = step.weight || '';
  document.getElementById('stepNotes').value = step.notes || '';

  // Update weight visibility based on type
  updateColorAndWeight();
  document.getElementById('stepColor').value = step.color;

  document.getElementById('btnAddStep').textContent = 'Update Step';
  document.getElementById('stepCardTitle').textContent = 'Edit Step';
  document.getElementById('btnCancelStep').style.display = 'inline-block';
  field('stepEditor').scrollIntoView({ behavior: 'smooth' });
  field('stepLabel').focus({ preventScroll: true });
};

window.deleteStep = (idx) => {
  if (editingStepIndex === idx) resetStepForm();
  else if (editingStepIndex !== null && idx < editingStepIndex) editingStepIndex -= 1;
  steps.splice(idx, 1);
  recipeDirty = true;
  if (generatedRecipe) generatedRecipe.changed = true;
  renderSteps();
};

field('stepsList').addEventListener('click', event => {
  const button = event.target.closest('[data-move-step]');
  if (!button) return;
  const index = Number(button.dataset.moveStep);
  const offset = Number(button.dataset.offset);
  if (editingStepIndex !== null) {
    workspace.toast('Finish or cancel the step edit before reordering.');
    return;
  }
  const reordered = moveTimelineStep(steps, index, offset);
  if (reordered === steps) return;
  if (generatedRecipe) {
    // Water-adding weights are cumulative. Retain them in chronological order.
    const weights = steps.filter(step => step.type === 'Pour' || step.type === 'Bloom').map(step => step.weight);
    let nextWeight = 0;
    steps = reordered.map(step => step.type === 'Pour' || step.type === 'Bloom'
      ? { ...step, weight: weights[nextWeight++] } : step);
    generatedRecipe.changed = true;
  } else {
    steps = reordered;
  }
  recipeDirty = true;
  renderSteps();
  field('stepsList').querySelectorAll('.step')[index + offset]?.focus();
});

function readRecipeDraft() {
  const { coffee, water, ice } = brewAmounts();
  return {
    name: field('recipeName').value.trim() || 'Untitled',
    bean: field('beanName').value.trim(),
    brewer: field('recipeBrewer').value.trim(),
    method: field('recipeMethod').value,
    description: field('recipeDescription').value.trim(),
    notes: field('recipeNotes').value.trim(),
    coffee, water, temp: Number(field('recipeTemp').value),
    grind: field('recipeGrind').value.trim(),
    rating: Number(document.querySelector('input[name="rating"]:checked')?.value ?? 0),
    steps,
    ...(generatedRecipe ? { generatedTarget: generatedRecipe.target, ice } : {}),
  };
}

field('brewDraft').addEventListener('click', () => {
  const draft = readRecipeDraft();
  if (!timelineFor(draft.steps).length) {
    workspace.toast('Add a brewing step before starting the timer.');
    return;
  }
  workspace.startTimer({ ...draft, id: editingRecipeId });
});

// SAVE RECIPE
field('btnSaveRecipe').addEventListener('click', async () => {
  const btn = field('btnSaveRecipe');
  const originalText = btn.textContent;
  btn.textContent = 'Saving…';
  const recipeData = { ...readRecipeDraft(), timestamp: serverTimestamp() };

  if (generatedRecipe) {
    const validationInput = {
      ...recipeData,
      target: generatedRecipe.target,
      clicks: recipeClicks(recipeData.grind),
      ice: Number(field('generatedIce').value),
    };
    const capacity = Number(field('generatedCapacity').value);
    const errors = validateRecipe(validationInput, capacity);
    if (errors.length) {
      field('generatedErrors').textContent = errors.join(' ');
      field('generatedErrors').focus();
      btn.textContent = originalText;
      return;
    }
    field('generatedErrors').textContent = '';
    Object.assign(recipeData, mapRecipe(validationInput), {
      generatedTarget: generatedRecipe.target,
      ice: validationInput.ice,
      ...(generatedRecipe.target === 'aeropress_inverted' ? { brewerCapacity: capacity } : {}),
    });
  }

  btn.disabled = true;
  try {
    if (editingRecipeId) {
      await setDoc(doc(db, "recipes", editingRecipeId), recipeData);
      workspace.toast('Recipe updated.');
    } else {
      await addDoc(collection(db, "recipes"), recipeData);
      workspace.toast('Recipe saved.');
    }
    resetRecipeForm();
  } catch(e) {
    workspace.toast('Recipe could not be saved. ' + e.message);
    btn.textContent = originalText;
    return;
  } finally {
    btn.disabled = false;
  }
  showNextBeanRecipe();
  if (!generatedRecipe) workspace.showPage('recipes');
});

document.getElementById('btnCancelEdit').addEventListener('click', () => {
  if (field('btnSaveRecipe').disabled) return;
  resetRecipeForm();
  showNextBeanRecipe();
  if (!generatedRecipe) workspace.showPage('recipes');
});

function resetRecipeForm() {
  clearGeminiSuggestion(generatedRecipe);
  generatedRecipe = null;
  recipeDirty = false;
  field('generatedRecipePanel').hidden = true;
  field('recipeMethodLabel').hidden = false;
  field('recipeMethod').value = '';
  field('recipeDescription').value = '';
  field('recipeNotes').value = '';
  field('editorTitle').textContent = 'Recipe editor';
  field('editorSubtitle').textContent = 'Set your brewing parameters and build the timeline.';
  field('generatedBatch').hidden = true;
  field('generatedBeanProfile').textContent = '';
  field('generatedTarget').disabled = false;
  field('generatedErrors').textContent = '';
  field('generatedIce').value = '';
  field('generatedCapacity').value = '';
  editingRecipeId = null;
  renderTypeSelect();
  resetStepForm();

  document.getElementById('recipeName').value = "";
  document.getElementById('beanName').value = "";
  document.getElementById('recipeBrewer').value = "";
  document.getElementById('recipeDose').value = "18";
  document.getElementById('recipeWater').value = "300";
  document.getElementById('recipeTemp').value = "94";
  document.getElementById('recipeGrind').value = "";

  const ratingEl = document.querySelector('input[name="rating"]:checked');
  if(ratingEl) ratingEl.checked = false;

  steps = [];
  renderSteps();
  calcRatio();

  document.getElementById('btnSaveRecipe').textContent = "Save Recipe";
  field('btnCancelEdit').style.display = '';
  window.scrollTo(0, 0);
}

// BEANS TRACKER
document.getElementById('btnAddBean').addEventListener('click', async () => {
  const btn = document.getElementById('btnAddBean');
  const originalText = btn.textContent;

  const beanName = document.getElementById('trackedBeanName').value.trim();
  if (!beanName) {
    field('beanGeneratorStatus').textContent = 'Enter the bean name.';
    field('trackedBeanName').focus();
    return;
  }

  const beanId = editingBeanId;
  const fromAssistant = beanEditorOrigin === 'assistant';
  const roast = field('trackedRoast').value;
  if ((!beanId || fromAssistant) && !roast) {
    field('beanGeneratorStatus').textContent = 'Choose a roast level so Bean Stack can generate a recipe.';
    field('trackedRoast').focus();
    return;
  }

  const methods = fromAssistant && !beanId ? [field('assistantMethod').value] : selectedBrewMethods();
  btn.disabled = true;
  field('btnCancelBean').disabled = true;
  btn.textContent = beanId ? "Updating..." : "Saving...";

  const ratingEl = document.querySelector('input[name="bean-rating"]:checked');
  const ratingVal = ratingEl ? Number(ratingEl.value) : 0;

  const beanData = {
    name: beanName,
    origin: document.getElementById('trackedOrigin').value.trim() || "",
    roaster: document.getElementById('trackedRoaster').value.trim() || "",
    notes: document.getElementById('trackedNotes').value.trim() || "",
    roast,
    process: field('trackedProcess').value,
    roastDate: field('trackedRoastDate').value,
    tastingNotes: field('trackedTastingNotes').value.trim(),
    brewMethods: methods,
    rating: ratingVal,
    timestamp: serverTimestamp()
  };

  let savedBeanId = beanId;
  try {
    if (beanId) {
      await setDoc(doc(db, "beans", beanId), beanData);
    } else {
      const savedBean = await addDoc(collection(db, "beans"), beanData);
      savedBeanId = savedBean.id;
    }
    field('beanEditor').close();
    resetBeanForm();
    workspace.toast(beanId ? 'Coffee bean updated.' : 'Coffee bean added.');
  } catch(e) {
    field('beanGeneratorStatus').textContent = 'Bean could not be saved. ' + e.message;
    btn.textContent = originalText;
    return;
  } finally {
    btn.disabled = false;
    field('btnCancelBean').disabled = false;
  }
  if (fromAssistant) {
    workspace.selectAssistantBean(savedBeanId);
    field('assistantStatus').textContent = '';
    field('assistantWater').focus();
  } else if (!beanId) {
    queueRecipes(beanData, methods);
  }
});

field('btnCancelBean').addEventListener('click', () => field('beanEditor').close());
field('beanEditor').addEventListener('cancel', event => {
  if (field('btnAddBean').disabled) event.preventDefault();
});

function resetBeanForm() {
  editingBeanId = null;
  field('btnBrewSavedBean').hidden = true;
  field('beanGeneratorStatus').textContent = '';
  for (const id of ['trackedRoast', 'trackedProcess', 'trackedRoastDate', 'trackedTastingNotes']) {
    field(id).value = '';
  }
  for (const input of brewMethodInputs) input.checked = input.value === defaultTarget;
  document.getElementById('trackedBeanName').value = "";
  document.getElementById('trackedOrigin').value = "";
  document.getElementById('trackedRoaster').value = "";
  document.getElementById('trackedNotes').value = "";

  const ratingEl = document.querySelector('input[name="bean-rating"]:checked');
  if(ratingEl) ratingEl.checked = false;

  document.getElementById('btnAddBean').textContent = "Add Bean";
  document.getElementById('btnCancelBean').style.display = 'none';
}

window.editBean = function(id, origin = 'beans') {
  if (field('btnAddBean').disabled) return;
  const bean = allBeans.find(b => b.id === id);
  if (!bean) return;

  document.getElementById('trackedBeanName').value = bean.name || "";
  document.getElementById('trackedOrigin').value = bean.origin || "";
  document.getElementById('trackedRoaster').value = bean.roaster || "";
  document.getElementById('trackedNotes').value = bean.notes || "";
  field('beanGeneratorStatus').textContent = '';
  field('trackedRoast').value = bean.roast || '';
  field('trackedProcess').value = bean.process || '';
  field('trackedRoastDate').value = bean.roastDate || '';
  field('trackedTastingNotes').value = bean.tastingNotes || '';
  const selected = Array.isArray(bean.brewMethods) && bean.brewMethods.length ? bean.brewMethods : [defaultTarget];
  for (const input of brewMethodInputs) input.checked = selected.includes(input.value);

  const stars = document.querySelectorAll('input[name="bean-rating"]');
  stars.forEach(s => s.checked = false);
  if(bean.rating) {
    const radio = document.querySelector(`input[name="bean-rating"][value="${bean.rating}"]`);
    if(radio) radio.checked = true;
  }

  editingBeanId = id;
  document.getElementById('btnAddBean').textContent = "Update Bean";
  document.getElementById('btnCancelBean').style.display = 'inline-block';
  showBeanEditor(origin);
};

window.deleteBean = async (id) => {
  if(confirm("Delete this bean from your collection?")) {
    try {
      await deleteDoc(doc(db, 'beans', id));
      if (editingBeanId === id) resetBeanForm();
      workspace.toast('Coffee bean deleted.');
    } catch (error) {
      workspace.toast('Bean could not be deleted. ' + error.message);
    }
  }
};

// LOAD RECIPES
const recipesQuery = query(collection(db, 'recipes'), orderBy('timestamp', 'desc'));
onSnapshot(recipesQuery, snapshot => {
  allRecipes = [];
  snapshot.forEach(item => allRecipes.push({ ...item.data(), id: item.id }));
  workspace.setRecipes(allRecipes);
}, () => workspace.setRecipes(allRecipes, true));

window.loadRecipe = function(id) {
  const r = allRecipes.find(x => x.id === id);
  if (!r || field('btnSaveRecipe').disabled) return false;
  if (recipeDirty && !confirm('Discard the current recipe edits?')) return false;

  resetRecipeForm();
  field('editorTitle').textContent = 'Edit recipe';
  field('editorSubtitle').textContent = 'Fine-tune the recipe and save when it’s ready to brew.';
  field('recipeMethod').value = r.generatedTarget || r.method || '';
  field('recipeDescription').value = r.description || '';
  field('recipeNotes').value = r.notes || '';
  if (Object.hasOwn(targets, r.generatedTarget)) {
    generatedRecipe = { target: r.generatedTarget };
    field('recipeMethodLabel').hidden = true;
    renderRatioOptions(r.generatedTarget);
    renderTypeSelect();
    field('generatedRecipePanel').hidden = false;
    field('generatedTarget').value = r.generatedTarget;
    field('generatedTarget').disabled = true;
    field('generatedIceLabel').hidden = !targets[r.generatedTarget].ice;
    field('generatedIce').value = r.ice || 0;
    field('generatedCapacityLabel').hidden = r.generatedTarget !== 'aeropress_inverted';
    field('generatedCapacity').value = r.brewerCapacity || '';
    field('generatedReferences').textContent = 'Saved generated recipe';
  }

  document.getElementById('beanName').value = r.bean || "";
  document.getElementById('recipeName').value = r.name || "";
  document.getElementById('recipeBrewer').value = r.brewer || "";
  document.getElementById('recipeDose').value = r.coffee || 18;
  document.getElementById('recipeWater').value = r.water || 300;
  document.getElementById('recipeTemp').value = r.temp || 94;
  document.getElementById('recipeGrind').value = r.grind || "";
  calcRatio();

  const stars = document.querySelectorAll('input[name="rating"]');
  stars.forEach(s => s.checked = false);
  if (r.rating) {
    const radio = document.querySelector(`input[name="rating"][value="${r.rating}"]`);
    if (radio) radio.checked = true;
  }

  steps = Array.isArray(r.steps) ? r.steps.map(step => ({ ...step })) : [];
  renderSteps();

  editingRecipeId = id;
  document.getElementById('btnSaveRecipe').textContent = "Update Recipe";
  document.getElementById('btnCancelEdit').style.display = 'inline-block';
  workspace.showPage('editor');
  window.scrollTo(0, 0);
  return true;
};

window.deleteRecipe = async id => {
  if (!confirm('Delete this recipe permanently?')) return;
  try {
    await deleteDoc(doc(db, 'recipes', id));
    if (editingRecipeId === id) resetRecipeForm();
    workspace.toast('Recipe deleted.');
  } catch (error) {
    workspace.toast('Recipe could not be deleted. ' + error.message);
  }
};

const beansQuery = query(collection(db, 'beans'), orderBy('timestamp', 'desc'));
onSnapshot(beansQuery, snapshot => {
  allBeans = [];
  snapshot.forEach(item => allBeans.push({ ...item.data(), id: item.id }));
  workspace.setBeans(allBeans);
}, () => workspace.setBeans(allBeans, true));

// IMPORT RECIPES
const importModal = field('importModal');
const importSource = field('importTextarea');
const importButton = field('btnDoImport');
const importPreview = field('importPreview');
const importError = field('importError');
let importPending = null;

function resetImportReview() {
  importPending = null;
  importButton.textContent = 'Review import';
  importPreview.hidden = true;
  importError.hidden = true;
}

field('btnImportRecipes').addEventListener('click', () => {
  resetImportReview();
  importModal.showModal();
});
field('btnCloseImport').addEventListener('click', () => {
  if (!importButton.disabled) importModal.close();
});
importModal.addEventListener('cancel', event => {
  if (importButton.disabled) event.preventDefault();
});
field('btnShowFormatGuide').addEventListener('click', event => {
  const guide = field('formatGuide');
  guide.hidden = !guide.hidden;
  event.currentTarget.setAttribute('aria-expanded', String(!guide.hidden));
});
field('btnImportFromFile').addEventListener('click', () => field('importFileInput').click());
field('importFileInput').addEventListener('change', async event => {
  await readImportFile(event.target.files[0]);
  event.target.value = '';
});
importSource.addEventListener('input', resetImportReview);
const importDropZone = field('importDropZone');
importDropZone.addEventListener('dragover', event => {
  event.preventDefault();
  importDropZone.classList.add('dragging');
});
importDropZone.addEventListener('dragleave', () => importDropZone.classList.remove('dragging'));
importDropZone.addEventListener('drop', async event => {
  event.preventDefault();
  importDropZone.classList.remove('dragging');
  await readImportFile(event.dataTransfer.files[0]);
});

async function readImportFile(file) {
  if (!file || importButton.disabled) return;
  resetImportReview();
  try {
    importSource.value = await file.text();
  } catch {
    importError.textContent = 'The file could not be read. Try choosing it again or paste the JSON.';
    importError.hidden = false;
  }
}

function normalizeImportedRecipe(recipe) {
  if (!recipe || typeof recipe !== 'object' || typeof recipe.name !== 'string' || !recipe.name.trim()) {
    throw new Error('Each recipe needs a name.');
  }
  const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const text = value => typeof value === 'string' ? value : '';
  const typeColor = type => stepTypes.find(entry => entry.name === type)?.color || '#fde68F';
  return {
    name: recipe.name.trim(),
    bean: text(recipe.bean),
    brewer: text(recipe.brewer),
    coffee: number(recipe.coffee),
    water: number(recipe.water),
    temp: number(recipe.temp),
    grind: text(recipe.grind),
    rating: Math.max(0, Math.min(5, number(recipe.rating))),
    description: text(recipe.description),
    notes: text(recipe.notes),
    method: Object.hasOwn(targets, recipe.method) ? recipe.method : '',
    ...(Object.hasOwn(targets, recipe.generatedTarget) ? {
      generatedTarget: recipe.generatedTarget,
      ice: number(recipe.ice),
      ...(recipe.generatedTarget === 'aeropress_inverted' ? { brewerCapacity: number(recipe.brewerCapacity) } : {}),
    } : {}),
    steps: Array.isArray(recipe.steps) ? recipe.steps.filter(step => step && typeof step === 'object').map(step => ({
      type: text(step.type) || 'Pour',
      label: text(step.label),
      color: text(step.color) || typeColor(step.type || 'Pour'),
      startMin: number(step.startMin),
      startSec: number(step.startSec),
      durMin: number(step.durMin),
      durSec: number(step.durSec),
      weight: step.weight == null || step.weight === '' ? null : number(step.weight),
      notes: text(step.notes),
    })) : [],
  };
}

importButton.addEventListener('click', async () => {
  importError.hidden = true;
  if (!importPending) {
    try {
      const raw = importSource.value.trim();
      if (!raw) throw new Error('Paste JSON or choose a file first.');
      const parsed = JSON.parse(raw);
      const records = Array.isArray(parsed) ? parsed : [parsed];
      if (!records.length) throw new Error('This file has no recipes.');
      importPending = records.map(normalizeImportedRecipe);
      importPreview.textContent = `Ready to add ${records.length} ${records.length === 1 ? 'recipe' : 'recipes'} to your library.`;
      importPreview.hidden = false;
      importButton.textContent = 'Confirm import';
    } catch (error) {
      importError.textContent = error instanceof SyntaxError ? 'Invalid JSON. Check the format guide and try again.' : error.message;
      importError.hidden = false;
    }
    return;
  }

  const recipes = importPending;
  let imported = 0;
  importButton.disabled = true;
  importSource.disabled = true;
  importButton.textContent = 'Importing…';
  try {
    for (const recipe of recipes) {
      await addDoc(collection(db, 'recipes'), { ...recipe, timestamp: serverTimestamp() });
      imported += 1;
    }
    importSource.value = '';
    resetImportReview();
    importModal.close();
    workspace.showPage('recipes');
    workspace.toast(`Imported ${imported} ${imported === 1 ? 'recipe' : 'recipes'}.`);
  } catch (error) {
    importPending = recipes.slice(imported);
    importSource.value = JSON.stringify(importPending, null, 2);
    importPreview.hidden = true;
    importError.textContent = `Saved ${imported} of ${recipes.length}. ${error.message}`;
    importError.hidden = false;
    importButton.textContent = 'Retry remaining recipes';
  } finally {
    importButton.disabled = false;
    importSource.disabled = false;
  }
});

renderSteps();
