const express = require('express');
const { Sequelize } = require('sequelize');
const winston = require('winston');
const promClient = require('prom-client');
const createPaymentModel = require('./models/Payment');
const createWebhookLogModel = require('./models/WebhookLog');
const PaymentService = require('./services/paymentService');

const app = express();
const PORT = process.env.PORT || 4004;

app.use(express.json());

// Logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.json(),
  defaultMeta: { service: 'payment-service' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
  ],
});

// Prometheus metrics
const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

const paymentCounter = new promClient.Counter({
  name: 'payments_total',
  help: 'Total number of payments',
  labelNames: ['status'],
  registers: [register],
});

const webhookCounter = new promClient.Counter({
  name: 'webhooks_total',
  help: 'Total number of webhooks received',
  labelNames: ['event_type', 'is_duplicate'],
  registers: [register],
});

// Database
const sequelize = new Sequelize(
  process.env.DB_NAME || 'careforall_payments',
  process.env.DB_USER || 'root',
  process.env.DB_PASSWORD || 'rootpass123',
  {
    host: process.env.DB_HOST || 'localhost',
    dialect: 'mysql',
    logging: false,
  }
);

const Payment = createPaymentModel(sequelize);
const WebhookLog = createWebhookLogModel(sequelize);
const paymentService = new PaymentService(sequelize, Payment, WebhookLog, logger);

// Middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info('HTTP Request', {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration: Date.now() - start,
    });
  });
  next();
});

// Routes
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'payment-service' });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// Create payment
app.post('/api/payments', async (req, res, next) => {
  try {
    const { pledgeId, campaignId, amount } = req.body;
    logger.info('Payment request received', { pledgeId, campaignId, amount });
    const idempotencyKey = req.headers['idempotency-key'] || `payment-${pledgeId}-${Date.now()}`;

    const payment = await paymentService.createPayment({
      pledgeId,
      campaignId,
      amount,
      idempotencyKey,
    });

    paymentCounter.inc({ status: 'created' });
    res.status(201).json(payment);
  } catch (error) {
    next(error);
  }
});

// Webhook handler - CRITICAL: Idempotency
app.post('/api/payments/webhook', async (req, res, next) => {
  try {
    const webhookData = req.body;
    const idempotencyKey = req.headers['idempotency-key'] || 
                          `webhook-${webhookData.gatewayTransactionId}-${webhookData.eventType}`;

    const result = await paymentService.handleWebhook(webhookData, idempotencyKey);

    webhookCounter.inc({ 
      event_type: webhookData.eventType,
      is_duplicate: result.wasDuplicate ? 'true' : 'false',
    });

    if (result.wasDuplicate) {
      logger.warn('Duplicate webhook - returning cached result', { idempotencyKey });
    }

    res.json({
      success: true,
      payment: result.payment,
      wasDuplicate: result.wasDuplicate,
    });
  } catch (error) {
    next(error);
  }
});

// Get payment
app.get('/api/payments/:id', async (req, res, next) => {
  try {
    const payment = await paymentService.getPaymentById(req.params.id);
    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }
    res.json(payment);
  } catch (error) {
    next(error);
  }
});

// Get payment by pledge
app.get('/api/pledges/:pledgeId/payment', async (req, res, next) => {
  try {
    const payment = await paymentService.getPaymentByPledge(req.params.pledgeId);
    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }
    res.json(payment);
  } catch (error) {
    next(error);
  }
});

// Error handler
app.use((err, req, res, next) => {
  logger.error('Request error', err);
  res.status(err.statusCode || 500).json({
    error: { message: err.message },
  });
});

async function startServer() {
  try {
    await sequelize.authenticate();
    logger.info('Database connection established');

    await sequelize.sync({ alter: process.env.NODE_ENV === 'development' });
    logger.info('Database synchronized');

    await paymentService.init();

    app.listen(PORT, '0.0.0.0', () => {
      logger.info(`Payment Service running on port ${PORT}`);
    });
  } catch (error) {
    logger.error('Failed to start server', error);
    process.exit(1);
  }
}

startServer();

module.exports = app;
