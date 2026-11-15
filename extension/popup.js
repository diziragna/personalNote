const ext = globalThis.browser ?? globalThis.chrome;
// The Daynote deployment is the one host the manifest grants, so it is only configured there.
const API_BASE = ext.runtime.getManifest().host_permissions[0].replace(/\/\*$/, '');
const NOTE_COLORS = ['yellow', 'pink', 'blue', 'green', 'purple', 'orange'];
// Edits are sent after this pause, so a burst of changes becomes one request; the API blocks bursts.
const SAVE_DELAY = 700;
const $ = (selector) => document.querySelector(selector);

const state = {
  token: null,
  notes: [],
  openId: null,
  // Edits the server has not accepted yet, by note id: { changes, at }. Kept in storage so a closed popup loses nothing.
  drafts: new Map(),
  sending: new Set(),
  saveTimer: 0,
  // Editors typed in since their content was last captured into a draft.
  dirtyEditors: new Map(),
  captureTimer: 0,
  renderPending: false,
  unloading: false,
};

async function request(path, { method = 'GET', body, keepalive = false } = {}) {
  let response;
  try {
    response = await fetch(API_BASE + path, {
      method,
      keepalive,
      credentials: 'omit',
      headers: { ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body && JSON.stringify(body),
    });
  } catch (_) {
    throw Object.assign(new Error(`Can't reach ${new URL(API_BASE).host}.`), { offline: true });
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Please try again.'), { status: response.status });
  return data;
}

function show(message, element = $('#status')) {
  element.textContent = message || '';
  element.hidden = !message;
}

function todayKey() {
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function formatDeadline(value) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(`${value}T00:00:00`));
}

const findNote = (id) => state.notes.find((note) => note.id === id);
const cardFor = (id) => $('#list').querySelector(`[data-id="${CSS.escape(id)}"]`);

function persist() {
  ext.storage.local.set({ notes: state.notes, drafts: Object.fromEntries(state.drafts) }).catch(() => {});
}

function applyChanges(note, changes) {
  // The API takes an empty string to clear a deadline and stores it as null.
  for (const [key, value] of Object.entries(changes)) note[key] = key === 'due_date' ? value || null : value;
}

function queueSave(note, changes) {
  applyChanges(note, changes);
  const draft = state.drafts.get(note.id) ?? { changes: {} };
  Object.assign(draft.changes, changes);
  draft.at = Date.now();
  state.drafts.set(note.id, draft);
  syncCard(note);
  persist();
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(flushDrafts, SAVE_DELAY);
}

function markDirty(note, editor) {
  state.dirtyEditors.set(note.id, editor);
  clearTimeout(state.captureTimer);
  state.captureTimer = setTimeout(captureEditors, 400);
}

function captureEditors() {
  clearTimeout(state.captureTimer);
  for (const [id, editor] of state.dirtyEditors) {
    const note = findNote(id);
    const value = serializeEditor(editor);
    if (!note || value === note.content) continue;
    // Keep an over-long note in the editor rather than send something the API will refuse.
    if ([...value].length > 2000) { show('A note can be at most 2,000 characters.'); continue; }
    queueSave(note, { content: value });
  }
  state.dirtyEditors.clear();
}

function flushDrafts() {
  clearTimeout(state.saveTimer);
  captureEditors();
  clearTimeout(state.saveTimer);
  const sends = [];
  for (const [id, draft] of state.drafts) {
    // While the popup closes, resend even in-flight edits: those requests may be cut off.
    if (!state.sending.has(id) || state.unloading) sends.push(sendDraft(id, draft));
  }
  return Promise.all(sends);
}

async function sendDraft(id, draft) {
  const { at } = draft;
  state.sending.add(id);
  try {
    const { note: saved } = await request('/api/notes', { method: 'PATCH', body: { id, ...draft.changes }, keepalive: state.unloading });
    const note = findNote(id);
    if (state.drafts.get(id)?.at === at) {
      state.drafts.delete(id);
      if (note) { Object.assign(note, saved); syncCard(note); }
    } else if (note) {
      note.updated_at = saved.updated_at;
    }
    show('');
  } catch (error) {
    if (error.status === 401) return signOutLocally('Your session ended. Please sign in again.');
    if (error.status === 400 || error.status === 404) {
      // The server refused these edits, so drop them and reload what it has.
      if (state.drafts.get(id)?.at === at) state.drafts.delete(id);
      await refresh();
      show(error.message);
    } else {
      show(`${error.message} Your changes are kept and will be sent when you next open Daynote.`);
    }
  } finally {
    state.sending.delete(id);
    persist();
  }
}

// Merge fresh notes into the ones on screen, keeping object identity and any newer local edits.
function mergeNotes(fresh) {
  const known = new Map(state.notes.map((note) => [note.id, note]));
  state.notes = fresh.map((note) => {
    const local = known.get(note.id);
    if (local && Date.parse(local.updated_at) > Date.parse(note.updated_at)) return local;
    return Object.assign(local ?? {}, note);
  });
  // A draft older than the note's last save already reached the server or was overtaken there.
  for (const [id, draft] of state.drafts) {
    const note = findNote(id);
    if (note && Date.parse(note.updated_at) < draft.at) applyChanges(note, draft.changes);
    else if (!state.sending.has(id)) state.drafts.delete(id);
  }
}

// Open notes first, soonest deadline first, then most recently edited.
function compareNotes(a, b) {
  if (a.completed !== b.completed) return a.completed ? 1 : -1;
  if (a.due_date !== b.due_date) return !a.due_date ? 1 : !b.due_date ? -1 : a.due_date < b.due_date ? -1 : 1;
  return Date.parse(b.updated_at) - Date.parse(a.updated_at);
}

function setOpen(id, { focusTitle = false } = {}) {
  captureEditors();
  const previous = state.openId;
  state.openId = id;
  for (const noteId of new Set([previous, id])) {
    const note = noteId && findNote(noteId);
    if (note) cardFor(noteId)?.replaceWith(buildNote(note));
  }
  applySearch();
  const card = cardFor(id ?? previous ?? '');
  card?.querySelector(focusTitle ? '.title-input' : '.toggle')?.focus();
}

function syncCard(note, card = cardFor(note.id)) {
  if (!card) return;
  const overdue = Boolean(note.due_date && !note.completed && note.due_date < todayKey());
  card.className = `note color-${note.color}${note.completed ? ' completed' : ''}${note.id === state.openId ? ' open' : ''}`;
  const checkbox = card.querySelector('.note-checkbox');
  checkbox.checked = note.completed;
  checkbox.setAttribute('aria-label', note.completed ? 'Mark note active' : 'Mark note complete');
  const title = card.querySelector('.note-title');
  if (title) {
    title.textContent = note.title || 'Untitled';
    title.classList.toggle('placeholder', !note.title);
  }
  // Never overwrite a field the user is typing in.
  const titleInput = card.querySelector('.title-input');
  if (titleInput && document.activeElement !== titleInput) titleInput.value = note.title;
  const deadline = card.querySelector('.deadline-label');
  deadline.hidden = !note.due_date;
  deadline.textContent = note.due_date ? formatDeadline(note.due_date) : '';
  deadline.classList.toggle('overdue', overdue);
  const dateInput = card.querySelector('.date-input');
  if (dateInput && document.activeElement !== dateInput) dateInput.value = note.due_date || '';
  for (const swatch of card.querySelectorAll('.swatch')) swatch.setAttribute('aria-pressed', String(swatch.dataset.color === note.color));
  const plain = contentToLines(note.content).map((line) => line.textContent).join(' ');
  card.dataset.search = [note.title, plain, note.due_date, note.due_date && formatDeadline(note.due_date), overdue && 'overdue']
    .filter(Boolean).join(' ').toLowerCase();
}

function buildNote(note) {
  const open = note.id === state.openId;
  const card = document.createElement('article');
  card.dataset.id = note.id;

  const head = document.createElement('div');
  head.className = 'note-head';
  const checkbox = document.createElement('input');
  checkbox.className = 'note-checkbox';
  checkbox.type = 'checkbox';
  checkbox.addEventListener('change', () => {
    captureEditors();
    const changes = { completed: checkbox.checked };
    // Completing the note ticks every checklist line in it; reopening leaves the lines as they are.
    const ticked = note.content.split('\n').map((line) => line.replace(/^- \[ \](?= |$)/, '- [x]')).join('\n');
    if (checkbox.checked && ticked !== note.content) changes.content = ticked;
    queueSave(note, changes);
    if (changes.content) card.querySelector('.editor')?.replaceChildren(...contentToLines(note.content));
  });

  let title;
  if (open) {
    title = document.createElement('input');
    title.className = 'title-input';
    title.maxLength = 120;
    title.placeholder = 'Untitled';
    title.setAttribute('aria-label', 'Note title');
    title.addEventListener('input', () => queueSave(note, { title: title.value }));
    title.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const editor = card.querySelector('.editor');
      editor.focus();
      window.getSelection().selectAllChildren(editor);
      window.getSelection().collapseToEnd();
    });
  } else {
    title = document.createElement('span');
    title.className = 'note-title';
  }
  const deadline = document.createElement('span');
  deadline.className = 'deadline-label';
  const toggle = document.createElement('button');
  toggle.className = 'toggle';
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? 'Collapse note' : 'Expand note');
  head.addEventListener('click', (event) => {
    if (event.target.closest('input') || (event.target.closest('button') && event.target !== toggle)) return;
    setOpen(open ? null : note.id);
  });
  head.append(checkbox, title, deadline, toggle);
  card.append(head);
  if (open) card.append(buildEditor(note), buildTools(note, card));
  syncCard(note, card);
  return card;
}

