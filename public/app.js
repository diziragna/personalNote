const $ = (selector) => document.querySelector(selector);
const state = { username: null, mode: 'signin', notes: [], comments: [], activeCommentNoteId: null, editingCommentId: null, editingDeadlineNoteId: null, collapsedDays: new Set(), collapsedComments: new Set(), toastTimer: null };
const IS_LOCAL_PREVIEW = ['localhost', '127.0.0.1'].includes(window.location.hostname);
const LOCAL_ACCOUNT_KEY = 'daynote.local.account';
const LOCAL_NOTES_KEY = 'daynote.local.notes';

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
    localStorage.removeItem('daynote.local.session');
    return { ok: true };
  }
  if (url === '/api/notes') {
    requireSession();
    const all = notes();
    if (method === 'GET') return { notes: all.sort((a, b) => b.created_at.localeCompare(a.created_at)) };
    if (method === 'POST') {
      const content = String(payload.content || '').trim();
      if (!content || content.length > 2000) localError('A note must contain 1-2,000 characters.');
      const note = { id: crypto.randomUUID(), content, completed: false, due_date: payload.due_date || null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      all.unshift(note);
      saveNotes(all);
      return { note };
    }
    const index = all.findIndex((note) => note.id === payload.id);
    if (index < 0) localError('Note not found.', 404);
    if (method === 'PATCH') {
      if (payload.content !== undefined) {
        const content = String(payload.content).trim();
        if (!content || content.length > 2000) localError('A note must contain 1-2,000 characters.');
        all[index].content = content;
      }
      if (payload.completed !== undefined) all[index].completed = Boolean(payload.completed);
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

async function request(url, options = {}) {
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

function formatDate(date) {
  return new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(date);
}

function formatDeadline(value) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(`${value}T00:00:00`));
}

function dateKey(date) {
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function groupLabel(date) {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (dateKey(date) === dateKey(today)) return 'Today';
  if (dateKey(date) === dateKey(yesterday)) return 'Yesterday';
  return new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(date);
}

function renderNotes() {
  const list = $('#notes-list');
  list.replaceChildren();
  const groups = new Map();
  for (const note of state.notes) {
    const date = new Date(note.created_at);
    const key = dateKey(date);
    if (!groups.has(key)) groups.set(key, { date, notes: [] });
    groups.get(key).notes.push(note);
  }

  let total = 0;
  for (const { date, notes } of groups.values()) {
    const group = document.createElement('section');
    group.className = 'day-group';
    const key = dateKey(date);
    const collapsed = state.collapsedDays.has(key);
    group.classList.toggle('is-collapsed', collapsed);
    const heading = document.createElement('button');
    heading.className = 'day-heading';
    heading.type = 'button';
    heading.setAttribute('aria-expanded', String(!collapsed));
    heading.setAttribute('aria-controls', `day-body-${key}`);
    heading.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} ${groupLabel(date)} notes`);
    heading.addEventListener('click', () => {
      if (state.collapsedDays.has(key)) state.collapsedDays.delete(key);
      else state.collapsedDays.add(key);
      renderNotes();
    });
    const label = document.createElement('strong');
    label.textContent = groupLabel(date);
    const count = document.createElement('span');
    count.className = 'day-count';
    count.textContent = `${notes.length} ${notes.length === 1 ? 'note' : 'notes'}`;
    const chevron = document.createElement('span');
    chevron.className = 'day-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '⌄';
    heading.append(label, count);
    heading.append(chevron);
    const dayBody = document.createElement('div');
    dayBody.className = 'day-body';
    dayBody.id = `day-body-${key}`;
    dayBody.hidden = collapsed;
    group.append(heading, dayBody);

    for (const note of notes) {
      total += 1;
      const row = document.createElement('div');
      row.className = `note-row${note.completed ? ' completed' : ''}`;
      const checkbox = document.createElement('input');
      checkbox.className = 'note-checkbox';
      checkbox.type = 'checkbox';
      checkbox.id = `note-${note.id}`;
      checkbox.checked = note.completed;
      checkbox.setAttribute('aria-label', note.completed ? 'Mark note active' : 'Mark note complete');
      checkbox.addEventListener('change', async () => {
        checkbox.disabled = true;
        try {
          const result = await request('/api/notes', { method: 'PATCH', body: JSON.stringify({ id: note.id, completed: checkbox.checked }) });
          Object.assign(note, result.note);
          renderNotes();
        } catch (error) {
          checkbox.checked = note.completed;
          toast(error.message);
          checkbox.disabled = false;
        }
      });
      const main = document.createElement('div');
      main.className = 'note-main';
      const text = document.createElement('label');
      text.className = 'note-text';
      text.htmlFor = checkbox.id;
      text.textContent = note.content;
      main.append(text);
      if (note.due_date) {
        const deadline = document.createElement('span');
        deadline.className = 'deadline-label';
        deadline.textContent = `Due ${formatDeadline(note.due_date)}`;
        main.append(deadline);
      }
      const time = document.createElement('time');
      time.className = 'note-time';
      time.dateTime = note.created_at;
      time.textContent = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(note.created_at));
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
      menuButton.addEventListener('click', () => {
        const opening = menu.hidden;
        document.querySelectorAll('.note-menu').forEach((other) => { other.hidden = true; });
        document.querySelectorAll('.more-button').forEach((other) => other.setAttribute('aria-expanded', 'false'));
        menu.hidden = !opening;
        menuButton.setAttribute('aria-expanded', String(opening));
      });
      const editDeadline = document.createElement('button');
      editDeadline.className = 'menu-item';
      editDeadline.type = 'button';
      editDeadline.textContent = note.due_date ? 'Edit deadline' : 'Set deadline';
      editDeadline.addEventListener('click', () => {
        menu.hidden = true;
        menuButton.setAttribute('aria-expanded', 'false');
        state.editingDeadlineNoteId = state.editingDeadlineNoteId === note.id ? null : note.id;
        renderNotes();
        document.querySelector(`#note-deadline-${CSS.escape(note.id)}`)?.focus();
      });
      const addComment = document.createElement('button');
      addComment.className = 'menu-item';
      addComment.type = 'button';
      addComment.textContent = 'Add comment';
      addComment.addEventListener('click', () => {
        menu.hidden = true;
        menuButton.setAttribute('aria-expanded', 'false');
        state.collapsedComments.delete(note.id);
        state.activeCommentNoteId = state.activeCommentNoteId === note.id ? null : note.id;
        renderNotes();
        if (state.activeCommentNoteId) document.querySelector(`#comment-input-${CSS.escape(note.id)}`)?.focus();
      });
      const deleteNote = document.createElement('button');
      deleteNote.className = 'menu-item danger';
      deleteNote.type = 'button';
      deleteNote.textContent = 'Delete note';
      deleteNote.addEventListener('click', async () => {
        deleteNote.disabled = true;
        try {
          await request('/api/notes', { method: 'DELETE', body: JSON.stringify({ id: note.id }) });
          state.notes = state.notes.filter((item) => item.id !== note.id);
          state.comments = state.comments.filter((comment) => comment.note_id !== note.id);
          state.collapsedComments.delete(note.id);
          renderNotes();
          toast('Note deleted.');
        } catch (error) {
          toast(error.message);
          deleteNote.disabled = false;
        }
      });
      menu.append(editDeadline, addComment, deleteNote);
      actions.append(menuButton, menu);
      row.append(checkbox, main, time, actions);
      dayBody.append(row);

      if (state.editingDeadlineNoteId === note.id) {
        const deadlineForm = document.createElement('form');
        deadlineForm.className = 'deadline-edit-form';
        const dateInput = document.createElement('input');
        dateInput.id = `note-deadline-${note.id}`;
        dateInput.type = 'date';
        dateInput.value = note.due_date || '';
        dateInput.setAttribute('aria-label', 'Note deadline');
        const saveDeadline = document.createElement('button');
        saveDeadline.type = 'submit';
        saveDeadline.textContent = 'Save deadline';
        const cancelDeadline = document.createElement('button');
        cancelDeadline.type = 'button';
        cancelDeadline.className = 'cancel-edit';
        cancelDeadline.textContent = 'Cancel';
        cancelDeadline.addEventListener('click', () => { state.editingDeadlineNoteId = null; renderNotes(); });
        deadlineForm.append(dateInput, saveDeadline, cancelDeadline);
        deadlineForm.addEventListener('submit', async (event) => {
          event.preventDefault();
          saveDeadline.disabled = true;
          try {
            const result = await request('/api/notes', { method: 'PATCH', body: JSON.stringify({ id: note.id, due_date: dateInput.value }) });
            Object.assign(note, result.note);
            state.editingDeadlineNoteId = null;
            renderNotes();
            toast(dateInput.value ? 'Deadline updated.' : 'Deadline removed.');
          } catch (error) {
            toast(error.message);
            saveDeadline.disabled = false;
          }
        });
        dayBody.append(deadlineForm);
      }

      const noteComments = state.comments.filter((comment) => comment.note_id === note.id);
      if (noteComments.length || state.activeCommentNoteId === note.id) {
        const commentsCollapsed = state.collapsedComments.has(note.id);
        if (noteComments.length) {
          const toggleRow = document.createElement('div');
          toggleRow.className = 'comment-toggle-row';
          const toggle = document.createElement('button');
          toggle.className = 'comment-toggle';
          toggle.type = 'button';
          toggle.textContent = `${commentsCollapsed ? 'Show' : 'Hide'} comments (${noteComments.length})`;
          toggle.setAttribute('aria-expanded', String(!commentsCollapsed));
          toggle.setAttribute('aria-controls', `comment-panel-${note.id}`);
          toggle.addEventListener('click', () => {
            if (state.collapsedComments.has(note.id)) state.collapsedComments.delete(note.id);
            else state.collapsedComments.add(note.id);
            renderNotes();
          });
          toggleRow.append(toggle);
          dayBody.append(toggleRow);
        }
        const panel = document.createElement('div');
        panel.className = 'comment-panel';
        panel.id = `comment-panel-${note.id}`;
        panel.hidden = commentsCollapsed;
        for (const comment of noteComments) {
          const commentRow = document.createElement('div');
          commentRow.className = 'comment-entry';
          const dot = document.createElement('span');
          dot.className = 'comment-dot';
          dot.textContent = '↳';
          const content = document.createElement('span');
          content.className = 'comment-content';
          content.textContent = comment.content;
          const commentTime = document.createElement('time');
          commentTime.className = 'comment-time';
          commentTime.dateTime = comment.created_at;
          commentTime.textContent = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(comment.created_at));
          let deadlineLabel = null;
          if (comment.due_date) {
            deadlineLabel = document.createElement('span');
            deadlineLabel.className = 'deadline-label comment-deadline';
            deadlineLabel.textContent = `Due ${formatDeadline(comment.due_date)}`;
          }
          const commentActions = document.createElement('div');
          commentActions.className = 'comment-actions';
          const commentMenuButton = document.createElement('button');
          commentMenuButton.className = 'comment-more-button';
          commentMenuButton.type = 'button';
          commentMenuButton.textContent = '⋮';
          commentMenuButton.setAttribute('aria-label', 'Comment options');
          const commentMenu = document.createElement('div');
          commentMenu.className = 'comment-menu';
          commentMenu.hidden = true;
          commentMenuButton.addEventListener('click', () => {
            const opening = commentMenu.hidden;
            document.querySelectorAll('.comment-menu').forEach((other) => { other.hidden = true; });
            commentMenu.hidden = !opening;
            commentMenuButton.setAttribute('aria-expanded', String(opening));
          });
          const editComment = document.createElement('button');
          editComment.className = 'menu-item';
          editComment.type = 'button';
          editComment.textContent = 'Edit comment';
          editComment.addEventListener('click', () => {
            state.editingCommentId = comment.id;
            renderNotes();
            document.querySelector(`#comment-edit-${CSS.escape(comment.id)}`)?.focus();
          });
          const deleteComment = document.createElement('button');
          deleteComment.className = 'menu-item danger';
          deleteComment.type = 'button';
          deleteComment.textContent = 'Delete comment';
          deleteComment.addEventListener('click', async () => {
            deleteComment.disabled = true;
            try {
              await request('/api/comments', { method: 'DELETE', body: JSON.stringify({ id: comment.id }) });
              state.comments = state.comments.filter((item) => item.id !== comment.id);
              renderNotes();
              toast('Comment deleted.');
            } catch (error) {
              toast(error.message);
              deleteComment.disabled = false;
            }
          });
          commentMenu.append(editComment, deleteComment);
          commentActions.append(commentMenuButton, commentMenu);
          if (state.editingCommentId === comment.id) {
            const editForm = document.createElement('form');
            editForm.className = 'comment-edit-form';
            const editInput = document.createElement('input');
            editInput.id = `comment-edit-${comment.id}`;
            editInput.value = comment.content;
            editInput.maxLength = 2000;
            editInput.setAttribute('aria-label', 'Edit comment');
            editInput.required = true;
            const editDueDate = document.createElement('input');
            editDueDate.type = 'date';
            editDueDate.value = comment.due_date || '';
            editDueDate.setAttribute('aria-label', 'Comment deadline');
            const saveEdit = document.createElement('button');
            saveEdit.type = 'submit';
            saveEdit.textContent = 'Save';
            const cancelEdit = document.createElement('button');
            cancelEdit.type = 'button';
            cancelEdit.className = 'cancel-edit';
            cancelEdit.textContent = 'Cancel';
            cancelEdit.addEventListener('click', () => { state.editingCommentId = null; renderNotes(); });
            editForm.append(editInput, editDueDate, saveEdit, cancelEdit);
            editForm.addEventListener('submit', async (event) => {
              event.preventDefault();
              saveEdit.disabled = true;
              try {
                const result = await request('/api/comments', { method: 'PATCH', body: JSON.stringify({ id: comment.id, content: editInput.value.trim(), due_date: editDueDate.value }) });
                Object.assign(comment, result.comment);
                state.editingCommentId = null;
                renderNotes();
                toast('Comment updated.');
              } catch (error) {
                toast(error.message);
                saveEdit.disabled = false;
              }
            });
            commentRow.append(dot, editForm, commentTime, commentActions);
          } else {
            commentRow.append(dot, content);
            if (deadlineLabel) commentRow.append(deadlineLabel);
            commentRow.append(commentTime, commentActions);
          }
          panel.append(commentRow);
        }
        if (state.activeCommentNoteId === note.id) {
          const form = document.createElement('form');
          form.className = 'comment-form';
          const input = document.createElement('input');
          input.id = `comment-input-${note.id}`;
          input.name = 'content';
          input.maxLength = 2000;
          input.placeholder = 'Write a comment…';
          input.setAttribute('aria-label', 'Write a comment');
          input.required = true;
          const dueDate = document.createElement('input');
          dueDate.type = 'date';
          dueDate.setAttribute('aria-label', 'Optional comment deadline');
          const submit = document.createElement('button');
          submit.type = 'submit';
          submit.textContent = 'Comment';
          form.append(input, dueDate, submit);
          form.addEventListener('submit', async (event) => {
            event.preventDefault();
            submit.disabled = true;
            try {
              const result = await request('/api/comments', { method: 'POST', body: JSON.stringify({ note_id: note.id, content: input.value.trim(), due_date: dueDate.value || null }) });
              state.comments.push(result.comment);
              renderNotes();
              document.querySelector(`#comment-input-${CSS.escape(note.id)}`)?.focus();
              toast('Comment added.');
            } catch (error) {
              toast(error.message);
              submit.disabled = false;
            }
          });
          panel.append(form);
        }
        dayBody.append(panel);
      }
    }
    list.append(group);
  }
  $('#note-count').innerHTML = `YOUR NOTES <b>${total}</b>`;
  $('#empty-state').hidden = total !== 0;
}

