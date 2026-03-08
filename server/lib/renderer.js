import fs      from 'fs/promises';
import path    from 'path';
import { fileURLToPath } from 'url';
import Mustache from 'mustache';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '../../');
const LABELS_DIR    = path.join(ROOT, 'labels');
const TEMPLATES_DIR = path.join(ROOT, 'templates');

// ── Cache ──────────────────────────────────────────────────────────
const labelsCache   = new Map();
const partialsCache = new Map();

async function loadLabels(page, lang) {
  const key  = `${page}.${lang}`;
  if (labelsCache.has(key)) return labelsCache.get(key);
  const filePath = path.join(LABELS_DIR, `labels_${page}.${lang}`);
  try {
    const raw    = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    labelsCache.set(key, parsed);
    return parsed;
  } catch {
    if (lang !== 'en') return loadLabels(page, 'en');   // fallback to EN
    return {};
  }
}

async function loadPartials(lang) {
  const dir = path.join(TEMPLATES_DIR, 'partials');
  const partials = {};
  try {
    const files = await fs.readdir(dir);
    await Promise.all(files.map(async file => {
      if (!file.endsWith('.mustache')) return;
      const name    = file.replace('.mustache', '');
      const cacheKey = `${name}.${lang}`;
      if (partialsCache.has(cacheKey)) {
        partials[name] = partialsCache.get(cacheKey);
        return;
      }
      const content = await fs.readFile(path.join(dir, file), 'utf-8');
      partialsCache.set(cacheKey, content);
      partials[name] = content;
    }));
  } catch { /* no partials dir */ }
  return partials;
}

async function loadTemplate(name) {
  // Try .mustache first, then .html
  for (const ext of ['.mustache', '.html']) {
    try {
      const content = await fs.readFile(path.join(TEMPLATES_DIR, `${name}${ext}`), 'utf-8');
      return { content, isMustache: ext === '.mustache' };
    } catch { /* try next */ }
  }
  throw new Error(`Template not found: ${name}`);
}

// ── Simple {{key}} replace for .html templates ────────────────────
function simpleReplace(template, labels) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => labels[key] ?? `{{${key}}}`);
}

// ── Inject window.LABELS before </head> for .html templates ───────
function injectLabelsScript(html, labels) {
  const script = `<script>window.LABELS=${JSON.stringify(labels)};</script>`;
  return html.replace('</head>', `${script}\n</head>`);
}

// ── Public API ────────────────────────────────────────────────────
export async function render(page, lang, extraData = {}) {
  const [sharedLabels, pageLabels, template] = await Promise.all([
    loadLabels('shared', lang),
    loadLabels(page, lang),
    loadTemplate(page),
  ]);

  const labels = { ...sharedLabels, ...pageLabels };
  const data   = {
    ...labels,
    ...extraData,
    lang,
    lang_en: lang === 'en',
    lang_fr: lang === 'fr',
  };

  if (template.isMustache) {
    const partials = await loadPartials(lang);
    return Mustache.render(template.content, data, partials);
  } else {
    let html = simpleReplace(template.content, data);
    html = injectLabelsScript(html, labels);
    return html;
  }
}

// Invalidate caches (useful in development)
export function clearCache() {
  labelsCache.clear();
  partialsCache.clear();
}
