import { Router } from 'express';
import { APIResponse } from '../types';
import { requireAdmin } from '../middleware/auth';

const router = Router();

// Apply admin middleware to all routes
router.use(requireAdmin);

router.get('/dashboard', (_req, res) => {
  const response: APIResponse = {
    success: true,
    data: {},
    message: 'Admin dashboard endpoint - TODO: Implement'
  };
  res.json(response);
});

export default router;