function displayDashboard(username) {
  state.username = username;
  $('#auth-view').hidden = true;
  $('#dashboard').hidden = false;
  $('#signed-in-nav').hidden = false;
  $('#nav-signin').hidden = true;
  $('#nav-username').textContent = username;
  $('#avatar').textContent = username.charAt(0).toUpperCase();
  $('#greeting').textContent = `Hello, ${username}.`;
  $('#today-label').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date()).toUpperCase();
}

async function loadNotes() {
  const [result, commentResult] = await Promise.all([request('/api/notes'), request('/api/comments')]);
  state.notes = result.notes;
  state.comments = commentResult.comments;
  renderNotes();
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
    displayDashboard(data.username);
    await loadNotes();
  } catch (err) {
    showError(error, err.message);
  } finally {
    button.disabled = false;
  }
});

$('#note-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('#note-content');
  const dueDate = $('#note-due-date');
  const button = $('#add-note');
  const content = input.value.trim();
  if (!content) return;
  button.disabled = true;
  try {
    const data = await request('/api/notes', { method: 'POST', body: JSON.stringify({ content, due_date: dueDate.value || null }) });
    state.notes.unshift(data.note);
    renderNotes();
    input.value = '';
    dueDate.value = '';
    input.focus();
    toast('Note added.');
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
});

