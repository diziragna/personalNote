const ext = globalThis.browser ?? globalThis.chrome;
// The Daynote deployment is the one host the manifest grants, so it is only configured there.
const API_BASE = ext.runtime.getManifest().host_permissions[0].replace(/\/\*$/, '');
const $ = (selector) => document.querySelector(selector);

const state = { token: null, notes: [], openId: null };

async function request(path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(API_BASE + path, {
      method,
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

// Same light markdown as the board: `**bold**`, `*italic*`, `\` escapes a literal `*`.
function parseInline(text) {
  const runs = [];
  let bold = false;
  let italic = false;
  let buffer = '';
  const flush = () => {
    if (buffer) runs.push({ text: buffer, bold, italic });
    buffer = '';
  };
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\\' && i + 1 < text.length) {
      buffer += text[i + 1];
      i += 1;
    } else if (text[i] !== '*') {
      buffer += text[i];
    } else {
      let count = 1;
      while (text[i + count] === '*') count += 1;
      i += count - 1;
      flush();
      for (; count >= 3; count -= 3) { bold = !bold; italic = !italic; }
      if (count === 2) bold = !bold;
      if (count === 1) italic = !italic;
    }
  }
  flush();
  return runs;
}

function contentLines(content) {
  return content.split('\n').map((raw) => {
    const task = /^- \[( |x)\](?: |$)/i.exec(raw);
    return { task: Boolean(task), checked: task?.[1].toLowerCase() === 'x', runs: parseInline(task ? raw.slice(task[0].length) : raw) };
  });
}

function buildBody(note) {
  const body = document.createElement('div');
  body.className = 'note-body';
  if (!note.content) {
    body.append(Object.assign(document.createElement('p'), { className: 'placeholder', textContent: 'No content' }));
    return body;
  }
  for (const { task, checked, runs } of contentLines(note.content)) {
    const line = document.createElement('div');
    line.className = task ? 'line task' : 'line';
    if (task) line.dataset.checked = String(checked);
    for (const run of runs) {
      let node = document.createTextNode(run.text);
      if (run.italic) { const wrapper = document.createElement('i'); wrapper.append(node); node = wrapper; }
      if (run.bold) { const wrapper = document.createElement('b'); wrapper.append(node); node = wrapper; }
      line.append(node);
    }
    if (!line.textContent) line.append(document.createElement('br'));
    body.append(line);
  }
  return body;
}

// Open notes first, soonest deadline first, then most recently edited.
function compareNotes(a, b) {
  if (a.completed !== b.completed) return a.completed ? 1 : -1;
  if (a.due_date !== b.due_date) return !a.due_date ? 1 : !b.due_date ? -1 : a.due_date < b.due_date ? -1 : 1;
  return a.updated_at < b.updated_at ? 1 : -1;
}

function buildNote(note, today) {
  const overdue = Boolean(note.due_date && !note.completed && note.due_date < today);
  const details = document.createElement('details');
  details.name = 'notes';
  details.className = `note color-${note.color}${note.completed ? ' completed' : ''}`;
  details.open = note.id === state.openId;
  // Body content is only built the first time a note is opened.
  details.addEventListener('toggle', () => {
    if (details.open) {
      state.openId = note.id;
      if (!details.querySelector('.note-body')) details.append(buildBody(note));
    } else if (state.openId === note.id) {
      state.openId = null;
    }
  });

  const summary = document.createElement('summary');
  const title = document.createElement('span');
  title.className = `note-title${note.title ? '' : ' placeholder'}`;
  title.textContent = note.title || 'Untitled';
  summary.append(title);
  if (note.due_date) {
    const deadline = document.createElement('span');
    deadline.className = `deadline-label${overdue ? ' overdue' : ''}`;
    deadline.textContent = formatDeadline(note.due_date);
    summary.append(deadline);
  }
  details.append(summary);
  if (details.open) details.append(buildBody(note));

  const plain = contentLines(note.content).map((line) => line.runs.map((run) => run.text).join('')).join(' ');
  details.dataset.search = [note.title, plain, note.due_date, note.due_date && formatDeadline(note.due_date), overdue && 'overdue']
    .filter(Boolean).join(' ').toLowerCase();
  return details;
}

function render() {
  const today = todayKey();
  $('#list').replaceChildren(...[...state.notes].sort(compareNotes).map((note) => buildNote(note, today)));
  applySearch();
}

// Every word must appear somewhere in the note's title, content, or deadline.
function applySearch() {
  const words = $('#search').value.toLowerCase().split(/\s+/).filter(Boolean);
  let shown = 0;
  for (const note of $('#list').children) {
    note.hidden = !words.every((word) => note.dataset.search.includes(word));
    if (!note.hidden) shown += 1;
  }
  show(shown ? '' : state.notes.length ? 'No notes match your search.' : 'No notes yet. Open the board to add one.', $('#empty'));
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
  $('#list').replaceChildren();
  await ext.storage.local.remove(['token', 'username', 'notes']);
  showSignIn(message);
}

async function refresh() {
  try {
    const { notes } = await request('/api/notes');
    state.notes = notes;
    render();
    show('');
    await ext.storage.local.set({ notes });
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
  // Revoke the session on the server, but sign out here even if that fails.
  await request('/api/auth', { method: 'DELETE' }).catch(() => {});
  await signOutLocally('');
});

$('#search').addEventListener('input', applySearch);
$('#open-board').addEventListener('click', () => { ext.tabs.create({ url: API_BASE }); window.close(); });

(async function initialize() {
  const saved = await ext.storage.local.get(['token', 'username', 'notes']);
  if (!saved.token) return showSignIn();
  state.token = saved.token;
  showNotes(saved.username);
  // Show the last saved notes at once, then replace them with fresh ones.
  if (saved.notes) { state.notes = saved.notes; render(); }
  else show('Loading notes…');
  refresh();
})();
