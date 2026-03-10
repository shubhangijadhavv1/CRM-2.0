import { Router } from 'express';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import { requireDb } from '../middleware/db.js';
import { MigrationModel } from '../models/Migration.js';
import { UserModel } from '../models/User.js';
import { ProjectModel } from '../models/Project.js';
import { emitInvalidate } from '../realtime/invalidate.js';

export const migrationsRouter = Router();

migrationsRouter.use(requireAuth);
migrationsRouter.use(requireDb);

migrationsRouter.get('/status', async (_req, res, next) => {
  try {
    const docs = await MigrationModel.find().sort({ createdAt: -1 }).lean();
    const migrations = docs.map((d: any) => {
      const out: any = { ...d, id: String(d._id) };
      delete out._id;
      delete out.__v;
      return out;
    });
    return res.json({ migrations });
  } catch (e) {
    return next(e);
  }
});

migrationsRouter.post('/status', async (req: AuthedRequest, res, next) => {
  try {
    const body: any = req.body ?? {};
    const projectId = String(body.projectId || '').trim();
    const projectName = String(body.projectName || '').trim();
    const demoUrl = String(body.demoUrl || '').trim();
    const liveUrl = String(body.liveUrl || '').trim();
    const migrationDate = String(body.migrationDate || new Date().toISOString().split('T')[0]).trim();
    const dataCleared = Boolean(body.dataCleared);

    if (!projectId || !projectName || !demoUrl || !liveUrl) {
      return res.status(400).json({ error: 'projectId, projectName, demoUrl and liveUrl are required' });
    }

    const me = await UserModel.findById(req.user!.id).lean();
    const migratedBy = String((me as any)?.name || '').trim() || 'Unknown User';

    const created = await MigrationModel.create({
      projectId,
      projectName,
      demoUrl,
      liveUrl,
      migrationDate,
      migratedBy,
      dataCleared
    });

    const migration: any = created.toObject();
    migration.id = String(migration._id);
    delete migration._id;
    delete migration.__v;
    return res.status(201).json({ migration });
  } catch (e) {
    return next(e);
  }
});

migrationsRouter.put('/status/:id', async (req, res, next) => {
  try {
    const patch: any = { ...(req.body ?? {}) };
    delete patch.migratedBy;
    delete patch.id;
    delete patch._id;

    const updated = await MigrationModel.findByIdAndUpdate(req.params.id, patch, { new: true }).lean();
    if (!updated) return res.status(404).json({ error: 'Migration not found' });
    const migration: any = { ...updated, id: String(updated._id) };
    delete migration._id;
    delete migration.__v;
    return res.json({ migration });
  } catch (e) {
    return next(e);
  }
});

migrationsRouter.delete('/status/:id', async (req, res, next) => {
  try {
    const deleted = await MigrationModel.findByIdAndDelete(req.params.id).lean();
    if (!deleted) return res.status(404).json({ error: 'Migration not found' });
    return res.json({ ok: true });
  } catch (e) {
    return next(e);
  }
});

migrationsRouter.post('/clear-demo', async (req, res, next) => {
  try {
    const body: any = req.body ?? {};
    const migrationId = String(body.migrationId || '').trim();
    let projectId = String(body.projectId || '').trim();

    if (!migrationId && !projectId) {
      return res.status(400).json({ error: 'migrationId or projectId is required' });
    }

    let updatedMigration: any = null;
    if (migrationId) {
      const migration = await MigrationModel.findById(migrationId).lean();
      if (!migration) return res.status(404).json({ error: 'Migration not found' });
      projectId = projectId || String((migration as any).projectId || '').trim();
      updatedMigration = await MigrationModel.findByIdAndUpdate(
        migrationId,
        { $set: { dataCleared: true } },
        { new: true }
      ).lean();
    } else if (projectId) {
      const migration = await MigrationModel.findOne({ projectId }).sort({ createdAt: -1 }).lean();
      if (migration) {
        updatedMigration = await MigrationModel.findByIdAndUpdate(
          String((migration as any)._id),
          { $set: { dataCleared: true } },
          { new: true }
        ).lean();
      }
    }

    if (!projectId) return res.status(400).json({ error: 'Unable to resolve projectId for clear-demo action' });

    const deletedProject = await ProjectModel.findOneAndDelete({ _id: projectId, type: 'demo' }).lean();
    if (!deletedProject) {
      return res.status(404).json({ error: 'Demo project not found for this migration' });
    }

    emitInvalidate('projects');

    const migrationOut = updatedMigration
      ? (() => {
          const out: any = { ...updatedMigration, id: String((updatedMigration as any)._id) };
          delete out._id;
          delete out.__v;
          return out;
        })()
      : null;

    return res.json({ ok: true, deletedProjectId: projectId, migration: migrationOut });
  } catch (e) {
    return next(e);
  }
});
