import { Router } from 'express';
import { supabase } from '../../db/supabase.js';

const router = Router();

// GET /api/admin/keywords — list all keywords
router.get('/api/admin/keywords', async (_req, res) => {
  const { data, error } = await supabase
    .from('keywords')
    .select('*')
    .order('id', { ascending: true });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json(data);
});

// POST /api/admin/keywords — add a new keyword
router.post('/api/admin/keywords', async (req, res) => {
  const { keyword } = req.body;

  if (!keyword || typeof keyword !== 'string' || keyword.trim().length === 0) {
    res.status(400).json({ error: 'keyword is required and must be a non-empty string' });
    return;
  }

  const category = req.body.category === 'enterprise' ? 'enterprise' : 'ecosystem';

  const platforms = Array.isArray(req.body.platforms) ? req.body.platforms : ['reddit', 'hn'];

  const { data, error } = await supabase
    .from('keywords')
    .insert({ keyword: keyword.trim().toLowerCase(), active: true, category, platforms })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      res.status(409).json({ error: 'Keyword already exists' });
      return;
    }
    res.status(500).json({ error: error.message });
    return;
  }

  res.status(201).json(data);
});

// PUT /api/admin/keywords/:id — edit a keyword
router.put('/api/admin/keywords/:id', async (req, res) => {
  const { id } = req.params;
  const updates = req.body;

  if (!updates || typeof updates !== 'object' || Object.keys(updates).length === 0) {
    res.status(400).json({ error: 'Request body must be a non-empty object' });
    return;
  }

  // Only allow updating keyword text, active status, and category
  const allowed: Record<string, unknown> = {};
  if ('keyword' in updates && typeof updates.keyword === 'string') {
    allowed.keyword = updates.keyword.trim().toLowerCase();
  }
  if ('active' in updates && typeof updates.active === 'boolean') {
    allowed.active = updates.active;
  }
  if ('category' in updates && (updates.category === 'ecosystem' || updates.category === 'enterprise')) {
    allowed.category = updates.category;
  }
  if ('platforms' in updates && Array.isArray(updates.platforms)) {
    allowed.platforms = updates.platforms;
  }

  if (Object.keys(allowed).length === 0) {
    res.status(400).json({ error: 'No valid fields to update (allowed: keyword, active, category, platforms)' });
    return;
  }

  const { data, error } = await supabase
    .from('keywords')
    .update(allowed)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json(data);
});

// DELETE /api/admin/keywords/:id — deactivate (soft delete)
router.delete('/api/admin/keywords/:id', async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from('keywords')
    .update({ active: false })
    .eq('id', id)
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json(data);
});

export default router;