function buildEditor(note) {
  const editor = document.createElement('div');
  editor.className = 'editor';
  editor.contentEditable = 'true';
  editor.spellcheck = true;
  editor.dataset.placeholder = 'Write something…';
  editor.setAttribute('role', 'textbox');
  editor.setAttribute('aria-multiline', 'true');
  editor.setAttribute('aria-label', 'Note content');
  editor.append(...contentToLines(note.content));
  const isEmpty = () => editor.children.length <= 1 && !editor.textContent && !editor.querySelector('.task');
  editor.classList.toggle('is-empty', isEmpty());
  const afterEdit = () => {
    normalizeEditor(editor);
    editor.classList.toggle('is-empty', isEmpty());
    markDirty(note, editor);
  };
  editor.addEventListener('input', afterEdit);
  editor.addEventListener('blur', captureEditors);
  editor.addEventListener('beforeinput', (event) => {
    if (event.isComposing) return;
    if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') {
      event.preventDefault();
      splitLine(editor);
      afterEdit();
    } else if (event.inputType === 'deleteContentBackward') {
      const line = caretLine(editor);
      if (!line?.classList.contains('task') || !caretAtLineStart(line)) return;
      event.preventDefault();
      setLineTask(line, false);
      afterEdit();
    } else if (event.inputType === 'insertFromDrop' || (event.inputType.startsWith('format') && !['formatBold', 'formatItalic'].includes(event.inputType))) {
      event.preventDefault();
    }
  });
  editor.addEventListener('paste', (event) => {
    event.preventDefault();
    insertPlainText(editor, event.clipboardData.getData('text/plain'));
    afterEdit();
  });
  editor.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 'b' || key === 'i') {
      event.preventDefault();
      document.execCommand(key === 'b' ? 'bold' : 'italic');
      afterEdit();
    } else if (key === 'enter') {
      const line = caretLine(editor);
      if (!line?.classList.contains('task')) return;
      event.preventDefault();
      line.dataset.checked = String(line.dataset.checked !== 'true');
      afterEdit();
    }
  });
  // Line checkboxes are drawn in each task line's left padding.
  const checkboxLine = (event) => {
    const line = event.target.closest?.('.line.task');
    return line && editor.contains(line) && event.clientX - line.getBoundingClientRect().left < 20 ? line : null;
  };
  editor.addEventListener('mousedown', (event) => { if (checkboxLine(event)) event.preventDefault(); });
  editor.addEventListener('click', (event) => {
    const line = checkboxLine(event);
    if (!line) return;
    line.dataset.checked = String(line.dataset.checked !== 'true');
    markDirty(note, editor);
  });
  return editor;
}

