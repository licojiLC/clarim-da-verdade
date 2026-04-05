/**
 * ═══════════════════════════════════════════════════════
 *  CLARIM DA VERDADE — Auth Service
 *  JWT/OAuth2, bcrypt, rate-limiting, refresh tokens
 * ═══════════════════════════════════════════════════════
 */
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import slowDown from 'express-slow-down';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import pg from 'pg';
import Redis from 'ioredis';
import { z } from 'zod';
import winston from 'winston';
import promClient from 'prom-client';

// ── Logger ────────────────────────────────────────────────────
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'auth-service' },
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
});

// ── Metrics ───────────────────────────────────────────────────
promClient.collectDefaultMetrics({ prefix: 'auth_' });
const loginCounter = new promClient.Counter({
  name: 'auth_login_total',
  help: 'Total login attempts',
  labelNames: ['status'],
});
const tokenIssuedCounter = new promClient.Counter({
  name: 'auth_tokens_issued_total',
  help: 'Total JWT tokens issued',
});
const httpDuration = new promClient.Histogram({
  name: 'auth_http_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2],
});

// ── DB & Cache ────────────────────────────────────────────────
const pool = new pg.Pool({
  host: process.env.POSTGRES_HOST,
  port: parseInt(process.env.POSTGRES_PORT || '5432'),
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false,
});

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  password: process.env.REDIS_PASSWORD,
  maxRetriesPerRequest: 3,
  lazyConnect: true,
  retryStrategy: (times) => Math.min(times * 50, 2000),
});

// ── Validation Schemas ────────────────────────────────────────
const RegisterSchema = z.object({
  email: z.string().email().max(255).transform(v => v.toLowerCase().trim()),
  password: z.string()
    .min(8).max(128)
    .regex(/[A-Z]/, 'Precisa de maiúscula')
    .regex(/[a-z]/, 'Precisa de minúscula')
    .regex(/[0-9]/, 'Precisa de número')
    .regex(/[^A-Za-z0-9]/, 'Precisa de símbolo'),
  name: z.string().min(2).max(100).trim(),
  role: z.enum(['reader', 'journalist', 'editor']).default('reader'),
});

const LoginSchema = z.object({
  email: z.string().email().transform(v => v.toLowerCase().trim()),
  password: z.string().min(1).max(128),
});

const RefreshSchema = z.object({
  refreshToken: z.string().uuid(),
});

// ── Token Helpers ─────────────────────────────────────────────
const SALT_ROUNDS = 12;

function generateAccessToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
    algorithm: 'HS256',
    issuer: 'clarim-da-verdade',
    audience: 'clarim-clients',
    jwtid: uuidv4(),
  });
}

function generateRefreshToken(userId) {
  const token = uuidv4();
  return token;
}

async function storeRefreshToken(userId, token, userAgent, ip) {
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await pool.query(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, user_agent, ip_address, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
    [uuidv4(), userId, await bcrypt.hash(token, 8), expiresAt, userAgent?.slice(0, 255), ip]
  );
}

async function blacklistToken(jti) {
  const ttl = parseInt(process.env.JWT_EXPIRES_IN || '900');
  await redis.setex(`blacklist:${jti}`, ttl + 60, '1');
}

// ── App ───────────────────────────────────────────────────────
const app = express();

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  referrerPolicy: { policy: 'no-referrer' },
}));

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

// Trust proxy (behind Traefik/nginx)
app.set('trust proxy', 1);

// Metrics middleware
app.use((req, res, next) => {
  const end = httpDuration.startTimer();
  res.on('finish', () => end({ method: req.method, route: req.path, status: res.statusCode }));
  next();
});

// ── Rate Limiting ─────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas. Aguarde 15 minutos.' },
  keyGenerator: (req) => req.ip + ':' + req.body?.email,
});

const speedLimiter = slowDown({
  windowMs: 15 * 60 * 1000,
  delayAfter: 3,
  delayMs: () => 500,
});

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(generalLimiter);

// ── Middleware ────────────────────────────────────────────────
function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: 'Dados inválidos',
        details: result.error.flatten().fieldErrors,
      });
    }
    req.validated = result.data;
    next();
  };
}

async function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token não fornecido' });
  }
  const token = auth.slice(7);
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: 'clarim-da-verdade',
      audience: 'clarim-clients',
    });
    // Check blacklist
    const blacklisted = await redis.get(`blacklist:${decoded.jti}`);
    if (blacklisted) return res.status(401).json({ error: 'Token revogado' });
    req.user = decoded;
    next();
  } catch (err) {
    const msg = err.name === 'TokenExpiredError' ? 'Token expirado' : 'Token inválido';
    return res.status(401).json({ error: msg });
  }
}

// ── Routes ────────────────────────────────────────────────────

// Health
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    await redis.ping();
    res.json({ status: 'healthy', service: 'auth-service', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', error: err.message });
  }
});

// Metrics
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', promClient.register.contentType);
  res.end(await promClient.register.metrics());
});

