import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireDb } from '../middleware/db.js';
import { ProjectModel } from '../models/Project.js';
import { emitInvalidate } from '../realtime/invalidate.js';

export const projectsRouter = Router();

projectsRouter.use(requireAuth);
projectsRouter.use(requireDb);

projectsRouter.get('/', async (_req, res, next) => {
  try {
    const docs = await ProjectModel.find().lean();
    const projects = docs.map((d: any) => ({ ...d, id: String(d._id) }));
    projects.forEach((p: any) => {
      delete p._id;
      delete p.__v;
    });
    return res.json({ projects });
  } catch (e) {
    return next(e);
  }
});

projectsRouter.post('/', async (req, res, next) => {
  try {
    const data = req.body ?? {};
    const created = await ProjectModel.create(data);
    const p: any = created.toObject();
    p.id = String(p._id);
    delete p._id;
    delete p.__v;
    emitInvalidate('projects');
    return res.status(201).json({ project: p });
  } catch (e) {
    return next(e);
  }
});

projectsRouter.put('/:id', async (req, res, next) => {
  try {
    const updated = await ProjectModel.findByIdAndUpdate(req.params.id, req.body ?? {}, { new: true }).lean();
    if (!updated) return res.status(404).json({ error: 'Project not found' });
    const p: any = { ...updated, id: String(updated._id) };
    delete p._id;
    delete p.__v;
    emitInvalidate('projects');
    return res.json({ project: p });
  } catch (e) {
    return next(e);
  }
});

projectsRouter.delete('/:id', async (req, res, next) => {
  try {
    const deleted = await ProjectModel.findByIdAndDelete(req.params.id).lean();
    if (!deleted) return res.status(404).json({ error: 'Project not found' });
    emitInvalidate('projects');
    return res.json({ ok: true });
  } catch (e) {
    return next(e);
  }
});