function buildTools(note, card) {
  const tools = document.createElement('div');
  tools.className = 'note-tools';

  const formatRow = document.createElement('div');
  formatRow.className = 'tool-row';
  for (const [name, text, hint, action] of [
    ['bold', 'B', 'Bold (Ctrl+B)', () => document.execCommand('bold')],
    ['italic', 'I', 'Italic (Ctrl+I)', () => document.execCommand('italic')],
    ['checklist', '☑', 'Checklist (Ctrl+Enter ticks a line)', () => toggleChecklist(card.querySelector('.editor'))],
  ]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `tool-button format-${name}`;
    button.textContent = text;
    button.title = hint;
    button.setAttribute('aria-label', hint);
    // Keep focus and the selection in the editor while formatting.
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => {
      const editor = card.querySelector('.editor');
      if (!editor.contains(window.getSelection().anchorNode)) editor.focus();
      action();
      normalizeEditor(editor);
      markDirty(note, editor);
    });
    formatRow.append(button);
  }
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'delete-button';
  remove.textContent = 'Delete';
  let armTimer = 0;
  remove.addEventListener('click', () => {
    if (!remove.classList.contains('armed')) {
      // A second click within a few seconds confirms; deletion can't be undone.
      remove.classList.add('armed');
      remove.textContent = 'Delete forever?';
      armTimer = setTimeout(() => { remove.classList.remove('armed'); remove.textContent = 'Delete'; }, 3000);
      return;
    }
    clearTimeout(armTimer);
    deleteNote(note);
  });
  formatRow.append(remove);

  const detailRow = document.createElement('div');
  detailRow.className = 'tool-row';
  const dateInput = document.createElement('input');
  dateInput.type = 'date';
  dateInput.className = 'date-input';
  dateInput.setAttribute('aria-label', 'Deadline');
  dateInput.addEventListener('change', () => queueSave(note, { due_date: dateInput.value }));
  const clearDate = document.createElement('button');
  clearDate.type = 'button';
  clearDate.className = 'tool-button';
  clearDate.textContent = '×';
  clearDate.title = 'Remove deadline';
  clearDate.setAttribute('aria-label', 'Remove deadline');
  clearDate.addEventListener('click', () => { dateInput.value = ''; queueSave(note, { due_date: '' }); });
  const swatches = document.createElement('div');
  swatches.className = 'swatches';
  swatches.setAttribute('role', 'group');
  swatches.setAttribute('aria-label', 'Note color');
  for (const color of NOTE_COLORS) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = `swatch color-${color}`;
    swatch.dataset.color = color;
    swatch.setAttribute('aria-label', `${color.charAt(0).toUpperCase()}${color.slice(1)}`);
    swatch.addEventListener('click', () => { if (color !== note.color) queueSave(note, { color }); });
    swatches.append(swatch);
  }
  detailRow.append(dateInput, clearDate, swatches);

  tools.append(formatRow, detailRow);
  return tools;
}

