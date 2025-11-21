const express = require('express');
const axios = require('axios');
const winston = require('winston');
const promClient = require('prom-client');

const app = express();
const PORT = process.env.PORT || 4007;

app.use(express.json());

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  defaultMeta: { service: 'admin-service' },
  transports: [new winston.transports.Console({ format: winston.format.simple() })],
});

const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

const services = {
  campaign: process.env.CAMPAIGN_SERVICE_URL || 'http://localhost:4002',
  pledge: process.env.PLEDGE_SERVICE_URL || 'http://localhost:4003',
  payment: process.env.PAYMENT_SERVICE_URL || 'http://localhost:4004',
  totals: process.env.TOTALS_SERVICE_URL || 'http://localhost:4005',
  auth: process.env.AUTH_SERVICE_URL || 'http://localhost:4001',
};

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'admin-service' });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.get('/api/admin/campaigns', async (req, res, next) => {
  try {
    const [campaigns, totalsData] = await Promise.all([
      axios.get(`${services.campaign}/api/campaigns`),
      Promise.resolve([]), // We'll fetch totals individually
    ]);

    const campaignsWithTotals = await Promise.all(
      campaigns.data.rows.map(async (campaign) => {
        try {
          const totals = await axios.get(`${services.totals}/api/campaigns/${campaign.id}/totals`);
          return { ...campaign, totals: totals.data };
        } catch (error) {
          return { ...campaign, totals: null };
        }
      })
    );

    res.json({
      count: campaigns.data.count,
      campaigns: campaignsWithTotals,
    });
  } catch (error) {
    logger.error('Error fetching campaigns', error);
    next(error);
  }
});

app.get('/api/admin/campaigns/:id', async (req, res, next) => {
  try {
    const [campaign, totals, pledges] = await Promise.all([
      axios.get(`${services.campaign}/api/campaigns/${req.params.id}`),
      axios.get(`${services.totals}/api/campaigns/${req.params.id}/totals`).catch(() => null),
      axios.get(`${services.pledge}/api/campaigns/${req.params.id}/pledges`).catch(() => ({ data: [] })),
    ]);

    res.json({
      ...campaign.data,
      totals: totals?.data || null,
      pledges: pledges.data,
    });
  } catch (error) {
    logger.error('Error fetching campaign details', error);
    next(error);
  }
});

app.get('/api/admin/analytics', async (req, res, next) => {
  try {
    const campaigns = await axios.get(`${services.campaign}/api/campaigns?limit=1000`);
    
    const stats = {
      totalCampaigns: campaigns.data.count,
      activeCampaigns: campaigns.data.rows.filter(c => c.status === 'ACTIVE').length,
      completedCampaigns: campaigns.data.rows.filter(c => c.status === 'COMPLETED').length,
      draftCampaigns: campaigns.data.rows.filter(c => c.status === 'DRAFT').length,
    };

    const totalsPromises = campaigns.data.rows.map(campaign =>
      axios.get(`${services.totals}/api/campaigns/${campaign.id}/totals`).catch(() => null)
    );
    
    const totalsResults = await Promise.all(totalsPromises);
    
    let totalPledges = 0;
    let totalAmount = 0;
    
    totalsResults.forEach(result => {
      if (result?.data) {
        totalPledges += result.data.totalPledges || 0;
        totalAmount += parseFloat(result.data.totalAmount || 0);
      }
    });

    stats.totalPledges = totalPledges;
    stats.totalAmountRaised = totalAmount.toFixed(2);
    stats.averagePledgeAmount = totalPledges > 0 ? (totalAmount / totalPledges).toFixed(2) : 0;

    res.json(stats);
  } catch (error) {
    logger.error('Error fetching analytics', error);
    next(error);
  }
});

app.post('/api/admin/campaigns/:id/approve', async (req, res, next) => {
  try {
    const campaign = await axios.put(
      `${services.campaign}/api/campaigns/${req.params.id}`,
      { status: 'ACTIVE' }
    );

    logger.info('Campaign approved', { campaignId: req.params.id });
    res.json(campaign.data);
  } catch (error) {
    logger.error('Error approving campaign', error);
    next(error);
  }
});

app.post('/api/admin/campaigns/:id/reject', async (req, res, next) => {
  try {
    const { reason } = req.body;
    
    const campaign = await axios.put(
      `${services.campaign}/api/campaigns/${req.params.id}`,
      { status: 'CANCELLED' }
    );

    logger.info('Campaign rejected', { campaignId: req.params.id, reason });
    res.json(campaign.data);
  } catch (error) {
    logger.error('Error rejecting campaign', error);
    next(error);
  }
});

app.get('/api/admin/pledges', async (req, res, next) => {
  try {
    const { status, limit = 100 } = req.query;
    
    // This would need a dedicated endpoint in pledge service
    // For now, return a simple response
    res.json({
      message: 'Pledge listing endpoint - needs implementation in pledge service',
      params: { status, limit },
    });
  } catch (error) {
    logger.error('Error fetching pledges', error);
    next(error);
  }
});

app.get('/api/admin/services/health', async (req, res, next) => {
  try {
    const healthChecks = await Promise.allSettled([
      axios.get(`${services.campaign}/health`),
      axios.get(`${services.pledge}/health`),
      axios.get(`${services.payment}/health`),
      axios.get(`${services.totals}/health`),
      axios.get(`${services.auth}/health`),
    ]);

    const status = {
      campaign: healthChecks[0].status === 'fulfilled' ? 'healthy' : 'unhealthy',
      pledge: healthChecks[1].status === 'fulfilled' ? 'healthy' : 'unhealthy',
      payment: healthChecks[2].status === 'fulfilled' ? 'healthy' : 'unhealthy',
      totals: healthChecks[3].status === 'fulfilled' ? 'healthy' : 'unhealthy',
      auth: healthChecks[4].status === 'fulfilled' ? 'healthy' : 'unhealthy',
    };

    const allHealthy = Object.values(status).every(s => s === 'healthy');

    res.status(allHealthy ? 200 : 503).json({
      overall: allHealthy ? 'healthy' : 'degraded',
      services: status,
    });
  } catch (error) {
    logger.error('Error checking service health', error);
    next(error);
  }
});

app.use((err, req, res, next) => {
  logger.error('Request error', err);
  
  if (err.response) {
    return res.status(err.response.status).json({ error: err.response.data });
  }
  
  res.status(500).json({ error: { message: err.message } });
});

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Admin Service running on port ${PORT}`);
});

module.exports = app;
