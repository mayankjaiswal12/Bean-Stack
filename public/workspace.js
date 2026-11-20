import { brewWaterRange, defaultTarget, targets } from './recipes/recipe-engine.js';
import { brewDate, brewDuration, brewPosition, formatClock, summarizeJournal, timelineFor } from './recipes/brewing.js';
import { readSettings } from './recipes/gemini.js';

const paths = {
  coffee: '<path d="M3 9h14v4a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5V9Zm14 1h2a2 2 0 1 1 0 4h-2M2 21h19M7 3v3m4-3v3m4-3v3"/>',
  overview: '<rect x="3" y="3" width="7" height="8" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="3" y="15" width="7" height="6" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/>',
  book: '<path d="M5 3h14v18H6a2 2 0 0 1 0-4h13M5 3a2 2 0 0 0-2 2v14M8 7h7m-7 4h7"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M9 2h6m-3 0v3m0 8 3-3m3.5-3.5L20 5"/>',
  bean: '<ellipse cx="12" cy="12" rx="7" ry="10" transform="rotate(41 12 12)"/><path d="M17.6 4c-4 1-2.8 5-5.6 8-2.7 3-6.5 2-5.8 8"/>',
  history: '<path d="M3 12a9 9 0 1 1 2.7 6.4M3 5v7h7m2-4v5l3 2"/>',
  chart: '<path d="M3 3v18h18M7 17v-4m5 4V9m5 8V5"/>',
  spark: '<path d="m12 2 2.6 7.4L22 12l-7.4 2.6L12 22l-2.6-7.4L2 12l7.4-2.6L12 2Zm7 1v4m-2-2h4"/>',
  settings: '<path d="m10 2-1 3-3 1-3-1-2 4 2 2v3l-2 2 2 4 3-1 3 1 1 3h4l1-3 3-1 3 1 2-4-2-2v-3l2-2-2-4-3 1-3-1-1-3Z" transform="translate(1 1) scale(.91)"/><circle cx="12" cy="12" r="3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  panel: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M9 5v14"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  search: '<circle cx="10.7" cy="10.7" r="6.2"/><path d="m16 16 4 4"/>',
  play: '<path d="m8 5 11 7-11 7Z"/>',
  star: '<path d="m12 3 2.7 5.5 6 .9-4.3 4.2 1 6-5.4-2.9-5.4 2.9 1-6-4.3-4.2 6-.9Z"/>',
  grid: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12m-16-12h.01M4 12h.01M4 18h.01"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/>',
  upload: '<path d="M12 16V4M8 8l4-4 4 4M4 16v4h16v-4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/>',
  sliders: '<path d="M4 7h16M4 17h16M8 4v6m8 4v6"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13m-8 4v5m4-5v5"/>',
  drop: '<path d="M12 3c-2 3-7 8-7 12a7 7 0 0 0 14 0c0-4-5-9-7-12Z"/>',
};