function render() {
  // Rebuilding the list would take the caret away from someone typing; do it once they leave the list.
  if ($('#list').contains(document.activeElement)) { state.renderPending = true; return; }
  state.renderPending = false;
  $('#list').replaceChildren(...[...state.notes].sort(compareNotes).map(buildNote));
  applySearch();
}

// Every word must appear somewhere in the note's title, content, or deadline.
function applySearch() {
  const words = $('#search').value.toLowerCase().split(/\s+/).filter(Boolean);
  let shown = 0;
  for (const card of $('#list').children) {
    card.hidden = card.dataset.id !== state.openId && !words.every((word) => card.dataset.search.includes(word));
    if (!card.hidden) shown += 1;
  }
  show(shown ? '' : state.notes.length ? 'No notes match your search.' : 'No notes yet. Press + to add one.', $('#empty'));
}

async function createNote() {
  const button = $('#new-note');
  button.disabled = true;
  try {
    const { note } = await request('/api/notes', { method: 'POST', body: {} });
    state.notes.unshift(note);
    $('#search').value = '';
    $('#list').prepend(buildNote(note));
    setOpen(note.id, { focusTitle: true });
    persist();
  } catch (error) {
    if (error.status === 401) return signOutLocally('Your session ended. Please sign in again.');
    show(error.message);
  } finally {
    button.disabled = false;
  }
}

