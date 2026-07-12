import { Router } from 'express';
import { authMiddleware, requireTenant } from '../middleware/auth.js';
import { buildDeliverabilityCenter } from '../services/deliverabilityCenter.js';

export const deliverabilityRouter = Router();
deliverabilityRouter.use(authMiddleware, requireTenant);

// Full aggregated deliverability + launch-readiness snapshot (real data only).
deliverabilityRouter.get('/center', async (req, res) => {
  const data = await buildDeliverabilityCenter(req.auth!.tenantId!);
  res.json(data);
});

// Launch checklist only (subset), for lightweight polling.
deliverabilityRouter.get('/checklist', async (req, res) => {
  const data = await buildDeliverabilityCenter(req.auth!.tenantId!);
  res.json({ generatedAt: data.generatedAt, verdict: data.verdict, readinessScore: data.readinessScore, checklist: data.checklist, blockers: data.blockers });
});