export function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.coffee}</svg>`;
}

export function escapeText(value) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value ?? '').replace(/[&<>"']/g, character => entities[character]);
}

const titles = {
  overview: 'Overview', recipes: 'Brew Recipes', editor: 'Recipe editor', timer: 'Brew Timer',
  beans: 'My Beans', history: 'Brew History', analytics: 'Analytics', assistant: 'AI Coffee Assistant', settings: 'Settings',
};
const itemIcon = (name, extra = '') => `<span class="${extra}" data-icon="${name}">${icon(name)}</span>`;
export const methodName = recipe => targets[recipe.generatedTarget || recipe.method]?.label || recipe.brewer || 'Other method';

function storageRead(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function stars(rating) {
  const value = Math.max(0, Math.min(5, Math.round(Number(rating) || 0)));
  return `<span class="stars" aria-label="${value ? `${value} out of 5 stars` : 'Unrated'}">${'★'.repeat(value)}${'☆'.repeat(5 - value)}</span>`;
}

export function empty(iconName, title, detail = '', button = '') {
  return `<div class="empty-state">${itemIcon(iconName)}<strong>${title}</strong>${detail ? `<p>${detail}</p>` : ''}${button}</div>`;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const dateLabel = value => {
  const date = brewDate(value);
  return date ? dateFormat.format(date) : 'Date unavailable';
};
const quantity = (value, unit) => value > 0 ? `${escapeText(value)}${unit}` : '—';
const normalizedName = value => String(value ?? '').trim().toLowerCase();
const ratioFor = item => item.coffee > 0 && item.water > 0
  ? `1:${((Number(item.water) + Number(item.ice ?? 0)) / Number(item.coffee)).toFixed(1)}` : '—';
const includes = (values, term) => values.some(value => String(value ?? '').toLowerCase().includes(term));
const parameters = values => `<div class="card-params">${values.map(([label, value]) => `<div><small>${label}</small><strong>${value}</strong></div>`).join('')}</div>`;
const methodColor = name => /iced/i.test(name) ? 'cool' : /aeropress/i.test(name) ? 'sage' : '';
const methodIcon = name => /iced/i.test(name) ? 'drop' : 'coffee';

export function createWorkspace(actions) {
  const field = id => document.getElementById(id);
  let recipes = [];
  let beans = [];
  let pendingAssistantBeanId = null;
  let readyRecipes = false;
  let readyBeans = false;
  let recipeError = false;
  let beanError = false;
  const savedFavorites = storageRead('beanstack.favorites', []);
  let favorites = new Set(Array.isArray(savedFavorites) ? savedFavorites : []);
  let journal = storageRead('beanstack.journal', []);
  if (!Array.isArray(journal)) journal = [];
  let toastTimer;
  let timerRecipe = null;
  let timerTimeline = [];
  let elapsed = 0;
  let startedAt = null;
  let interval;
  let brewComplete = false;
  let logged = false;

  for (const element of document.querySelectorAll('[data-icon]')) element.innerHTML = icon(element.dataset.icon);
  for (const [id, target] of Object.entries(targets)) {
    field('assistantMethod').add(new Option(target.label, id));
    field('recipeMethod').add(new Option(target.label, id));
  }
  field('assistantMethod').value = defaultTarget;
  resetAssistantWater();

  function resetAssistantWater() {
    const targetId = field('assistantMethod').value;
    const target = targets[targetId];
    const water = field('assistantWater');
    const [minimum, maximum] = brewWaterRange(targetId);
    water.min = minimum;
    water.max = maximum;
    water.value = target.water;
    field('assistantWaterLabel').textContent = target.ice ? 'Hot water (g)' : 'Water (g)';
  }

  function toast(message) {
    const element = field('toast');
    element.textContent = message;
    element.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { element.hidden = true; }, 3400);
  }

  function drawer(open) {
    field('shell').classList.toggle('drawer-open', open);
    field('drawerBackdrop').hidden = !open;
    field('mainContent').closest('.workarea').inert = open;
    field('openNavigation').setAttribute('aria-expanded', String(open));
    if (open) field('closeNavigation').focus();
  }

  function showPage(page, updateHash = true) {
    const destination = Object.hasOwn(titles, page) ? page : 'overview';
    const current = document.querySelector('[data-page]:not([hidden])')?.dataset.page;
    if (updateHash && location.hash !== `#${destination}`) history.pushState(null, '', `#${destination}`);
    for (const section of document.querySelectorAll('[data-page]')) section.hidden = section.dataset.page !== destination;
    for (const link of document.querySelectorAll('[data-nav]')) {
      if (link.dataset.nav === destination) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    field('pageTitle').textContent = titles[destination];
    document.title = `${titles[destination]} · Bean Stack`;
    drawer(false);
    if (current !== destination) {
      window.scrollTo(0, 0);
      field('mainContent').focus({ preventScroll: true });
    }
    if (destination === 'assistant') updateConnection();
  }

  function refill(select, placeholder, records) {
    const selected = select.value;
    select.replaceChildren(new Option(placeholder, ''));
    for (const [id, text] of records) select.add(new Option(text, id));
    if ([...select.options].some(option => option.value === selected)) select.value = selected;
  }

  function renderRecipes() {
    if (recipeError) {
      field('recipesGrid').innerHTML = empty('info', 'Recipes could not be loaded', 'Check the Firebase connection and reload the page.');
      return;
    }
    if (!readyRecipes) return;
    const term = field('searchRecipes').value.toLowerCase().trim();
    const method = field('recipeMethodFilter').value;
    const onlyFavorites = field('favoritesFilter').getAttribute('aria-pressed') === 'true';
    const sort = field('recipeSort').value;
    const matches = recipes.filter(recipe => (!method || methodName(recipe) === method) &&
      (!onlyFavorites || favorites.has(recipe.id)) && includes([recipe.name, recipe.bean, methodName(recipe)], term));
    if (sort === 'rating') matches.sort((left, right) => (Number(right.rating) || 0) - (Number(left.rating) || 0));
    if (sort === 'name') matches.sort((left, right) => String(left.name).localeCompare(String(right.name)));
    field('recipesGrid').innerHTML = matches.length ? matches.map(recipe => {
      const method = methodName(recipe);
      const favorite = favorites.has(recipe.id);
      const duration = brewDuration(timelineFor(recipe.steps));
      const id = escapeText(recipe.id);
      return `<article class="collection-card"><div class="card-cover ${methodColor(method)}">${itemIcon(methodIcon(method))}<span class="tag">${escapeText(method)}</span><button type="button" class="icon-btn favorite-icon" data-action="favorite" data-id="${id}" aria-label="Favorite ${escapeText(recipe.name)}" aria-pressed="${favorite}">${icon('star')}</button></div>
        <div class="collection-body"><div><h2>${escapeText(recipe.name)}</h2><p>${escapeText(recipe.bean || 'Coffee bean unspecified')}</p>${stars(recipe.rating)}</div>
        ${parameters([
          ['Dose', quantity(recipe.coffee, ' g')],
          ['Water', quantity(recipe.water, ' g')],
          ['Temp', quantity(recipe.temp, '°C')],
          ['Ratio', ratioFor(recipe)],
          ['Brew time', duration ? formatClock(duration) : '—'],
          ['Grind size', escapeText(String(recipe.grind ?? '').trim() || '—')],
        ])}
        <div class="card-actions"><button class="btn outline" data-action="edit-recipe" data-id="${id}">Edit</button><button class="btn" data-action="brew-recipe" data-id="${id}">Brew</button><button class="icon-btn" data-action="delete-recipe" data-id="${id}" aria-label="Delete ${escapeText(recipe.name)}">${icon('trash')}</button></div></div></article>`;
    }).join('') : empty('book', recipes.length ? 'No recipes match' : 'Your recipe library is empty',
      recipes.length ? 'Try a different search or filter.' : 'Create a recipe or generate one from a coffee bean.',
      recipes.length ? '' : '<button class="btn" data-action="new-recipe">Create recipe</button>');
  }

  function renderBeans() {
    if (beanError) {
      field('beansGrid').innerHTML = empty('info', 'Beans could not be loaded', 'Check the Firebase connection and reload the page.');
      return;
    }
    if (!readyBeans) return;
    const term = field('searchBeans').value.toLowerCase().trim();
    const roast = field('beanRoastFilter').value;
    const process = field('beanProcessFilter').value;
    const matches = beans.filter(bean => (!roast || bean.roast === roast) && (!process || bean.process === process) &&
      includes([bean.name, bean.origin, bean.roaster, bean.tastingNotes, bean.notes], term));
    field('beansGrid').innerHTML = matches.length ? matches.map(bean => {
      const methods = [...new Set([
        ...(Array.isArray(bean.brewMethods) ? bean.brewMethods.filter(method => Object.hasOwn(targets, method)).map(id => targets[id].label) : []),
        ...recipes.filter(recipe => normalizedName(recipe.bean) === normalizedName(bean.name)).map(methodName),
      ])];
      const id = escapeText(bean.id);
      return `<article class="collection-card"><div class="card-cover bean-cover"><strong class="bean-origin">${escapeText(bean.origin || 'Origin unspecified')}</strong>${itemIcon('bean')}</div>
        <div class="collection-body"><h2>${escapeText(bean.name)}</h2><p>${escapeText(bean.roaster || 'Roaster unspecified')}</p><div class="tags">${[bean.roast, bean.process].filter(Boolean).map(tag => `<span class="tag">${escapeText(tag)}</span>`).join('')}</div>
        ${bean.roastDate ? `<p>Roasted ${escapeText(bean.roastDate)}</p>` : ''}${bean.tastingNotes ? `<p>${escapeText(bean.tastingNotes)}</p>` : ''}${bean.notes ? `<p>${escapeText(bean.notes)}</p>` : ''}${stars(bean.rating)}
        ${methods.length ? `<p class="muted">${methods.map(escapeText).join(' · ')}</p>` : ''}
        <div class="card-actions"><button class="btn outline" data-action="edit-bean" data-id="${id}">Edit</button><button class="btn" data-action="brew-bean" data-id="${id}">Generate recipe</button><button class="icon-btn" data-action="delete-bean" data-id="${id}" aria-label="Delete ${escapeText(bean.name)}">${icon('trash')}</button></div></div></article>`;
    }).join('') : empty('bean', beans.length ? 'No beans match' : 'Your bean shelf is empty',
      beans.length ? 'Try a different search or filter.' : 'Add a bean to track its roast and prepare its first recipe.',
      beans.length ? '' : '<button class="btn" data-action="new-bean">Add a bean</button>');
  }

  function refreshRecipeOptions() {
    const names = [...new Set(recipes.map(methodName))].sort();
    refill(field('recipeMethodFilter'), 'All methods', names.map(name => [name, name]));
    const choices = recipes.map(recipe => [recipe.id, recipe.name]);
    refill(field('assistantRecipe'), 'Choose a recipe', choices);
    refill(field('timerRecipe'), 'Choose a saved recipe', choices);
    if (timerRecipe) field('timerRecipe').value = timerRecipe.id || '';
  }

  function refreshBeanOptions() {
    const roasts = [...new Set(beans.map(bean => bean.roast).filter(Boolean))];
    const processes = [...new Set(beans.map(bean => bean.process).filter(Boolean))];
    refill(field('beanRoastFilter'), 'All roast levels', roasts.map(name => [name, name]));
    refill(field('beanProcessFilter'), 'All processes', processes.map(name => [name, name]));
    refill(field('assistantBean'), 'Choose a bean', beans.map(bean => [bean.id, bean.name]));
    if (pendingAssistantBeanId) selectAssistantBean(pendingAssistantBeanId);
    field('beanNames').replaceChildren(...beans.map(bean => new Option(bean.name)));
  }

  function selectAssistantBean(id) {
    if (beans.some(bean => bean.id === id)) {
      field('assistantBean').value = id;
      pendingAssistantBeanId = null;
    } else {
      pendingAssistantBeanId = id;
    }
  }

  function renderOverview(stats) {
    field('metricBrews').textContent = stats.total;
    field('metricRecipes').textContent = readyRecipes ? recipes.length : '—';
    field('metricBeans').textContent = readyBeans ? beans.length : '—';
    field('metricRating').textContent = stats.average === null ? '—' : stats.average.toFixed(1);
    field('recentBrews').innerHTML = journal.length ? journal.slice(0, 4).map(brew =>
      `<div class="activity-row">${itemIcon('coffee')}<div><strong>${escapeText(brew.name)}</strong><p>${escapeText(brew.method)}</p></div><time>${dateLabel(brew.date)}</time></div>`
    ).join('') : empty('history', 'No brews logged yet', 'Start the timer and save your first brew to build your journal.');
    const last = journal[0];
    field('lastBrew').innerHTML = last
      ? `<strong>${escapeText(last.name)}</strong><p>${escapeText(last.method)} · ${dateLabel(last.date)}</p>`
      : empty('coffee', 'Your first brew is ahead', 'Completed brews appear here.');
    const favorite = recipes.find(recipe => favorites.has(recipe.id));
    field('favoriteBrew').innerHTML = favorite
      ? `<strong>${escapeText(favorite.name)}</strong><p>${escapeText(methodName(favorite))}</p><button class="btn outline push-top" data-action="brew-recipe" data-id="${escapeText(favorite.id)}">Brew favorite</button>`
      : empty('star', 'No favorite recipes yet', 'Star a recipe in your library to pin a favorite here.');
  }

  function renderJournal() {
    field('exportHistory').disabled = !journal.length;
    field('brewJournal').innerHTML = journal.length ? journal.map(entry =>
      `<article class="panel journal-card"><div><h2>${escapeText(entry.name)}</h2><p>${escapeText(entry.bean || 'Coffee bean unspecified')} · ${escapeText(entry.method)}</p><p>${dateLabel(entry.date)}</p>${stars(entry.rating)}${entry.notes ? `<p class="push-top">${escapeText(entry.notes)}</p>` : ''}</div>
        ${parameters([['Dose', quantity(entry.coffee, ' g')], ['Water', quantity(entry.water, ' g')], ['Ice', quantity(entry.ice, ' g')], ['Temperature', quantity(entry.temp, '°C')], ['Ratio', ratioFor(entry)], ['Grind', escapeText(entry.grind || '—')]])}</article>`
    ).join('') : empty('history', 'Your brew journal is empty', 'Save a completed timer session to create a journal entry.', '<a class="btn" href="#timer">Open brew timer</a>');
  }

  function renderChart(element, days, property, max, emptyTitle) {
    if (!days.some(day => day[property])) {
      element.innerHTML = empty('chart', emptyTitle);
      return;
    }
    const chartLabel = days.map(day => `${shortDate.format(day.date)}: ${day[property] === null ? 'unrated' : Number(day[property].toFixed(1))}`).join(', ');
    element.innerHTML = `<div class="chart ${property === 'rating' ? 'rating-chart' : ''}" role="img" aria-label="${escapeText(chartLabel)}">
      ${days.map(day => `<div class="chart-column" title="${shortDate.format(day.date)} · ${day[property] === null ? 'unrated' : Number(day[property].toFixed(1))}"><span style="height:${(day[property] ?? 0) / max * 100}%"></span></div>`).join('')}
      </div><div class="chart-labels"><span>${shortDate.format(days[0].date)}</span><span>${shortDate.format(days.at(-1).date)}</span></div>`;
  }

  function renderAnalytics(stats) {
    const metrics = [
      ['coffee', 'Total brews', stats.total],
      ['star', 'Average rating', stats.average?.toFixed(1) ?? '—'],
      ['timer', 'Favorite method', stats.favoriteMethod ?? '—'],
      ['bean', 'Most-used bean', stats.topBeans[0]?.[0] ?? '—'],
    ];
    field('analyticsMetrics').innerHTML = metrics.map(([name, label, value]) =>
      `<div class="metric">${itemIcon(name)}<span>${label}</span><strong>${escapeText(value)}</strong></div>`).join('');
    renderChart(field('activityChart'), stats.days, 'count', Math.max(...stats.days.map(day => day.count), 1), 'No brews in this period');
    renderChart(field('ratingChart'), stats.days, 'rating', 5, 'No ratings in this period');
    field('topBeans').innerHTML = stats.topBeans.length
      ? `<ol class="chart-list">${stats.topBeans.map(([bean, count]) => `<li><strong>${escapeText(bean)}</strong><span>${count} ${count === 1 ? 'brew' : 'brews'}</span></li>`).join('')}</ol>`
      : empty('bean', 'No beans brewed yet');
  }

  function refreshJournal() {
    const stats = summarizeJournal(journal);
    renderOverview(stats);
    renderJournal();
    renderAnalytics(stats);
  }

  function renderSearch() {
    const term = field('globalQuery').value.trim().toLowerCase();
    const matches = term ? [
      ...recipes.filter(item => includes([item.name, item.bean, methodName(item)], term)).slice(0, 7)
        .map(item => ({ id: item.id, name: item.name, type: 'recipe', details: methodName(item) })),
      ...beans.filter(item => includes([item.name, item.origin, item.roaster], term)).slice(0, 7)
        .map(item => ({ id: item.id, name: item.name, type: 'bean', details: item.origin || item.roaster || '' })),
    ] : [];
    field('globalResults').innerHTML = term ? (matches.length ? matches.map(item =>
      `<button data-search-type="${item.type}" data-id="${escapeText(item.id)}"><strong>${escapeText(item.name)}</strong><small>${item.type === 'recipe' ? 'Recipe' : 'Bean'}${item.details ? ` · ${escapeText(item.details)}` : ''}</small></button>`
    ).join('') : empty('search', 'No matches found')) : '<p>Search by recipe, coffee bean, roaster, or brew method.</p>';
  }

  function search() {
    const dialog = field('searchDialog');
    if (!dialog.open) {
      field('globalQuery').value = '';
      renderSearch();
      dialog.showModal();
      field('globalQuery').focus();
    }
  }

  function exportJson(name, data) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function timerTime() {
    return elapsed + (startedAt === null ? 0 : (performance.now() - startedAt) / 1000);
  }

  function pauseTimer() {
    elapsed = timerTime();
    startedAt = null;
    clearInterval(interval);
  }

  function timerGuide() {
    const guide = field('timerGuide');
    guide.innerHTML = timerTimeline.length ? timerTimeline.map(step =>
      `<li><div><strong>${escapeText(step.label || step.type)}</strong><p>${escapeText(step.notes || '')}</p></div><span>${formatClock(step.start)}</span></li>`
    ).join('') : '<li>Add brewing steps to see the guide here.</li>';
  }

  function openReview() {
    const modal = field('brewReview');
    if (!timerRecipe || logged || modal.open) return;
    field('brewReviewRecipe').textContent = timerRecipe.name;
    modal.showModal();
  }

  function renderTimer() {
    const time = timerTime();
    const position = brewPosition(timerTimeline, time);
    const active = timerTimeline[position.active];
    const next = timerTimeline[position.next];
    if (timerTimeline.length && time >= position.end && !brewComplete) {
      pauseTimer();
      elapsed = position.end;
      brewComplete = true;
      if (!field('timerRecipe').closest('[data-page]').hidden) openReview();
    }
    field('timerRecipeName').textContent = timerRecipe?.name || 'Choose a recipe to begin';
    field('timerStep').textContent = brewComplete ? 'Brew complete' : active?.label || active?.type || (next ? 'Get ready' : 'Ready to brew');
    field('timerClock').textContent = formatClock(brewComplete ? 0 : position.remaining);
    field('timerInstruction').textContent = brewComplete ? 'Your timer is finished.' :
      active?.notes || (next ? 'Wait for the next step.' : 'Select a recipe with brewing steps.');
    const targetStep = timerTimeline.findLast(step => step.start <= time && step.weight > 0);
    field('timerWeight').textContent = targetStep ? `${targetStep.weight} g` : '—';
    field('timerTotal').textContent = timerRecipe?.water > 0 ? `${timerRecipe.water} g` : '—';
    field('timerProgress').value = position.end ? Math.min(100, time / position.end * 100) : 0;
    field('timerNext').textContent = next && !brewComplete ? `Next · ${next.label || next.type}` : '';
    field('timerStartPause').textContent = brewComplete ? (logged ? 'Brew saved' : 'Log this brew') :
      startedAt !== null ? 'Pause' : elapsed > 0 ? 'Resume' : 'Start brew';
    field('timerStartPause').disabled = !timerTimeline.length || logged;
    field('timerSkip').disabled = !timerTimeline.length || brewComplete || (startedAt === null && elapsed === 0);
    field('timerRestart').disabled = !timerTimeline.length;
    [...field('timerGuide').children].forEach((item, index) => {
      if (index === position.active) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    });
  }

  function startTimer(recipe, navigate = true) {
    pauseTimer();
    timerRecipe = recipe ? { ...recipe, steps: (recipe.steps ?? []).map(step => ({ ...step })) } : null;
    timerTimeline = timelineFor(timerRecipe?.steps);
    elapsed = 0;
    brewComplete = false;
    logged = false;
    field('journalRating').value = '';
    field('journalNotes').value = '';
    field('timerRecipe').value = recipe?.id || '';
    timerGuide();
    if (navigate) showPage('timer');
    renderTimer();
  }

  function updateConnection() {
    const settings = readSettings(localStorage);
    field('assistantConnection').textContent = settings.key ? `Connected in this browser · ${settings.model}` : 'Chart-based recipes are available. Connect Gemini for optional recommendations.';
  }

  function routeAction(button) {
    const { action, id } = button.dataset;
    switch (action) {
      case 'new-recipe': actions.newRecipe(); break;
      case 'new-bean': actions.newBean(); break;
      case 'new-assistant-bean': actions.newBean('assistant'); break;
      case 'edit-recipe': actions.openRecipe(id); break;
      case 'delete-recipe': actions.deleteRecipe(id); break;
      case 'edit-bean': actions.openBean(id); break;
      case 'delete-bean': actions.deleteBean(id); break;
      case 'brew-bean': actions.generateBean(beans.find(bean => bean.id === id), defaultTarget); break;
      case 'brew-recipe': startTimer(recipes.find(recipe => recipe.id === id)); break;
      case 'ai-settings': field('btnGeminiSettings').click(); break;
      case 'favorite': {
        const next = new Set(favorites);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        try {
          localStorage.setItem('beanstack.favorites', JSON.stringify([...next]));
          favorites = next;
          renderRecipes();
          const replacement = [...field('recipesGrid').querySelectorAll('[data-action=favorite]')].find(item => item.dataset.id === id);
          (replacement ?? field('favoritesFilter')).focus();
          renderOverview(summarizeJournal(journal));
        } catch {
          toast('Browser storage is unavailable. The favorite could not be saved.');
        }
        break;
      }
    }
  }

  document.addEventListener('click', event => {
    const button = event.target.closest('[data-action]');
    if (button) routeAction(button);
    const link = event.target.closest('a[href^="#"]');
    if (link && Object.hasOwn(titles, link.hash.slice(1)) &&
        !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      showPage(link.hash.slice(1));
    }
  });
  window.addEventListener('hashchange', () => showPage(location.hash.slice(1), false));
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !document.querySelector('dialog[open]')) {
      event.preventDefault();
      search();
    }
    if (event.key === 'Escape' && field('shell').classList.contains('drawer-open')) {
      drawer(false);
      field('openNavigation').focus();
    }
  });

  field('collapseSidebar').addEventListener('click', () => {
    const collapsed = field('shell').classList.toggle('sidebar-collapsed');
    const button = field('collapseSidebar');
    button.setAttribute('aria-expanded', String(!collapsed));
    button.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
    button.title = button.getAttribute('aria-label');
  });
  field('openNavigation').addEventListener('click', () => drawer(true));
  matchMedia('(max-width: 950px)').addEventListener('change', () => drawer(false));
  for (const id of ['closeNavigation', 'drawerBackdrop']) {
    field(id).addEventListener('click', () => { drawer(false); field('openNavigation').focus(); });
  }
  field('openSearch').addEventListener('click', search);
  field('closeSearch').addEventListener('click', () => field('searchDialog').close());
  field('globalQuery').addEventListener('input', renderSearch);
  field('globalResults').addEventListener('click', event => {
    const button = event.target.closest('[data-search-type]');
    if (!button) return;
    field('searchDialog').close();
    if (button.dataset.searchType === 'recipe') actions.openRecipe(button.dataset.id);
    else actions.openBean(button.dataset.id);
  });
  field('searchRecipes').addEventListener('input', renderRecipes);
  field('recipeMethodFilter').addEventListener('change', renderRecipes);
  field('recipeSort').addEventListener('change', renderRecipes);
  field('favoritesFilter').addEventListener('click', event => {
    const button = event.currentTarget;
    button.setAttribute('aria-pressed', String(button.getAttribute('aria-pressed') !== 'true'));
    renderRecipes();
  });
  for (const button of document.querySelectorAll('[data-view]')) {
    button.addEventListener('click', () => {
      field('recipesGrid').classList.toggle('list-view', button.dataset.view === 'list');
      for (const control of document.querySelectorAll('[data-view]')) control.setAttribute('aria-pressed', String(control === button));
    });
  }
  field('searchBeans').addEventListener('input', renderBeans);
  field('beanRoastFilter').addEventListener('change', renderBeans);
  field('beanProcessFilter').addEventListener('change', renderBeans);
  field('assistantBean').addEventListener('change', () => {
    pendingAssistantBeanId = null;
    field('assistantStatus').textContent = '';
  });
  field('assistantMethod').addEventListener('change', () => {
    field('assistantStatus').textContent = '';
    resetAssistantWater();
  });
  field('assistantGenerate').addEventListener('click', () => {
    const selection = field('assistantBean');
    const bean = beans.find(item => item.id === selection.value);
    const status = field('assistantStatus');
    if (!bean) {
      status.textContent = 'Choose or add a coffee bean first.';
      selection.focus();
      return;
    }
    status.textContent = '';
    const water = field('assistantWater');
    if (!water.reportValidity()) return;
    actions.generateBean(bean, field('assistantMethod').value, water.valueAsNumber);
  });
  field('assistantImprove').addEventListener('click', () => {
    const recipe = recipes.find(item => item.id === field('assistantRecipe').value);
    field('assistantStatus').textContent = recipe ? '' : 'Choose a saved recipe first.';
    if (recipe) actions.improveRecipe(recipe);
  });
  field('exportRecipes').addEventListener('click', () => exportJson('bean-stack-recipes.json', recipes.map(({ id, timestamp, ...recipe }) => recipe)));
  field('exportHistory').addEventListener('click', () => exportJson('bean-stack-journal.json', journal));
  field('timerRecipe').addEventListener('change', event => startTimer(recipes.find(recipe => recipe.id === event.target.value), false));
  field('timerStartPause').addEventListener('click', () => {
    if (brewComplete) {
      openReview();
      return;
    }
    if (startedAt !== null) pauseTimer();
    else {
      startedAt = performance.now();
      interval = setInterval(renderTimer, 120);
    }
    renderTimer();
  });
  field('timerSkip').addEventListener('click', () => {
    const playing = startedAt !== null;
    const position = brewPosition(timerTimeline, timerTime());
    elapsed = timerTimeline[position.next]?.start ?? position.end;
    if (playing) startedAt = performance.now();
    renderTimer();
  });
  field('timerRestart').addEventListener('click', () => startTimer(timerRecipe, false));
  field('closeBrewReview').addEventListener('click', () => field('brewReview').close());
  field('saveBrew').addEventListener('click', () => {
    if (!brewComplete || !timerRecipe || logged) return;
    const { id, name, bean, coffee, water, ice, temp, grind } = timerRecipe;
    const entry = {
      recipeId: id || '', name, bean, coffee, water, ice, temp, grind, method: methodName(timerRecipe), date: new Date().toISOString(),
      rating: Number(field('journalRating').value), notes: field('journalNotes').value.trim(),
    };
    const next = [entry, ...journal];
    try {
      localStorage.setItem('beanstack.journal', JSON.stringify(next));
      journal = next;
      logged = true;
      field('brewReview').close();
      renderTimer();
      refreshJournal();
      toast('Brew saved to your journal.');
    } catch {
      toast('Browser storage is unavailable. The brew could not be saved.');
    }
  });

  startTimer(null, false);
  refreshJournal();
  showPage(location.hash.slice(1), false);

  return {
    showPage, startTimer, toast, updateConnection, selectAssistantBean,
    setRecipes(records, error = false) {
      recipes = records;
      readyRecipes = !error;
      recipeError = error;
      refreshRecipeOptions();
      renderRecipes();
      renderBeans();
      renderOverview(summarizeJournal(journal));
    },
    setBeans(records, error = false) {
      beans = records;
      readyBeans = !error;
      beanError = error;
      refreshBeanOptions();
      renderBeans();
      renderOverview(summarizeJournal(journal));
    },
  };
}
