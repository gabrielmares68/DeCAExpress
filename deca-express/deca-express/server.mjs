import 'dotenv/config';
import express from 'express';
import rateLimit from 'express-rate-limit';
import Stripe from 'stripe';
import Database from 'better-sqlite3';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scrypt = promisify(scryptCallback);
const here = path.dirname(fileURLToPath(import.meta.url));
const baseUrl = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000').replace(/\/$/, '');
const port = Number(process.env.PORT || 3000);
const required = ['SESSION_SECRET', 'STRIPE_SECRET_KEY'];
for (const key of required) if (!process.env[key]) throw new Error(`Falta configurar ${key} en .env`);
if (process.env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET debe tener al menos 32 caracteres.');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const dbFile = path.resolve(here, process.env.DB_FILE || './data/deca.sqlite');
mkdirSync(path.dirname(dbFile), { recursive: true });
const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    stripe_customer_id TEXT,
    subscription_status TEXT NOT NULL DEFAULT 'inactive',
    subscription_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS stripe_events (
    id TEXT PRIMARY KEY,
    received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
const cookieName = 'deca_session';
const cookieSecure = baseUrl.startsWith('https://');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const normalizeEmail = (email) => String(email || '').trim().toLowerCase();
const isActive = (status) => ['active', 'trialing'].includes(status);

// Stripe needs the untouched request body to verify webhook signatures.
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).send('Webhook de Stripe pendiente de configurar');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.warn('Firma de webhook no válida:', err.message);
    return res.status(400).send('Firma no válida');
  }
  if (db.prepare('SELECT 1 FROM stripe_events WHERE id = ?').get(event.id)) return res.json({ received: true, duplicate: true });

  try {
    const transaction = db.transaction(() => {
      const obj = event.data.object;
      if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
        if (obj.mode === 'subscription' && obj.metadata?.userId) {
          db.prepare(`UPDATE users SET stripe_customer_id = ?, subscription_id = ?, subscription_status = ? WHERE id = ?`)
            .run(obj.customer, obj.subscription, 'active', Number(obj.metadata.userId));
        }
      } else if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
        const user = db.prepare('SELECT id FROM users WHERE stripe_customer_id = ?').get(obj.customer);
        if (user) db.prepare('UPDATE users SET subscription_id = ?, subscription_status = ? WHERE id = ?').run(obj.id, obj.status, user.id);
      } else if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
        const user = db.prepare('SELECT id FROM users WHERE stripe_customer_id = ?').get(obj.customer);
        if (user && obj.subscription) {
          const status = event.type === 'invoice.paid' ? 'active' : 'past_due';
          db.prepare('UPDATE users SET subscription_status = ? WHERE id = ?').run(status, user.id);
        }
      }
      db.prepare('INSERT INTO stripe_events (id) VALUES (?)').run(event.id);
    });
    transaction();
    return res.json({ received: true });
  } catch (err) {
    console.error('No se pudo procesar el webhook:', err);
    return res.status(500).send('Error procesando el evento');
  }
});

app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(here, 'public'), { index: false, dotfiles: 'deny' }));
const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: 'draft-8', legacyHeaders: false });

async function createSession(userId, res) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 14;
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(hash(token), userId, expiresAt);
  res.cookie(cookieName, token, { httpOnly: true, secure: cookieSecure, sameSite: 'lax', path: '/', maxAge: 14 * 24 * 60 * 60 * 1000 });
}

function userFromRequest(req) {
  const token = req.cookies?.[cookieName];
  if (!token) return null;
  const session = db.prepare(`SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?`).get(hash(token), Math.floor(Date.now() / 1000));
  return session || null;
}

// Small cookie parser; only the opaque, server-side session token is stored in this cookie.
app.use((req, _res, next) => {
  req.cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').map((part) => {
    const i = part.indexOf('='); return i < 0 ? ['', ''] : [part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim())];
  }).filter(([key]) => key));
  next();
});

