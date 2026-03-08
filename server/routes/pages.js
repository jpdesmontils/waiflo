import { Router }            from 'express';
import { render, clearCache } from '../lib/renderer.js';
import { listPosts, getPost } from '../lib/blog.js';

const router = Router();

// ── Dev helper: bust cache on each request ─────────────────────────
if (process.env.NODE_ENV !== 'production') {
  router.use((req, res, next) => { clearCache(); next(); });
}

router.get('/', async (req, res) => {
  try {
    res.send(await render('landing', req.lang));
  } catch (e) {
    console.error('[pages] landing error:', e);
    res.status(500).send('Server error');
  }
});

router.get('/login', async (req, res) => {
  try {
    res.send(await render('login', req.lang));
  } catch (e) {
    console.error('[pages] login error:', e);
    res.status(500).send('Server error');
  }
});

router.get('/editor', async (req, res) => {
  try {
    res.send(await render('editor', req.lang));
  } catch (e) {
    console.error('[pages] editor error:', e);
    res.status(500).send('Server error');
  }
});

router.get('/blog', async (req, res) => {
  try {
    const posts = await listPosts(req.lang);
    res.send(await render('blog', req.lang, { posts }));
  } catch (e) {
    console.error('[pages] blog error:', e);
    res.status(500).send('Server error');
  }
});

router.get('/blog/:slug', async (req, res) => {
  try {
    const post = await getPost(req.params.slug, req.lang);
    if (!post) return res.redirect('/blog');
    res.send(await render('blog_post', req.lang, { post }));
  } catch (e) {
    console.error('[pages] blog_post error:', e);
    res.status(500).send('Server error');
  }
});

export default router;
