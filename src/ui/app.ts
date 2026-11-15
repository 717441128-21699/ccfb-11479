/** 应用入口:页签切换与各模块初始化 */

import { initBatch } from './batch.js';
import { initEditor } from './editor.js';
import { initLibrary } from './library.js';
import { initParse } from './parse.js';
import { initStats } from './statsView.js';

const sections: Record<string, HTMLElement> = {};
for (const name of ['library', 'editor', 'parse', 'batch', 'stats']) {
  sections[name] = document.getElementById(`tab-${name}`)!;
}

const editor = initEditor(sections.editor);
const library = initLibrary(sections.library, (id) => {
  editor.edit(id || '');
  show('editor');
});
const parse = initParse(sections.parse);
const batch = initBatch(sections.batch);
const stats = initStats(sections.stats);

function show(name: string): void {
  for (const [k, sec] of Object.entries(sections)) {
    sec.classList.toggle('hidden', k !== name);
  }
  document.querySelectorAll('#tabs button').forEach((b) => {
    b.classList.toggle('active', (b as HTMLElement).dataset.tab === name);
  });
  if (name === 'stats') stats.refresh();
  if (name === 'parse') parse.refreshProtocols();
  if (name === 'batch') batch.refreshProtocols();
  if (name === 'library') library.refresh();
}

document.querySelectorAll('#tabs button').forEach((b) => {
  b.addEventListener('click', () => show((b as HTMLElement).dataset.tab!));
});