app.get('/', (_req, res) => res.sendFile(path.join(here, 'public', 'index.html')));
app.get('/success', (_req, res) => res.sendFile(path.join(here, 'public', 'success.html')));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.post('/api/register', authLimit, async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) return res.status(400).json({ error: 'Introduce un correo electrónico válido.' });
  if (password.length < 12 || password.length > 200) return res.status(400).json({ error: 'La contraseña debe tener al menos 12 caracteres.' });
  try {
    const salt = randomBytes(16).toString('hex');
    const derived = await scrypt(password, salt, 64);
    const result = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run(email, `${salt}:${Buffer.from(derived).toString('hex')}`);
    await createSession(Number(result.lastInsertRowid), res);
    return res.status(201).json({ ok: true });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Ya existe una cuenta con ese correo.' });
    console.error(err); return res.status(500).json({ error: 'No se pudo crear la cuenta.' });
  }
});

app.post('/api/login', authLimit, async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
  const [salt, storedHex] = user.password_hash.split(':');
  const derived = Buffer.from(await scrypt(password, salt, 64));
  const stored = Buffer.from(storedHex, 'hex');
  if (derived.length !== stored.length || !timingSafeEqual(derived, stored)) return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
  await createSession(user.id, res);
  return res.json({ ok: true, subscribed: isActive(user.subscription_status) });
});

app.post('/api/logout', (req, res) => {
  const token = req.cookies?.[cookieName];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(token));
  res.clearCookie(cookieName, { httpOnly: true, secure: cookieSecure, sameSite: 'lax', path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Inicia sesión.' });
  return res.json({ email: user.email, status: user.subscription_status, active: isActive(user.subscription_status) });
});

app.post('/api/checkout', async (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Crea una cuenta o inicia sesión primero.' });
  if (isActive(user.subscription_status)) return res.status(409).json({ error: 'Tu suscripción ya está activa.' });
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: user.stripe_customer_id || undefined,
      customer_email: user.stripe_customer_id ? undefined : user.email,
      line_items: [{ price_data: { currency: 'eur', unit_amount: 2000, recurring: { interval: 'month' }, product_data: { name: 'DeCA Express · Suscripción mensual' } }, quantity: 1 }],
      metadata: { userId: String(user.id) },
      subscription_data: { metadata: { userId: String(user.id) } },
      success_url: `${baseUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/?checkout=cancelled`
    });
    return res.json({ url: session.url });
  } catch (err) {
    console.error('Error creando Checkout:', err);
    return res.status(502).json({ error: 'Stripe no pudo iniciar el pago. Revisa la configuración.' });
  }
});

app.post('/api/portal', async (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Inicia sesión.' });
  if (!user.stripe_customer_id) return res.status(409).json({ error: 'Todavía no hay una cuenta de facturación asociada.' });
  try {
    const portal = await stripe.billingPortal.sessions.create({ customer: user.stripe_customer_id, return_url: `${baseUrl}/cuenta` });
    return res.json({ url: portal.url });
  } catch (err) {
    console.error('Error creando el portal:', err);
    return res.status(502).json({ error: 'No se pudo abrir el portal de facturación.' });
  }
});

app.get('/cuenta', (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.redirect('/');
  res.send(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mi cuenta · DeCA Express</title><style>body{font:16px system-ui;max-width:620px;margin:12vh auto;padding:24px;color:#13203a}a,button{font:inherit}button{padding:12px 16px;background:#1b3a6b;color:white;border:0;border-radius:6px;cursor:pointer}.muted{color:#5a6679}</style><h1>Mi cuenta</h1><p>${escapeHtml(user.email)}</p><p class="muted">Estado de la suscripción: ${escapeHtml(user.subscription_status)}</p><button id="portal">Gestionar suscripción y pagos</button><p><a href="/app">Volver a DeCA Express</a></p><script>document.querySelector('#portal').onclick=async()=>{const r=await fetch('/api/portal',{method:'POST'});const d=await r.json();if(d.url)location.href=d.url;else alert(d.error||'Error')};</script></html>`);
});

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

app.get('/app', (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.redirect('/?login=1');
  if (!isActive(user.subscription_status)) return res.redirect('/?subscribe=1');
  return res.sendFile(path.join(here, 'app.html'));
});

// Remove expired sessions on startup and every hour.
const cleanup = () => db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Math.floor(Date.now() / 1000));
cleanup(); setInterval(cleanup, 60 * 60 * 1000).unref();

app.listen(port, () => console.log(`DeCA Express disponible en ${baseUrl} (puerto ${port})`));