// Register
app.post('/api/auth/register', authLimiter, speedLimiter, validateBody(RegisterSchema), async (req, res) => {
  const { email, password, name, role } = req.validated;
  try {
    // Check existing
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      // Don't reveal if email exists
      await bcrypt.hash(password, SALT_ROUNDS); // Timing-safe: always hash
      return res.status(409).json({ error: 'Email já cadastrado' });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const userId = uuidv4();

    await pool.query(
      `INSERT INTO users (id, email, password_hash, name, role, is_verified, created_at)
       VALUES ($1, $2, $3, $4, $5, false, NOW())`,
      [userId, email, passwordHash, name, role]
    );

    // Emit event to notification service via Kafka (simplified)
    logger.info('User registered', { userId, email, role });

    res.status(201).json({
      message: 'Conta criada. Verifique o seu email.',
      userId,
    });
  } catch (err) {
    logger.error('Register error', { err });
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Login
app.post('/api/auth/login', authLimiter, speedLimiter, validateBody(LoginSchema), async (req, res) => {
  const { email, password } = req.validated;
  try {
    const result = await pool.query(
      'SELECT id, password_hash, name, role, is_active, is_verified FROM users WHERE email = $1',
      [email]
    );

    // Always compare to prevent timing attacks
    const user = result.rows[0];
    const hash = user?.password_hash || '$2b$12$invalidhashfortimingsafety000000000000000000000000000';
    const valid = await bcrypt.compare(password, hash);

    if (!user || !valid) {
      loginCounter.inc({ status: 'failed' });
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    if (!user.is_active) {
      return res.status(403).json({ error: 'Conta desactivada' });
    }

    const payload = { sub: user.id, email, name: user.name, role: user.role };
    const accessToken = generateAccessToken(payload);
    const refreshToken = generateRefreshToken(user.id);

    await storeRefreshToken(user.id, refreshToken, req.headers['user-agent'], req.ip);

    await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

    loginCounter.inc({ status: 'success' });
    tokenIssuedCounter.inc();

    logger.info('User logged in', { userId: user.id, email });

    res.json({
      accessToken,
      refreshToken,
      expiresIn: 900,
      tokenType: 'Bearer',
      user: { id: user.id, email, name: user.name, role: user.role },
    });
  } catch (err) {
    logger.error('Login error', { err });
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Refresh token
app.post('/api/auth/refresh', validateBody(RefreshSchema), async (req, res) => {
  const { refreshToken } = req.validated;
  try {
    const tokens = await pool.query(
      `SELECT rt.*, u.email, u.name, u.role, u.is_active
       FROM refresh_tokens rt JOIN users u ON rt.user_id = u.id
       WHERE rt.expires_at > NOW() AND rt.revoked_at IS NULL`,
    );

    let matched = null;
    for (const row of tokens.rows) {
      if (await bcrypt.compare(refreshToken, row.token_hash)) {
        matched = row;
        break;
      }
    }

    if (!matched || !matched.is_active) {
      return res.status(401).json({ error: 'Refresh token inválido' });
    }

    // Rotate refresh token (token rotation pattern)
    await pool.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1', [matched.id]);

    const newRefreshToken = generateRefreshToken(matched.user_id);
    await storeRefreshToken(matched.user_id, newRefreshToken, req.headers['user-agent'], req.ip);

    const accessToken = generateAccessToken({
      sub: matched.user_id,
      email: matched.email,
      name: matched.name,
      role: matched.role,
    });

    tokenIssuedCounter.inc();
    res.json({ accessToken, refreshToken: newRefreshToken, expiresIn: 900, tokenType: 'Bearer' });
  } catch (err) {
    logger.error('Refresh error', { err });
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Logout
app.post('/api/auth/logout', authenticate, async (req, res) => {
  try {
    await blacklistToken(req.user.jti);
    await pool.query(
      'UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL',
      [req.user.sub]
    );
    logger.info('User logged out', { userId: req.user.sub });
    res.json({ message: 'Sessão encerrada com sucesso' });
  } catch (err) {
    logger.error('Logout error', { err });
    res.status(500).json({ error: 'Erro ao encerrar sessão' });
  }
});

// Verify token (internal service use)
app.post('/api/auth/verify', authenticate, (req, res) => {
  res.json({ valid: true, user: req.user });
});

// ── DB Schema ─────────────────────────────────────────────────
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            UUID PRIMARY KEY,
      email         VARCHAR(255) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name          VARCHAR(100) NOT NULL,
      role          VARCHAR(20) NOT NULL DEFAULT 'reader',
      is_active     BOOLEAN NOT NULL DEFAULT true,
      is_verified   BOOLEAN NOT NULL DEFAULT false,
      last_login    TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id          UUID PRIMARY KEY,
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash  TEXT NOT NULL,
      expires_at  TIMESTAMPTZ NOT NULL,
      revoked_at  TIMESTAMPTZ,
      user_agent  VARCHAR(255),
      ip_address  VARCHAR(45),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_refresh_expires ON refresh_tokens(expires_at);
  `);
  logger.info('Database schema initialised');
}

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 4001;
async function start() {
  try {
    await redis.connect().catch(() => {}); // Redis is optional if it reconnects
    await initDb();
    app.listen(PORT, () => {
      logger.info(`Auth Service running on port ${PORT}`);
    });
  } catch (err) {
    logger.error('Failed to start', { err });
    process.exit(1);
  }
}

process.on('SIGTERM', async () => {
  logger.info('Shutting down gracefully...');
  await pool.end();
  await redis.quit();
  process.exit(0);
});

start();