async function deleteNote(note) {
  try {
    await request('/api/notes', { method: 'DELETE', body: { id: note.id } });
  } catch (error) {
    if (error.status === 401) return signOutLocally('Your session ended. Please sign in again.');
    if (error.status !== 404) return show(error.message);
  }
  state.drafts.delete(note.id);
  state.dirtyEditors.delete(note.id);
  state.notes = state.notes.filter((other) => other !== note);
  if (state.openId === note.id) state.openId = null;
  cardFor(note.id)?.remove();
  applySearch();
  persist();
}

function showSignIn(message = '') {
  $('#notes-view').hidden = true;
  $('#signin').hidden = false;
  show(message, $('#signin-error'));
  $('#username').focus();
}

function showNotes(username) {
  $('#signin').hidden = true;
  $('#notes-view').hidden = false;
  $('#who').textContent = username ? `@${username}` : '';
  $('#search').focus();
}

async function signOutLocally(message) {
  state.token = null;
  state.notes = [];
  state.openId = null;
  state.drafts.clear();
  state.dirtyEditors.clear();
  $('#list').replaceChildren();
  await ext.storage.local.remove(['token', 'username', 'notes', 'drafts']);
  showSignIn(message);
}

async function refresh() {
  try {
    const { notes } = await request('/api/notes');
    mergeNotes(notes);
    render();
    show('');
    persist();
    if (state.drafts.size) flushDrafts();
  } catch (error) {
    if (error.status === 401) return signOutLocally('Your session ended. Please sign in again.');
    show(state.notes.length ? `${error.message} Showing saved notes.` : error.message);
  }
}

$('#signin').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = $('#signin-submit');
  submit.disabled = true;
  show('', $('#signin-error'));
  try {
    const { username, token } = await request('/api/auth', {
      method: 'POST',
      body: { action: 'signin', username: $('#username').value.trim(), password: $('#password').value, return_token: true },
    });
    state.token = token;
    await ext.storage.local.set({ token, username });
    $('#password').value = '';
    showNotes(username);
    await refresh();
  } catch (error) {
    show(error.message, $('#signin-error'));
  } finally {
    submit.disabled = false;
  }
});

$('#signout').addEventListener('click', async () => {
  await flushDrafts();
  // Revoke the session on the server, but sign out here even if that fails.
  await request('/api/auth', { method: 'DELETE' }).catch(() => {});
  await signOutLocally('');
});

$('#search').addEventListener('input', applySearch);
$('#new-note').addEventListener('click', createNote);
$('#open-board').addEventListener('click', () => { flushDrafts(); ext.tabs.create({ url: API_BASE }); window.close(); });
$('#list').addEventListener('focusout', (event) => {
  if (state.renderPending && !$('#list').contains(event.relatedTarget)) setTimeout(render);
});

// A popup closes as soon as it loses focus, so send whatever is left at once.
function flushOnClose() {
  if (state.unloading || !state.token) return;
  state.unloading = true;
  flushDrafts();
}
addEventListener('pagehide', flushOnClose);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushOnClose(); });

(async function initialize() {
  const saved = await ext.storage.local.get(['token', 'username', 'notes', 'drafts']);
  if (!saved.token) return showSignIn();
  state.token = saved.token;
  state.drafts = new Map(Object.entries(saved.drafts ?? {}));
  showNotes(saved.username);
  // Show the last saved notes at once, then replace them with fresh ones.
  if (saved.notes) { state.notes = saved.notes; render(); }
  else show('Loading notes…');
  refresh();
})();
