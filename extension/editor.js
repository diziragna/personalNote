// Note editing helpers, copied from public/app.js so the popup edits notes exactly like the board.
// Keep the two copies in sync.

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

