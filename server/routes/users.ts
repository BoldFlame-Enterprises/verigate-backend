import { Router } from 'express';
import { AuthRequest, APIResponse } from '../types';

const router = Router();

router.get('/me', (req: AuthRequest, res) => {
  const response: APIResponse = {
    success: true,
    data: req.user
  };
  res.json(response);
});

export default router;
