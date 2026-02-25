import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { scanDomain, checkDomainLive } from '../utils/domainScan.js';
import { MonitoredDomainModel } from '../models/MonitoredDomain.js';

export const domainMonitoringRouter = Router();

domainMonitoringRouter.use(requireAuth);

// ============ MONGODB CRUD OPERATIONS ============

// Get all monitored domains
domainMonitoringRouter.get('/domains', async (req, res) => {
  try {
    const domains = await MonitoredDomainModel.find().sort({ createdAt: -1 });
    return res.json({ domains });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'Failed to fetch domains' });
  }
});

// Get single domain
domainMonitoringRouter.get('/domains/:id', async (req, res) => {
  try {
    const domain = await MonitoredDomainModel.findById(req.params.id);
    if (!domain) {
      return res.status(404).json({ error: 'Domain not found' });
    }
    return res.json({ domain });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'Failed to fetch domain' });
  }
});

// Add new domain
domainMonitoringRouter.post('/domains', async (req, res) => {
  const body: any = req.body ?? {};
  let domainUrl = String(body.domain || '').trim();

  if (!domainUrl) {
    return res.status(400).json({ error: 'Domain is required' });
  }

  // Normalize domain URL
  if (!domainUrl.startsWith('http://') && !domainUrl.startsWith('https://')) {
    domainUrl = 'https://' + domainUrl;
  }

  try {
    // Check if domain already exists
    const existing = await MonitoredDomainModel.findOne({ domain: domainUrl });
    if (existing) {
      return res.status(409).json({ error: 'Domain already exists', domain: existing });
    }

    const userId = (req as any).user?._id?.toString();
    
    const newDomain = new MonitoredDomainModel({
      domain: domainUrl,
      addedBy: userId,
      isLive: null,
      isParked: null,
      lastChecked: null
    });

    await newDomain.save();
    return res.json({ domain: newDomain });
  } catch (e: any) {
    if (e.code === 11000) {
      return res.status(409).json({ error: 'Domain already exists' });
    }
    return res.status(500).json({ error: e?.message || 'Failed to add domain' });
  }
});

// Bulk add domains
domainMonitoringRouter.post('/domains/bulk', async (req, res) => {
  const body: any = req.body ?? {};
  const domainsInput = body.domains || [];

  if (!Array.isArray(domainsInput) || domainsInput.length === 0) {
    return res.status(400).json({ error: 'Domains array is required' });
  }

  try {
    const userId = (req as any).user?._id?.toString();
    const normalizedDomains = domainsInput.map((d: string) => {
      const trimmed = String(d).trim();
      if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
        return 'https://' + trimmed;
      }
      return trimmed;
    });

    // Get existing domains
    const existing = await MonitoredDomainModel.find({ domain: { $in: normalizedDomains } });
    const existingDomains = new Set(existing.map(d => d.domain));

    // Create new domains
    const newDomains = normalizedDomains
      .filter((d: string) => !existingDomains.has(d))
      .map((domain: string) => ({
        domain,
        addedBy: userId,
        isLive: null,
        isParked: null,
        lastChecked: null
      }));

    if (newDomains.length === 0) {
      return res.json({ 
        domains: existing,
        message: 'All domains already exist',
        added: 0,
        skipped: normalizedDomains.length
      });
    }

    const inserted = await MonitoredDomainModel.insertMany(newDomains);
    const allDomains = [...existing, ...inserted];

    return res.json({ 
      domains: allDomains,
      added: inserted.length,
      skipped: existing.length
    });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'Failed to add domains' });
  }
});

// Update domain
domainMonitoringRouter.put('/domains/:id', async (req, res) => {
  try {
    const domain = await MonitoredDomainModel.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true, runValidators: true }
    );
    if (!domain) {
      return res.status(404).json({ error: 'Domain not found' });
    }
    return res.json({ domain });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'Failed to update domain' });
  }
});

// Delete domain
domainMonitoringRouter.delete('/domains/:id', async (req, res) => {
  try {
    const domain = await MonitoredDomainModel.findByIdAndDelete(req.params.id);
    if (!domain) {
      return res.status(404).json({ error: 'Domain not found' });
    }
    return res.json({ message: 'Domain deleted', domain });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'Failed to delete domain' });
  }
});

// Update domain status
domainMonitoringRouter.post('/domains/:id/status', async (req, res) => {
  try {
    const statusData = req.body;
    const domain = await MonitoredDomainModel.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          isLive: statusData.isLive,
          isParked: statusData.isParked,
          parkingProvider: statusData.parkingProvider,
          responseTime: statusData.responseTime,
          statusCode: statusData.statusCode,
          lastChecked: new Date()
        }
      },
      { new: true }
    );
    if (!domain) {
      return res.status(404).json({ error: 'Domain not found' });
    }
    return res.json({ domain });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'Failed to update status' });
  }
});

// Save scan results
domainMonitoringRouter.post('/domains/:id/scan', async (req, res) => {
  try {
    const scanData = req.body;
    const domain = await MonitoredDomainModel.findByIdAndUpdate(
      req.params.id,
      { $set: { lastScan: scanData } },
      { new: true }
    );
    if (!domain) {
      return res.status(404).json({ error: 'Domain not found' });
    }
    return res.json({ domain });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'Failed to save scan' });
  }
});

// Deep scan a domain for links and images
domainMonitoringRouter.post('/scan', async (req, res) => {
  const body: any = req.body ?? {};
  const domain = String(body.domain || '').trim();
  const maxPages = body.maxPages != null ? Number(body.maxPages) : undefined;
  const maxDepth = body.maxDepth != null ? Number(body.maxDepth) : undefined;
  const includeSubdomains = body.includeSubdomains != null ? Boolean(body.includeSubdomains) : undefined;

  try {
    const result = await scanDomain(domain, { maxPages, maxDepth, includeSubdomains });
    return res.json({ result });
  } catch (e: any) {
    return res.status(400).json({ error: e?.message || 'Scan failed' });
  }
});

// Check if a domain is live (simple HEAD request)
domainMonitoringRouter.post('/status', async (req, res) => {
  const body: any = req.body ?? {};
  const domain = String(body.domain || '').trim();

  if (!domain) {
    return res.status(400).json({ error: 'Domain is required' });
  }

  try {
    const result = await checkDomainLive(domain);
    return res.json(result);
  } catch (e: any) {
    return res.json({ isLive: false, error: e?.message || 'Check failed' });
  }
});
