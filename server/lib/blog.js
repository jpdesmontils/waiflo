import fs   from 'fs/promises';
import path  from 'path';
import { fileURLToPath } from 'url';

const __dirname     = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_DIR   = path.join(__dirname, '../../content/blog');

export async function listPosts(lang) {
  let files;
  try {
    files = await fs.readdir(CONTENT_DIR);
  } catch {
    return [];
  }
  const posts = await Promise.all(
    files
      .filter(f => f.endsWith(`.${lang}.json`))
      .map(async f => {
        const raw = await fs.readFile(path.join(CONTENT_DIR, f), 'utf-8');
        return JSON.parse(raw);
      })
  );
  return posts.sort((a, b) => new Date(b.date) - new Date(a.date));
}

export async function getPost(slug, lang) {
  const filePath = path.join(CONTENT_DIR, `${slug}.${lang}.json`);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    if (lang !== 'en') return getPost(slug, 'en');
    return null;
  }
}