$('#account-button').addEventListener('click', () => { $('#account-menu').hidden = !$('#account-menu').hidden; });
$('#theme-toggle').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme !== 'dark'));
document.addEventListener('click', (event) => {
  if (!event.target.closest('.signed-in-nav')) $('#account-menu').hidden = true;
  if (!event.target.closest('.note-actions')) {
    document.querySelectorAll('.note-menu').forEach((menu) => { menu.hidden = true; });
    document.querySelectorAll('.more-button').forEach((button) => button.setAttribute('aria-expanded', 'false'));
  }
  if (!event.target.closest('.comment-actions')) {
    document.querySelectorAll('.comment-menu').forEach((menu) => { menu.hidden = true; });
    document.querySelectorAll('.comment-more-button').forEach((button) => button.setAttribute('aria-expanded', 'false'));
  }
});

$('#signout-button').addEventListener('click', async () => {
  try { await request('/api/auth', { method: 'DELETE' }); } catch (_) { /* The local view still needs to clear. */ }
  state.username = null;
  state.notes = [];
  state.comments = [];
  state.activeCommentNoteId = null;
  state.editingCommentId = null;
  state.editingDeadlineNoteId = null;
  state.collapsedComments.clear();
  $('#signed-in-nav').hidden = true;
  $('#nav-signin').hidden = false;
  $('#dashboard').hidden = true;
  $('#auth-view').hidden = false;
  $('#password').value = '';
  setMode('signin');
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
    displayDashboard(data.username);
    $('#settings-dialog').close();
    toast('Account updated.');
  } catch (err) {
    showError(error, err.message);
  } finally {
    button.disabled = false;
  }
});

(async function initialize() {
  applyTheme(document.documentElement.dataset.theme === 'dark');
  $('#local-badge').hidden = !IS_LOCAL_PREVIEW;
  $('#preview-date').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date()).toUpperCase();
  try {
    const data = await request('/api/auth');
    displayDashboard(data.username);
    await loadNotes();
  } catch (_) {
    // A visitor without a session starts at the sign-in screen.
  }
})();
