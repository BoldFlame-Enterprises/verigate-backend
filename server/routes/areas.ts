import { Router } from 'express';
import { APIResponse } from '../types';

const router = Router();

router.get('/', (_req, res) => {
  const response: APIResponse = {
    success: true,
    data: [],
    message: 'Areas endpoint - TODO: Implement'
  };
  res.json(response);
});

export default router;
