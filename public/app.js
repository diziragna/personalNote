const $ = (selector) => document.querySelector(selector);
const state = { username: null, cave: false, mode: 'signin', notes: [], editingTitleId: null, editingDeadlineNoteId: null, pendingDeleteId: null, toastTimer: null, saving: 0, reloadPending: false, lastPull: 0 };
// The desktop app (desktop/) serves this page and answers the API from its own on-device store.
const IS_DESKTOP = Boolean(window.__TAURI__);
// On the desktop every note is a window of its own, labelled "note-<id>"; the main window only holds the account.
const WINDOW_LABEL = IS_DESKTOP ? window.__TAURI__.window.getCurrentWindow().label : '';
const NOTE_WINDOW_ID = WINDOW_LABEL.startsWith('note-') ? WINDOW_LABEL.slice(5) : null;
const DESKTOP_HOME = IS_DESKTOP && !NOTE_WINDOW_ID;
document.documentElement.classList.toggle('note-window', Boolean(NOTE_WINDOW_ID));
const IS_LOCAL_PREVIEW = !IS_DESKTOP && ['localhost', '127.0.0.1'].includes(window.location.hostname);
const LOCAL_ACCOUNT_KEY = 'daynote.local.account';
const LOCAL_NOTES_KEY = 'daynote.local.notes';
const NOTE_COLORS = ['yellow', 'pink', 'blue', 'green', 'purple', 'orange'];
const NOTE_WIDTH = 248;
const NOTE_HEIGHT = 220;
const GRID_GAP = 24;

