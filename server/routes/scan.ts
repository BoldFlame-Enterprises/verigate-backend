import { Router } from 'express';
import { APIResponse } from '../types';

const router = Router();

router.post('/verify', (_req, res) => {
  const response: APIResponse = {
    success: true,
    data: {},
    message: 'QR scan verification endpoint - TODO: Implement'
  };
  res.json(response);
});

export default router;
