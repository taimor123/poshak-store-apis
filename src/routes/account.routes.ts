import { Router } from 'express';
import { requireUser } from '../auth/authz.js';
import { success } from '../http/errors.js';
import * as account from '../services/account.service.js';
import { parse } from '../validation/parse.js';
import { addressSchema, profileSchema } from '../validation/schemas.js';

// Own profile and addresses. Every handler starts with requireUser; services scope by userId.

export const accountRouter = Router();

accountRouter.get('/profile', async (req, res) => {
  const user = requireUser(req);
  res.json(success(await account.getProfile(user.id)));
});

accountRouter.patch('/profile', async (req, res) => {
  const user = requireUser(req);
  res.json(success(await account.updateProfile(user.id, parse(profileSchema, req.body))));
});

accountRouter.get('/addresses', async (req, res) => {
  const user = requireUser(req);
  res.json(success(await account.listAddresses(user.id)));
});

accountRouter.post('/addresses', async (req, res) => {
  const user = requireUser(req);
  res.status(201).json(success(await account.createAddress(user.id, parse(addressSchema, req.body))));
});

accountRouter.patch('/addresses/:id', async (req, res) => {
  const user = requireUser(req);
  res.json(success(await account.updateAddress(user.id, req.params.id, parse(addressSchema.partial(), req.body))));
});

accountRouter.delete('/addresses/:id', async (req, res) => {
  const user = requireUser(req);
  res.json(success(await account.deleteAddress(user.id, req.params.id)));
});

accountRouter.post('/addresses/:id/default', async (req, res) => {
  const user = requireUser(req);
  res.json(success(await account.setDefaultAddress(user.id, req.params.id)));
});