async function localPasswordHash(password, salt) {
  const bytes = new TextEncoder().encode(`${salt}:${password}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function localError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

async function localRequest(url, options = {}) {
  const method = options.method || 'GET';
  const payload = options.body ? JSON.parse(options.body) : {};
  const account = JSON.parse(localStorage.getItem(LOCAL_ACCOUNT_KEY) || 'null');
  const session = localStorage.getItem('daynote.local.session') === 'active';
  const requireSession = () => {
    if (!session || !account) localError('Please sign in to continue.', 401);
    return account;
  };
  const saveAccount = (next) => localStorage.setItem(LOCAL_ACCOUNT_KEY, JSON.stringify(next));
  const notes = () => JSON.parse(localStorage.getItem(LOCAL_NOTES_KEY) || '[]');
  const saveNotes = (next) => localStorage.setItem(LOCAL_NOTES_KEY, JSON.stringify(next));
  const comments = () => JSON.parse(localStorage.getItem('daynote.local.comments') || '[]');
  const saveComments = (next) => localStorage.setItem('daynote.local.comments', JSON.stringify(next));
  const usernameValid = (name) => /^[a-z0-9_-]{3,24}$/.test(name);
  const passwordValid = (password) => password.length >= 8 && password.length <= 128;

  if (url === '/api/auth' && method === 'GET') return { username: requireSession().username };
  if (url === '/api/auth' && method === 'POST') {
    const username = String(payload.username || '').trim().toLowerCase();
    const password = String(payload.password || '');
    if (!usernameValid(username)) localError('Use 3-24 letters, numbers, underscores, or hyphens for your username.');
    if (!passwordValid(password)) localError('Your password must be at least 8 characters.');
    if (payload.action === 'signup') {
      if (account) localError('A local account already exists in this browser. Sign in or clear this browser’s site data to start over.', 409);
      const salt = crypto.randomUUID();
      saveAccount({ username, salt, passwordHash: await localPasswordHash(password, salt) });
      localStorage.setItem('daynote.local.session', 'active');
      return { username };
    }
    if (payload.action === 'signin') {
      if (!account || account.username !== username || account.passwordHash !== await localPasswordHash(password, account.salt)) localError('Username or password is incorrect.', 401);
      localStorage.setItem('daynote.local.session', 'active');
      return { username: account.username };
    }
    localError('Unknown action.');
  }
  if (url === '/api/auth' && method === 'PATCH') {
    const current = requireSession();
    if (current.passwordHash !== await localPasswordHash(String(payload.current_password || ''), current.salt)) localError('Your current password is incorrect.', 401);
    const username = String(payload.username || '').trim().toLowerCase();
    if (!usernameValid(username)) localError('Use 3-24 letters, numbers, underscores, or hyphens for your username.');
    const next = { ...current, username };
    if (payload.new_password) {
      if (!passwordValid(payload.new_password)) localError('Your new password must be at least 8 characters.');
      next.salt = crypto.randomUUID();
      next.passwordHash = await localPasswordHash(payload.new_password, next.salt);
    }
    saveAccount(next);
    return { username };
  }
  if (url === '/api/auth' && method === 'DELETE') {
    if (payload.delete_account) {
      const current = requireSession();
      if (current.passwordHash !== await localPasswordHash(String(payload.password || ''), current.salt)) localError('Your password is incorrect.', 401);
      [LOCAL_ACCOUNT_KEY, LOCAL_NOTES_KEY, 'daynote.local.comments'].forEach((key) => localStorage.removeItem(key));
    }
    localStorage.removeItem('daynote.local.session');
    return { ok: true };
  }
  if (url === '/api/notes') {
    requireSession();
    const all = notes();
    const checkNoteFields = (fields) => {
      if (fields.title !== undefined && String(fields.title).trim().length > 120) localError('A title can be at most 120 characters.');
      if (fields.content !== undefined && String(fields.content).trim().length > 2000) localError('A note can be at most 2,000 characters.');
      if (fields.color !== undefined && !NOTE_COLORS.includes(fields.color)) localError('Choose one of the available note colors.');
      for (const key of ['pos_x', 'pos_y']) {
        if (fields[key] != null && !(Number.isInteger(fields[key]) && fields[key] >= 0 && fields[key] <= 100000)) localError('That note position is out of range.');
      }
    };
    if (method === 'GET') return { notes: all.sort((a, b) => b.created_at.localeCompare(a.created_at)) };
    if (method === 'POST') {
      const fields = { title: String(payload.title || ''), content: String(payload.content || ''), color: payload.color || 'yellow', pos_x: payload.pos_x ?? null, pos_y: payload.pos_y ?? null };
      checkNoteFields(fields);
      const now = new Date().toISOString();
      const note = { id: crypto.randomUUID(), ...fields, title: fields.title.trim(), content: fields.content.trim(), completed: false, collapsed: false, width: null, height: null, due_date: payload.due_date || null, z_index: Math.max(0, ...all.map((item) => item.z_index || 0)) + 1, created_at: now, updated_at: now };
      all.unshift(note);
      saveNotes(all);
      return { note };
    }
    const index = all.findIndex((note) => note.id === payload.id);
    if (index < 0) localError('Note not found.', 404);
    if (method === 'PATCH') {
      checkNoteFields(payload);
      if (payload.z_index !== undefined && !(Number.isInteger(payload.z_index) && payload.z_index >= 0)) localError('That note layer is out of range.');
      const sizeValid = (value, min) => value === undefined || (Number.isInteger(value) && value >= min && value <= 1200);
      if (!sizeValid(payload.width, 180) || !sizeValid(payload.height, 120)) localError('That note size is out of range.');
      for (const key of ['title', 'content']) if (payload[key] !== undefined) all[index][key] = String(payload[key]).trim();
      for (const key of ['color', 'pos_x', 'pos_y', 'z_index', 'width', 'height']) if (payload[key] !== undefined) all[index][key] = payload[key];
      for (const key of ['completed', 'collapsed']) if (payload[key] !== undefined) all[index][key] = Boolean(payload[key]);
      if (Object.hasOwn(payload, 'due_date')) all[index].due_date = payload.due_date || null;
      all[index].updated_at = new Date().toISOString();
      saveNotes(all);
      return { note: all[index] };
    }
    if (method === 'DELETE') {
      saveNotes(all.filter((note) => note.id !== payload.id));
      saveComments(comments().filter((comment) => comment.note_id !== payload.id));
      return { ok: true };
    }
  }
  if (url === '/api/comments') {
    requireSession();
    if (method === 'GET') return { comments: comments() };
    if (method === 'POST') {
      const content = String(payload.content || '').trim();
      if (!content || content.length > 2000) localError('A comment must contain 1-2,000 characters.');
      if (!notes().some((note) => note.id === payload.note_id)) localError('Note not found.', 404);
      const comment = { id: crypto.randomUUID(), note_id: payload.note_id, content, due_date: payload.due_date || null, created_at: new Date().toISOString() };
      const all = comments();
      all.push(comment);
      saveComments(all);
      return { comment };
    }
    if (method === 'PATCH') {
      const content = String(payload.content || '').trim();
      if (!content || content.length > 2000) localError('A comment must contain 1-2,000 characters.');
      const all = comments();
      const comment = all.find((item) => item.id === payload.id);
      if (!comment || !notes().some((note) => note.id === comment.note_id)) localError('Comment not found.', 404);
      comment.content = content;
      if (Object.hasOwn(payload, 'due_date')) comment.due_date = payload.due_date || null;
      saveComments(all);
      return { comment };
    }
    if (method === 'DELETE') {
      const all = comments();
      const remaining = all.filter((comment) => comment.id !== payload.id);
      if (remaining.length === all.length) localError('Comment not found.', 404);
      saveComments(remaining);
      return { ok: true };
    }
  }
  localError('Local preview does not recognize this request.', 404);
}

function showError(element, message) {
  element.textContent = message;
  element.hidden = false;
}

function clearError(element) {
  element.textContent = '';
  element.hidden = true;
}

async function desktopRequest(url, options = {}) {
  try {
    return await window.__TAURI__.core.invoke('api', { method: options.method || 'GET', path: url, body: options.body ? JSON.parse(options.body) : null });
  } catch (error) {
    throw Object.assign(new Error(error?.error || 'Something went wrong. Please try again.'), { status: error?.status });
  }
}

const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);

async function request(url, options = {}) {
  if (IS_DESKTOP) return desktopRequest(url, options);
  if (IS_LOCAL_PREVIEW) return localRequest(url, options);
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('visible');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => el.classList.remove('visible'), 2400);
}

function applyTheme(dark) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  try { localStorage.setItem('daynote.theme', dark ? 'dark' : 'light'); } catch (_) { /* Theme still works for this page. */ }
  const button = $('#theme-toggle');
  if (button) {
    button.textContent = dark ? '☼  Light mode' : '☾  Dark mode';
    button.setAttribute('aria-pressed', String(dark));
  }
}

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.auth-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.mode === mode));
  const signup = mode === 'signup';
  $('#auth-title').textContent = signup ? 'A fresh start, just for you.' : 'Good to have you back.';
  $('#auth-subtitle').textContent = signup ? 'Create an account and make this space yours.' : 'Sign in to pick up where you left off.';
  $('#auth-submit span:first-child').textContent = signup ? 'Create account' : 'Sign in';
  $('#password').autocomplete = signup ? 'new-password' : 'current-password';
  clearError($('#auth-error'));
}


function formatDeadline(value) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(`${value}T00:00:00`));
}

function dateKey(date) {
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function noteCard(id) {
  return document.querySelector(`.sticky-note[data-id="${CSS.escape(id)}"]`);
}

function closeNoteMenus() {
  document.querySelectorAll('.note-menu').forEach((menu) => { menu.hidden = true; });
  document.querySelectorAll('.more-button').forEach((button) => button.setAttribute('aria-expanded', 'false'));
}

function bringToFront(note, card) {
  const top = state.notes.reduce((max, other) => (other === note ? max : Math.max(max, other.z_index || 0)), 0);
  if (note.z_index > top) return;
  note.z_index = top + 1;
  card.style.zIndex = note.z_index;
}

// Notes from before the board existed have no position yet; lay them out in a grid without saving it.
function placeUnpositionedNotes() {
  const columns = Math.max(1, Math.floor(($('#dashboard').clientWidth - GRID_GAP) / (NOTE_WIDTH + GRID_GAP)));
  let slot = 0;
  for (const note of state.notes) {
    if (note.pos_x != null && note.pos_y != null) continue;
    note.pos_x = GRID_GAP + (slot % columns) * (NOTE_WIDTH + GRID_GAP);
    note.pos_y = GRID_GAP + Math.floor(slot / columns) * (220 + GRID_GAP);
    slot += 1;
  }
}

// Note content is stored as light markdown: "- [ ] " and "- [x] " task lines, **bold**, *italic*, and \ escapes.
// Asterisk runs toggle styles, so "***" flips both bold and italic at once.
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

function inlineMarkdown(segments) {
  let out = '';
  let bold = false;
  let italic = false;
  const toggle = (nextBold, nextItalic) => {
    const marker = `${nextBold !== bold ? '**' : ''}${nextItalic !== italic ? '*' : ''}`;
    bold = nextBold;
    italic = nextItalic;
    return marker;
  };
  for (const segment of segments) {
    if (segment.text) out += toggle(segment.bold, segment.italic) + segment.text.replace(/[\\*]/g, '\\$&');
  }
  return out + toggle(false, false);
}

function buildLine({ task = false, checked = false, runs = [] } = {}) {
  const line = document.createElement('div');
  line.className = task ? 'line task' : 'line';
  if (task) line.dataset.checked = String(checked);
  for (const run of runs) {
    let node = document.createTextNode(run.text);
    if (run.italic) { const wrapper = document.createElement('i'); wrapper.append(node); node = wrapper; }
    if (run.bold) { const wrapper = document.createElement('b'); wrapper.append(node); node = wrapper; }
    line.append(node);
  }
  if (!line.textContent) line.replaceChildren(document.createElement('br'));
  return line;
}

function contentToLines(content) {
  return content.split('\n').map((raw) => {
    const task = /^- \[( |x)\](?: |$)/i.exec(raw);
    return buildLine({ task: Boolean(task), checked: task?.[1].toLowerCase() === 'x', runs: parseInline(task ? raw.slice(task[0].length) : raw) });
  });
}

// Every direct child of the editor must be a line; wrap anything the browser left at the top level.
function normalizeEditor(editor) {
  const isLine = (node) => node.nodeType === Node.ELEMENT_NODE && node.classList.contains('line');
  if (editor.firstChild && [...editor.childNodes].every(isLine)) return;
  const selection = window.getSelection();
  const caret = selection.rangeCount && editor.contains(selection.anchorNode) && selection.anchorNode !== editor ? [selection.anchorNode, selection.anchorOffset] : null;
  let current = null;
  for (const node of [...editor.childNodes]) {
    if (node.nodeName === 'DIV') {
      node.classList.add('line');
      current = null;
      continue;
    }
    if (!current) {
      current = document.createElement('div');
      current.className = 'line';
      node.before(current);
    }
    current.append(node);
  }
  if (!editor.firstChild) editor.append(buildLine());
  if (caret) try { selection.collapse(...caret); } catch (_) { /* The caret simply stays where the browser put it. */ }
}

// Styles come from the computed font so any markup the browser produced for bold or italic is captured.
function lineSegments(line) {
  const rows = [[]];
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeName === 'BR') rows.push([]);
    else if (node.nodeType === Node.TEXT_NODE && node.data) {
      const style = getComputedStyle(node.parentElement);
      rows.at(-1).push({ text: node.data.replace(/ /g, ' '), bold: Number(style.fontWeight) >= 600, italic: style.fontStyle === 'italic' });
    }
  }
  while (rows.length > 1 && !rows.at(-1).length) rows.pop();
  return rows;
}

function serializeEditor(editor) {
  normalizeEditor(editor);
  const lines = [];
  for (const line of editor.children) {
    lineSegments(line).forEach((segments, index) => {
      const text = inlineMarkdown(segments);
      if (index === 0 && line.classList.contains('task')) lines.push(`- [${line.dataset.checked === 'true' ? 'x' : ' '}] ${text}`);
      else lines.push(text.startsWith('- [') ? `\\${text}` : text);
    });
  }
  return lines.join('\n').trim();
}

function caretLine(editor) {
  const selection = window.getSelection();
  if (!selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  let node = range.startContainer === editor ? editor.childNodes[range.startOffset] || editor.lastChild : range.startContainer;
  while (node && node.parentNode !== editor) node = node.parentNode;
  return node?.nodeType === Node.ELEMENT_NODE ? node : null;
}

function setLineTask(line, task) {
  line.classList.toggle('task', task);
  if (task) line.dataset.checked = 'false';
  else delete line.dataset.checked;
}

// Enter splits the line itself so a new line keeps the checklist style but starts unchecked,
// and Enter on an empty checklist line leaves the checklist instead.
function splitLine(editor) {
  const selection = window.getSelection();
  if (!selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const line = caretLine(editor);
  if (!line) return;
  if (line.classList.contains('task') && !line.textContent) {
    setLineTask(line, false);
    return;
  }
  const tail = document.createRange();
  tail.setStart(range.startContainer, range.startOffset);
  tail.setEnd(line, line.childNodes.length);
  const next = buildLine({ task: line.classList.contains('task') });
  next.replaceChildren(tail.extractContents());
  for (const part of [line, next]) if (!part.textContent) part.replaceChildren(document.createElement('br'));
  line.after(next);
  selection.collapse(next, 0);
}

function caretAtLineStart(line) {
  const selection = window.getSelection();
  if (!selection.isCollapsed) return false;
  const before = document.createRange();
  before.setStart(line, 0);
  before.setEnd(selection.anchorNode, selection.anchorOffset);
  return before.toString() === '';
}

function toggleChecklist(editor) {
  const selection = window.getSelection();
  if (!selection.rangeCount || !editor.contains(selection.anchorNode)) return;
  const range = selection.getRangeAt(0);
  const lines = [...editor.children].filter((line) => range.intersectsNode(line));
  const makeTask = !lines.every((line) => line.classList.contains('task'));
  lines.forEach((line) => setLineTask(line, makeTask));
}

function insertPlainText(editor, text) {
  text.replace(/\r\n?/g, '\n').split('\n').forEach((part, index) => {
    if (index) splitLine(editor);
    if (part) document.execCommand('insertText', false, part);
  });
}

// The canvas fills the board and grows to fit any note placed beyond the visible area.
function fitCanvas() {
  const canvas = $('#board-canvas');
  let right = 0;
  let bottom = 0;
  for (const card of canvas.children) {
    right = Math.max(right, card.offsetLeft + card.offsetWidth);
    bottom = Math.max(bottom, card.offsetTop + card.offsetHeight);
  }
  canvas.style.width = `${right}px`;
  canvas.style.height = `${bottom}px`;
}

function updateBoardMeta() {
  if (NOTE_WINDOW_ID) {
    fitNoteWindow();
    return;
  }
  const count = state.notes.length;
  $('#note-count').textContent = `${count} ${count === 1 ? 'note' : 'notes'}`;
  $('#empty-state').hidden = !DESKTOP_HOME && count !== 0;
  fitCanvas();
}

// A note's window is as large as its note: the saved size, or just the header while the note is collapsed.
function fitNoteWindow() {
  const note = state.notes[0];
  const card = note && noteCard(note.id);
  if (!card) return;
  invoke('note_fit', { width: note.width || NOTE_WIDTH, height: note.collapsed ? card.offsetHeight : note.height || NOTE_HEIGHT, collapsed: note.collapsed }).catch(() => {});
}

async function saveNote(note, changes, { render = true, rerenderOnError = true, message = null } = {}) {
  const keys = Object.keys(changes);
  const previous = Object.fromEntries(keys.map((key) => [key, note[key]]));
  Object.assign(note, changes);
  if (render) renderNote(note);
  state.saving += 1;
  try {
    const result = await request('/api/notes', { method: 'PATCH', body: JSON.stringify({ id: note.id, ...changes }) });
    for (const key of keys) note[key] = result.note[key];
    if (IS_DESKTOP && note.sync_state !== result.note.sync_state) {
      note.sync_state = result.note.sync_state;
      updateSyncBadge(note);
      refreshSyncStatus();
    }
    if (message) toast(message);
  } catch (error) {
    Object.assign(note, previous);
    if (rerenderOnError && state.notes.includes(note)) renderNote(note);
    toast(error.message);
  } finally {
    state.saving -= 1;
  }
}

function startTitleEdit(note) {
  state.editingTitleId = note.id;
  const input = renderNote(note).querySelector('.sticky-title-input');
  input?.focus();
  input?.select();
}

function confirmDelete(note) {
  state.pendingDeleteId = note.id;
  // A note's own window is too small for a dialog; it asks inside the note instead.
  if (NOTE_WINDOW_ID) {
    renderNote(note);
    return;
  }
  $('#delete-copy').textContent = `“${note.title || 'Untitled'}” will be removed permanently and can’t be restored.`;
  const dialog = $('#delete-dialog');
  dialog.returnValue = '';
  dialog.showModal();
}

function startDrag(event, note, card) {
  if (event.button !== 0 || !event.target.closest('.sticky-header, .sticky-footer')) return;
  if (event.target.closest('input, textarea, button, form, .note-menu, .resize-handle')) return;
  const canvas = $('#board-canvas');
  const start = { x: event.clientX, y: event.clientY, left: note.pos_x, top: note.pos_y };
  let moved = false;
  const move = (moveEvent) => {
    if (moveEvent.pointerId !== event.pointerId) return;
    const dx = moveEvent.clientX - start.x;
    const dy = moveEvent.clientY - start.y;
    if (!moved && Math.hypot(dx, dy) < 4) return;
    // In its own window the note is moved by moving the window, which the system takes over from here.
    if (NOTE_WINDOW_ID) {
      stop();
      invoke('note_drag').catch(() => {});
      return;
    }
    if (!moved) {
      moved = true;
      closeNoteMenus();
      card.classList.add('dragging');
      document.body.classList.add('is-dragging');
    }
    card.style.left = `${clamp(Math.round(start.left + dx), 0, canvas.offsetWidth - card.offsetWidth)}px`;
    card.style.top = `${clamp(Math.round(start.top + dy), 0, canvas.offsetHeight - card.offsetHeight)}px`;
  };
  const stop = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
  };
  const end = (endEvent) => {
    if (endEvent.pointerId !== event.pointerId) return;
    stop();
    card.classList.remove('dragging');
    document.body.classList.remove('is-dragging');
    if (!moved) return;
    const pos_x = parseInt(card.style.left, 10);
    const pos_y = parseInt(card.style.top, 10);
    if (pos_x === start.left && pos_y === start.top) return;
    saveNote(note, { pos_x, pos_y, z_index: note.z_index }, { render: false });
    fitCanvas();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
}

function startResize(event, note, card) {
  if (event.button !== 0) return;
  event.preventDefault();
  if (NOTE_WINDOW_ID) {
    window.__TAURI__.window.getCurrentWindow().startResizeDragging('SouthEast').catch(() => {});
    return;
  }
  const canvas = $('#board-canvas');
  const start = { x: event.clientX, y: event.clientY, width: card.offsetWidth, height: card.offsetHeight };
  card.classList.add('resizing', 'sized');
  document.body.classList.add('is-resizing');
  const move = (moveEvent) => {
    if (moveEvent.pointerId !== event.pointerId) return;
    card.style.width = `${clamp(Math.round(start.width + moveEvent.clientX - start.x), 180, Math.min(1200, canvas.offsetWidth - note.pos_x))}px`;
    card.style.height = `${clamp(Math.round(start.height + moveEvent.clientY - start.y), 120, 1200)}px`;
  };
  const end = (endEvent) => {
    if (endEvent.pointerId !== event.pointerId) return;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    card.classList.remove('resizing');
    document.body.classList.remove('is-resizing');
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    if (width === start.width && height === start.height) {
      if (!note.height) {
        card.classList.remove('sized');
        card.style.height = '';
      }
      return;
    }
    saveNote(note, { width, height }, { render: false });
    fitCanvas();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
}

function buildNoteCard(note) {
  const card = document.createElement('article');
  card.className = `sticky-note color-${note.color}${note.completed ? ' completed' : ''}${note.collapsed ? ' collapsed' : ''}`;
  card.dataset.id = note.id;
  card.style.left = `${note.pos_x}px`;
  card.style.top = `${note.pos_y}px`;
  card.style.zIndex = note.z_index;
  // Notes without a saved size keep the default width and grow with their content.
  if (note.width) card.style.width = `${note.width}px`;
  if (note.height && !note.collapsed) {
    card.style.height = `${note.height}px`;
    card.classList.add('sized');
  }
  card.setAttribute('aria-label', note.title || 'Untitled note');
  card.addEventListener('pointerdown', (event) => {
    bringToFront(note, card);
    startDrag(event, note, card);
  });
  card.addEventListener('focusin', () => bringToFront(note, card));

  const header = document.createElement('header');
  header.className = 'sticky-header';
  const checkbox = document.createElement('input');
  checkbox.className = 'note-checkbox';
  checkbox.type = 'checkbox';
  checkbox.checked = note.completed;
  checkbox.setAttribute('aria-label', note.completed ? 'Mark note active' : 'Mark note complete');
  checkbox.addEventListener('change', () => {
    const changes = { completed: checkbox.checked };
    // Completing the note ticks every checklist line in it; reopening leaves the lines as they are.
    const ticked = note.content.split('\n').map((line) => line.replace(/^- \[ \](?= |$)/, '- [x]')).join('\n');
    if (checkbox.checked && ticked !== note.content) changes.content = ticked;
    saveNote(note, changes);
  });

  let title;
  if (state.editingTitleId === note.id) {
    title = document.createElement('input');
    title.className = 'sticky-title-input';
    title.value = note.title;
    title.maxLength = 120;
    title.placeholder = 'Untitled';
    title.setAttribute('aria-label', 'Note title');
    let cancelled = false;
    title.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); title.blur(); }
      if (event.key === 'Escape') { cancelled = true; title.blur(); }
    });
    title.addEventListener('blur', () => {
      if (state.editingTitleId !== note.id) return;
      state.editingTitleId = null;
      const value = title.value.trim();
      if (cancelled || value === note.title) renderNote(note);
      else saveNote(note, { title: value });
    });
  } else {
    title = document.createElement('h3');
    title.className = `sticky-title${note.title ? '' : ' placeholder'}`;
    title.textContent = note.title || 'Untitled';
    title.title = 'Double-click to rename · drag to move';
    title.addEventListener('dblclick', () => startTitleEdit(note));
  }

  const actions = document.createElement('div');
  actions.className = 'note-actions';
  const menuButton = document.createElement('button');
  menuButton.className = 'more-button';
  menuButton.type = 'button';
  menuButton.textContent = '⋮';
  menuButton.setAttribute('aria-label', 'Note options');
  menuButton.setAttribute('aria-expanded', 'false');
  const menu = document.createElement('div');
  menu.className = 'note-menu';
  menu.hidden = true;
  const toggleMenu = () => {
    const opening = menu.hidden;
    closeNoteMenus();
    menu.hidden = !opening;
    menuButton.setAttribute('aria-expanded', String(opening));
  };
  menuButton.addEventListener('click', () => {
    if (NOTE_WINDOW_ID) openNoteWindowMenu(note).catch(toggleMenu);
    else toggleMenu();
  });
  const swatches = document.createElement('div');
  swatches.className = 'color-swatches';
  swatches.setAttribute('role', 'group');
  swatches.setAttribute('aria-label', 'Note color');
  for (const color of NOTE_COLORS) {
    const swatch = document.createElement('button');
    swatch.className = `swatch color-${color}`;
    swatch.type = 'button';
    swatch.setAttribute('aria-label', `${color.charAt(0).toUpperCase()}${color.slice(1)}`);
    swatch.setAttribute('aria-pressed', String(color === note.color));
    swatch.addEventListener('click', () => {
      closeNoteMenus();
      if (color !== note.color) saveNote(note, { color });
    });
    swatches.append(swatch);
  }
  const rename = document.createElement('button');
  rename.className = 'menu-item';
  rename.type = 'button';
  rename.textContent = 'Rename';
  rename.addEventListener('click', () => startTitleEdit(note));
  const editDeadline = document.createElement('button');
  editDeadline.className = 'menu-item';
  editDeadline.type = 'button';
  editDeadline.textContent = note.due_date ? 'Edit deadline' : 'Set deadline';
  editDeadline.addEventListener('click', () => {
    state.editingDeadlineNoteId = note.id;
    renderNote(note).querySelector('.deadline-edit-form input')?.focus();
  });
  const deleteNote = document.createElement('button');
  deleteNote.className = 'menu-item danger';
  deleteNote.type = 'button';
  deleteNote.textContent = 'Delete note';
  deleteNote.addEventListener('click', () => {
    closeNoteMenus();
    confirmDelete(note);
  });
  menu.append(swatches, rename, editDeadline);
  if (showsSync()) {
    const syncNote = document.createElement('button');
    syncNote.className = 'menu-item';
    syncNote.type = 'button';
    syncNote.textContent = 'Sync this note';
    syncNote.addEventListener('click', () => {
      closeNoteMenus();
      syncNotes([note.id]);
    });
    menu.append(syncNote);
  }
  menu.append(deleteNote);
  actions.append(menuButton, menu);
  const collapse = document.createElement('button');
  collapse.className = 'collapse-button';
  collapse.type = 'button';
  collapse.title = note.collapsed ? 'Expand note' : 'Collapse note';
  collapse.setAttribute('aria-label', collapse.title);
  collapse.setAttribute('aria-expanded', String(!note.collapsed));
  collapse.addEventListener('click', () => saveNote(note, { collapsed: !note.collapsed }));
  header.append(checkbox, title, collapse, actions);
  if (NOTE_WINDOW_ID) {
    const add = document.createElement('button');
    add.className = 'add-note-button';
    add.type = 'button';
    add.textContent = '+';
    add.title = 'New note';
    add.setAttribute('aria-label', 'New note');
    add.addEventListener('click', () => createNote());
    collapse.before(add);
  }

  const content = document.createElement('div');
  content.className = 'sticky-content';
  content.contentEditable = 'true';
  content.spellcheck = true;
  content.dataset.placeholder = 'Write something…';
  content.setAttribute('role', 'textbox');
  content.setAttribute('aria-multiline', 'true');
  content.setAttribute('aria-label', 'Note content');
  content.append(...contentToLines(note.content));
  const isEmpty = () => content.children.length <= 1 && !content.textContent && !content.querySelector('.task');
  content.classList.toggle('is-empty', isEmpty());
  const afterEdit = () => {
    normalizeEditor(content);
    content.classList.toggle('is-empty', isEmpty());
    fitCanvas();
  };
  // Keep the typed text in place if saving fails, so the next commit retries it.
  let commitTimer = null;
  const commit = () => {
    clearTimeout(commitTimer);
    const value = serializeEditor(content);
    if (value !== note.content) saveNote(note, { content: value }, { render: false, rerenderOnError: false });
  };
  content.addEventListener('focus', () => card.classList.add('editing'));
  content.addEventListener('blur', () => {
    card.classList.remove('editing');
    commit();
  });
  content.addEventListener('input', afterEdit);
  content.addEventListener('beforeinput', (event) => {
    if (event.isComposing) return;
    if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') {
      event.preventDefault();
      splitLine(content);
      afterEdit();
    } else if (event.inputType === 'deleteContentBackward') {
      const line = caretLine(content);
      if (!line?.classList.contains('task') || !caretAtLineStart(line)) return;
      event.preventDefault();
      setLineTask(line, false);
      afterEdit();
    } else if (event.inputType === 'insertFromDrop' || (event.inputType.startsWith('format') && !['formatBold', 'formatItalic'].includes(event.inputType))) {
      event.preventDefault();
    }
  });
  content.addEventListener('paste', (event) => {
    event.preventDefault();
    insertPlainText(content, event.clipboardData.getData('text/plain'));
    afterEdit();
  });
  content.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 'b' || key === 'i') {
      event.preventDefault();
      document.execCommand(key === 'b' ? 'bold' : 'italic');
    } else if (key === 'enter') {
      const line = caretLine(content);
      if (!line?.classList.contains('task')) return;
      event.preventDefault();
      line.dataset.checked = String(line.dataset.checked !== 'true');
    }
  });
  // Line checkboxes are drawn in each task line's left padding.
  const checkboxLine = (event) => {
    const line = event.target.closest?.('.line.task');
    return line && content.contains(line) && event.clientX - line.getBoundingClientRect().left < 20 ? line : null;
  };
  content.addEventListener('mousedown', (event) => { if (checkboxLine(event)) event.preventDefault(); });
  content.addEventListener('click', (event) => {
    const line = checkboxLine(event);
    if (!line) return;
    line.dataset.checked = String(line.dataset.checked !== 'true');
    // Batch quick successive ticks into one save; the API blocks bursts of requests.
    clearTimeout(commitTimer);
    commitTimer = setTimeout(commit, 700);
  });
  card.append(header, content);
  if (showsSync() && note.sync_state === 'conflict') card.append(buildConflictBar(note));
  if (NOTE_WINDOW_ID && state.pendingDeleteId === note.id) card.append(buildDeleteBar(note));

  if (state.editingDeadlineNoteId === note.id) {
    const deadlineForm = document.createElement('form');
    deadlineForm.className = 'deadline-edit-form';
    const dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.value = note.due_date || '';
    dateInput.setAttribute('aria-label', 'Note deadline');
    const saveDeadline = document.createElement('button');
    saveDeadline.type = 'submit';
    saveDeadline.textContent = 'Save';
    const cancelDeadline = document.createElement('button');
    cancelDeadline.type = 'button';
    cancelDeadline.className = 'cancel-edit';
    cancelDeadline.textContent = 'Cancel';
    cancelDeadline.addEventListener('click', () => { state.editingDeadlineNoteId = null; renderNote(note); });
    deadlineForm.append(dateInput, saveDeadline, cancelDeadline);
    deadlineForm.addEventListener('submit', (event) => {
      event.preventDefault();
      state.editingDeadlineNoteId = null;
      saveNote(note, { due_date: dateInput.value }, { message: dateInput.value ? 'Deadline updated.' : 'Deadline removed.' });
    });
    card.append(deadlineForm);
  }

  const footer = document.createElement('footer');
  footer.className = 'sticky-footer';
  const formatBar = document.createElement('div');
  formatBar.className = 'format-bar';
  for (const [name, text, hint, action] of [
    ['bold', 'B', 'Bold (Ctrl+B)', () => document.execCommand('bold')],
    ['italic', 'I', 'Italic (Ctrl+I)', () => document.execCommand('italic')],
    ['checklist', '☑', 'Checklist (Ctrl+Enter ticks a line)', () => toggleChecklist(content)],
  ]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `format-button format-${name}`;
    button.tabIndex = -1;
    button.textContent = text;
    button.title = hint;
    button.setAttribute('aria-label', hint);
    // Keep focus and the selection in the editor while formatting.
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => { action(); afterEdit(); });
    formatBar.append(button);
  }
  footer.append(formatBar);
  if (note.due_date) {
    const deadline = document.createElement('span');
    deadline.className = `deadline-label${!note.completed && note.due_date < dateKey(new Date()) ? ' overdue' : ''}`;
    deadline.textContent = `Due ${formatDeadline(note.due_date)}`;
    footer.append(deadline);
    footer.classList.add('has-deadline');
  }
  const time = document.createElement('time');
  time.className = 'sticky-time';
  time.dateTime = note.created_at;
  time.textContent = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(note.created_at));
  footer.append(time);
  if (showsSync() && note.sync_state !== 'synced') time.before(buildSyncBadge(note));
  const resize = document.createElement('span');
  resize.className = 'resize-handle';
  resize.title = 'Drag to resize';
  resize.setAttribute('aria-hidden', 'true');
  resize.addEventListener('pointerdown', (event) => startResize(event, note, card));
  card.append(footer, resize);
  return card;
}

// The note's menu as a system menu, which is not cut off by the edges of the note's small window.
async function openNoteWindowMenu(note) {
  const colors = NOTE_COLORS.map((color) => ({
    text: `${color.charAt(0).toUpperCase()}${color.slice(1)}`,
    checked: color === note.color,
    action: () => { if (color !== note.color) saveNote(note, { color }); },
  }));
  const items = [
    { text: 'Color', items: colors },
    { text: 'Rename', action: () => startTitleEdit(note) },
    { text: note.due_date ? 'Edit deadline' : 'Set deadline', action: () => {
      state.editingDeadlineNoteId = note.id;
      renderNote(note).querySelector('.deadline-edit-form input')?.focus();
    } },
  ];
  if (showsSync()) items.push({ text: 'Sync this note', action: () => syncNotes([note.id]) });
  items.push({ item: 'Separator' }, { text: 'Delete note', action: () => confirmDelete(note) });
  const menu = await window.__TAURI__.menu.Menu.new({ items });
  await menu.popup();
}

function buildDeleteBar(note) {
  const bar = document.createElement('div');
  bar.className = 'conflict-bar';
  const copy = document.createElement('p');
  copy.textContent = 'Delete this note permanently?';
  const actions = document.createElement('div');
  actions.className = 'conflict-actions';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'danger';
  remove.textContent = 'Delete';
  remove.addEventListener('click', () => {
    state.pendingDeleteId = null;
    deleteNote(note);
  });
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => {
    state.pendingDeleteId = null;
    renderNote(note);
  });
  actions.append(remove, cancel);
  bar.append(copy, actions);
  return bar;
}

function renderNote(note) {
  const card = buildNoteCard(note);
  const existing = noteCard(note.id);
  if (existing) existing.replaceWith(card);
  else $('#board-canvas').append(card);
  updateBoardMeta();
  return card;
}

function renderBoard() {
  const canvas = $('#board-canvas');
  canvas.replaceChildren(...state.notes.map(buildNoteCard));
  updateBoardMeta();
}

// Desktop sync: notes are saved on the device first and only reach the cloud when the user syncs them.
const SYNC_LABELS = {
  local: ['Not synced', 'Only on this device. Sync it to save it to your account.'],
  changed: ['Changed', 'Changed on this device since the last sync.'],
  conflict: ['Conflict', 'Changed on this device and in the cloud.'],
};

function showsSync() {
  return IS_DESKTOP && !state.cave && Boolean(state.username);
}

function buildSyncBadge(note) {
  const [label, hint] = SYNC_LABELS[note.sync_state] || ['', ''];
  const badge = document.createElement('span');
  badge.className = `sync-badge sync-${note.sync_state}`;
  badge.textContent = label;
  badge.title = hint;
  return badge;
}

function updateSyncBadge(note) {
  const card = noteCard(note.id);
  if (!card) return;
  card.querySelector('.sync-badge')?.remove();
  if (showsSync() && note.sync_state !== 'synced') card.querySelector('.sticky-time')?.before(buildSyncBadge(note));
}

function buildConflictBar(note) {
  const deleted = note.conflict === 'deleted';
  const bar = document.createElement('div');
  bar.className = 'conflict-bar';
  const copy = document.createElement('p');
  copy.textContent = deleted ? 'Deleted in the cloud since your last sync.' : 'Also changed in the cloud since your last sync.';
  const actions = document.createElement('div');
  actions.className = 'conflict-actions';
  const choices = deleted ? [['device', 'Keep it'], ['cloud', 'Delete it']] : [['device', 'Keep this device'], ['cloud', 'Keep cloud'], ['both', 'Keep both']];
  for (const [keep, label] of choices) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', () => resolveConflict(note.id, keep));
    actions.append(button);
  }
  bar.append(copy, actions);
  return bar;
}

async function refreshSyncStatus() {
  if (!showsSync()) return;
  try {
    const { online, pending, conflicts } = await request('/api/desktop/status');
    const parts = [online === false && 'Offline', conflicts && `${conflicts} to resolve`, pending && `${pending} to sync`].filter(Boolean);
    $('#sync-status').textContent = parts.join(' · ') || 'All synced';
    $('#sync-status').classList.toggle('offline', online === false);
  } catch (_) { /* The status line keeps its last value. */ }
}

function syncSummary({ synced, conflicts, errors }) {
  if (errors.length) return errors[0];
  if (conflicts) return conflicts === 1 ? 'A note changed in both places. Choose which version to keep.' : `${conflicts} notes changed in both places. Choose which versions to keep.`;
  return synced ? 'Synced.' : 'Everything is up to date.';
}

// Let edits that are still being saved land before syncing or reloading the board.
async function whenSaved() {
  while (state.saving) await new Promise((resolve) => setTimeout(resolve, 50));
}

async function syncNotes(ids = null) {
  const button = $('#sync-all');
  button.disabled = true;
  button.textContent = 'Syncing…';
  try {
    await whenSaved();
    const result = await request('/api/desktop/sync', { method: 'POST', body: JSON.stringify({ ids }) });
    setNotes(result.notes);
    toast(syncSummary(result));
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Sync all';
    refreshSyncStatus();
  }
}

async function resolveConflict(id, keep) {
  try {
    const result = await request('/api/desktop/resolve', { method: 'POST', body: JSON.stringify({ id, keep }) });
    setNotes(result.notes);
    if (keep === 'device') toast(syncSummary(result));
  } catch (error) {
    // Keeping this device's version is saved even when sending it fails, for example offline.
    toast(error.message);
    await loadNotes();
  }
}

const isTyping = () => Boolean(document.activeElement?.closest?.('.sticky-content, .sticky-title-input, .deadline-edit-form'));

// Rebuilding the board would interrupt typing, so cloud changes appear once the user stops editing.
async function reloadWhenIdle() {
  if (!state.reloadPending) return;
  if (isTyping() || state.saving) {
    setTimeout(reloadWhenIdle, 500);
    return;
  }
  state.reloadPending = false;
  try { await loadNotes(); } catch (_) { /* Signed out meanwhile; the app closes or resets this window. */ }
}

// While online, cloud changes come down on their own, at most once a minute; nothing goes up until the user syncs.
async function pullFromCloud() {
  if (!showsSync()) return;
  // Every note window asks; the time of the last pull is shared between them so only one goes through.
  try { state.lastPull = Math.max(state.lastPull, Number(localStorage.getItem('daynote.lastPull')) || 0); } catch (_) { /* This window keeps its own count. */ }
  if (Date.now() - state.lastPull < 60000) return;
  state.lastPull = Date.now();
  try { localStorage.setItem('daynote.lastPull', String(state.lastPull)); } catch (_) { /* As above. */ }
  try {
    const result = await request('/api/desktop/pull', { method: 'POST' });
    if (result.changed) {
      state.reloadPending = true;
      reloadWhenIdle();
    }
  } catch (_) { /* Pulling is best effort; the status line shows when the app is offline. */ }
  refreshSyncStatus();
}

async function createNote(position) {
  if (IS_DESKTOP) {
    // The app opens a window for the new note, next to this one when it was made from a note.
    const current = NOTE_WINDOW_ID ? state.notes[0] : null;
    const index = current ? NOTE_COLORS.indexOf(current.color) + 1 : state.notes.length;
    try {
      await request('/api/notes', { method: 'POST', body: JSON.stringify({ title: '', content: '', color: NOTE_COLORS[index % NOTE_COLORS.length] }) });
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  const board = $('#dashboard');
  const cascade = (state.notes.length % 8) * 28;
  const x = position ? position.x : board.scrollLeft + 40 + cascade;
  const y = position ? position.y : board.scrollTop + 32 + cascade;
  const button = $('#new-note');
  button.disabled = true;
  try {
    const data = await request('/api/notes', { method: 'POST', body: JSON.stringify({
      title: '', content: '', color: NOTE_COLORS[state.notes.length % NOTE_COLORS.length],
      pos_x: clamp(Math.round(x), 0, board.scrollLeft + board.clientWidth - NOTE_WIDTH),
      pos_y: clamp(Math.round(y), 0, 100000),
    }) });
    state.notes.unshift(data.note);
    startTitleEdit(data.note);
    refreshSyncStatus();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

function displayDashboard({ username, cave = false }) {
  state.username = username;
  state.cave = cave;
  $('#auth-view').hidden = true;
  $('#dashboard').hidden = false;
  $('#signed-in-nav').hidden = false;
  $('#nav-signin').hidden = true;
  $('#nav-username').textContent = cave ? 'In cave' : username;
  $('#avatar').textContent = cave ? '⛰' : username.charAt(0).toUpperCase();
  // The cave has no account to manage, only a way out.
  $('#cave-exit-button').hidden = !cave;
  $('#settings-button').hidden = cave;
  $('#signout-button').hidden = cave;
  $('#sync-controls').hidden = !showsSync();
}

function showAuthView(mode = 'signin') {
  state.username = null;
  state.notes = [];
  state.editingTitleId = null;
  state.editingDeadlineNoteId = null;
  $('#board-canvas').replaceChildren();
  $('#signed-in-nav').hidden = true;
  $('#nav-signin').hidden = false;
  $('#dashboard').hidden = true;
  $('#auth-view').hidden = false;
  $('#password').value = '';
  // Leaving the cave: notes made there join whichever account the user signs in to.
  $('#cave-hint').hidden = !state.cave;
  setMode(mode);
}

function setNotes(notes) {
  if (NOTE_WINDOW_ID) notes = notes.filter((note) => note.id === NOTE_WINDOW_ID);
  state.notes = notes.map((note) => ({ title: '', color: 'yellow', pos_x: null, pos_y: null, z_index: 0, collapsed: false, width: null, height: null, ...note }));
  // The desktop's main window only counts the notes; each one is drawn in its own window.
  if (DESKTOP_HOME) {
    updateBoardMeta();
  } else {
    placeUnpositionedNotes();
    renderBoard();
  }
  refreshSyncStatus();
}

async function loadNotes() {
  setNotes((await request('/api/notes')).notes);
}

document.querySelectorAll('.auth-tab').forEach((tab) => tab.addEventListener('click', () => setMode(tab.dataset.mode)));

$('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#auth-submit');
  const error = $('#auth-error');
  clearError(error);
  button.disabled = true;
  try {
    const data = await request('/api/auth', { method: 'POST', body: JSON.stringify({ action: state.mode, username: $('#username').value.trim(), password: $('#password').value }) });
    displayDashboard(data);
    await loadNotes();
    pullFromCloud();
  } catch (err) {
    showError(error, err.message);
  } finally {
    button.disabled = false;
  }
});

$('#new-note').addEventListener('click', () => createNote());
$('#board-canvas').addEventListener('dblclick', (event) => {
  if (event.target !== event.currentTarget || IS_DESKTOP) return;
  const rect = event.currentTarget.getBoundingClientRect();
  createNote({ x: event.clientX - rect.left - 24, y: event.clientY - rect.top - 18 });
});

$('#delete-dialog').addEventListener('click', (event) => { if (event.target === $('#delete-dialog')) $('#delete-dialog').close(); });
$('#delete-dialog').addEventListener('close', async () => {
  const note = state.notes.find((item) => item.id === state.pendingDeleteId);
  state.pendingDeleteId = null;
  if ($('#delete-dialog').returnValue === 'delete' && note) deleteNote(note);
});

async function deleteNote(note) {
  try {
    await request('/api/notes', { method: 'DELETE', body: JSON.stringify({ id: note.id }) });
    state.notes = state.notes.filter((item) => item.id !== note.id);
    noteCard(note.id)?.remove();
    updateBoardMeta();
    toast('Note deleted.');
    refreshSyncStatus();
  } catch (error) {
    toast(error.message);
  }
}

$('#account-button').addEventListener('click', () => { $('#account-menu').hidden = !$('#account-menu').hidden; });
$('#theme-toggle').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme !== 'dark'));
document.addEventListener('click', (event) => {
  if (!event.target.closest('.signed-in-nav')) $('#account-menu').hidden = true;
  if (!event.target.closest('.note-actions')) closeNoteMenus();
});

$('#signout-button').addEventListener('click', async () => {
  try { await request('/api/auth', { method: 'DELETE' }); } catch (_) { /* The local view still needs to clear. */ }
  state.cave = false;
  showAuthView();
});

$('#cave-button').addEventListener('click', async () => {
  try {
    displayDashboard(await request('/api/desktop/cave', { method: 'POST' }));
    await loadNotes();
  } catch (error) {
    showError($('#auth-error'), error.message);
  }
});
$('#cave-exit-button').addEventListener('click', () => {
  $('#account-menu').hidden = true;
  showAuthView('signup');
});
$('#sync-all').addEventListener('click', () => syncNotes());

$('#delete-account-button').addEventListener('click', () => {
  $('#settings-dialog').close();
  $('#delete-account-password').value = '';
  clearError($('#delete-account-error'));
  $('#delete-account-dialog').showModal();
});
$('#cancel-delete-account').addEventListener('click', () => $('#delete-account-dialog').close());
$('#delete-account-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#confirm-delete-account');
  button.disabled = true;
  try {
    await request('/api/auth', { method: 'DELETE', body: JSON.stringify({ delete_account: true, password: $('#delete-account-password').value }) });
    $('#delete-account-dialog').close();
    state.cave = false;
    showAuthView();
    toast(IS_DESKTOP ? 'Account deleted. Its notes are still on this device, in the cave.' : 'Your account was deleted.');
  } catch (error) {
    showError($('#delete-account-error'), error.message);
  } finally {
    button.disabled = false;
  }
});

$('#settings-button').addEventListener('click', () => {
  $('#account-menu').hidden = true;
  $('#settings-username').value = state.username;
  $('#current-password').value = '';
  $('#new-password').value = '';
  clearError($('#settings-error'));
  $('#settings-dialog').showModal();
});
$('#close-settings').addEventListener('click', () => $('#settings-dialog').close());
$('#settings-dialog').addEventListener('click', (event) => { if (event.target === $('#settings-dialog')) $('#settings-dialog').close(); });

$('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#save-settings');
  const error = $('#settings-error');
  clearError(error);
  button.disabled = true;
  const payload = {
    username: $('#settings-username').value.trim(),
    current_password: $('#current-password').value,
    new_password: $('#new-password').value || null,
  };
  try {
    const data = await request('/api/auth', { method: 'PATCH', body: JSON.stringify(payload) });
    displayDashboard(data);
    $('#settings-dialog').close();
    toast('Account updated.');
  } catch (err) {
    showError(error, err.message);
  } finally {
    button.disabled = false;
  }
});

// Moving or resizing a note's window is how the note is moved and resized; save both once the gesture settles.
function watchNoteWindow() {
  let placeTimer = null;
  let sizeTimer = null;
  window.__TAURI__.window.getCurrentWindow().onMoved(() => {
    clearTimeout(placeTimer);
    placeTimer = setTimeout(() => invoke('note_place').catch(() => {}), 300);
  });
  window.addEventListener('resize', () => {
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(() => {
      const note = state.notes[0];
      if (!note) return;
      const width = clamp(window.innerWidth, 180, 1200);
      const height = clamp(window.innerHeight, 120, 1200);
      const changes = {};
      // A pixel or two of difference is the system rounding the size the note asked for, not the user resizing.
      if (Math.abs(width - (note.width || NOTE_WIDTH)) > 2) changes.width = width;
      if (!note.collapsed && Math.abs(height - (note.height || NOTE_HEIGHT)) > 2) changes.height = height;
      if (Object.keys(changes).length) saveNote(note, changes, { render: false });
    }, 400);
  });
}

(async function initialize() {
  applyTheme(document.documentElement.dataset.theme === 'dark');
  $('#local-badge').hidden = !IS_LOCAL_PREVIEW;
  $('#cave-entry').hidden = !IS_DESKTOP;
  $('#delete-account-copy').textContent = IS_DESKTOP
    ? 'Your account and every note saved in the cloud will be deleted permanently. Notes on this device stay here, in the cave.'
    : 'Your account and all of its notes will be deleted permanently. This can’t be undone.';
  $('#preview-date').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date()).toUpperCase();
  if (IS_DESKTOP) {
    window.addEventListener('focus', pullFromCloud);
    setInterval(pullFromCloud, 5 * 60000);
    // Another window added, removed, synced, or edited notes, or the session changed.
    window.__TAURI__.event.listen('notes-changed', () => {
      state.reloadPending = true;
      reloadWhenIdle();
    });
    window.addEventListener('storage', (event) => { if (event.key === 'daynote.theme') applyTheme(event.newValue === 'dark'); });
  }
  if (DESKTOP_HOME) {
    $('#empty-state h3').textContent = 'Your notes live on your desktop.';
    $('#empty-state p').textContent = 'Press New note to stick one anywhere on your screen. You can close this window; Daynote stays in the tray.';
  }
  if (NOTE_WINDOW_ID) watchNoteWindow();
  try {
    const data = await request('/api/auth');
    displayDashboard(data);
    await loadNotes();
    pullFromCloud();
    // A note that was just made is ready to type into.
    const note = NOTE_WINDOW_ID && state.notes[0];
    if (note && !note.title && !note.content && Date.now() - new Date(note.created_at) < 15000) noteCard(note.id)?.querySelector('.sticky-content').focus();
  } catch (_) {
    // A visitor without a session starts at the sign-in screen.
  }
})();
