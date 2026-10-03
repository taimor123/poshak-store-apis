import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';

const app = createApp(loadEnv({ NODE_ENV: 'test', WEB_ORIGIN: 'http://localhost:3000', LOG_LEVEL: 'silent' }));

describe('api foundation', () => {
  it('GET /api/v1/health returns the success envelope', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, data: { status: 'ok' } });
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('unknown routes return a NOT_FOUND envelope', async () => {
    const res = await request(app).get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('allows only the web app origin, with credentials', async () => {
    const allowed = await request(app).get('/api/v1/health').set('Origin', 'http://localhost:3000');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');

    const other = await request(app).get('/api/v1/health').set('Origin', 'https://evil.example');
    expect(other.headers['access-control-allow-origin']).not.toBe('https://evil.example');
  });

  it('malformed JSON returns a VALIDATION envelope, not a 500', async () => {
    const res = await request(app).post('/api/v1/health').set('Content-Type', 'application/json').send('{bad');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
  });

  it('rejects an invalid environment at boot', () => {
    expect(() => loadEnv({ PORT: 'abc' })).toThrow(/Invalid environment/);
  });
});
