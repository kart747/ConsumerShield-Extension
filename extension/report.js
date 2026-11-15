// Empty until a real scan is loaded from storage. No demo data: a report page
// that shows made-up findings for a site the user never scanned is misleading.
let REPORT = {
  site: 'No scan loaded',
  timestamp: '—',
  securityScore: 0,
  darkPatterns: [],
  trackers: [],
  aiAnalysis: 'No scan data yet. Open a website, click the ConsumerShield icon, then choose "View Full Report".',
  legalMappings: [],
  totalRequests: 0,
  wallOfShame: [],
};
let HAS_SCAN = false;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function emptyState(message) {
  return `<div class="empty-state" style="padding:18px;color:#8A9BB0;font-size:13px;border:1px dashed rgba(138,155,176,.3)">${esc(message)}</div>`;
}

let LAST_ANALYSIS = null;

const BACKEND_BASE_URLS = [
  'http://127.0.0.1:8012',
  'http://localhost:8012',
  'http://127.0.0.1:8000',
  'http://localhost:8000',
];
const BACKEND_URL_KEY = 'consumershield_backend_url';

function formatReportTimestamp(timestampMs) {
  const dt = Number(timestampMs) > 0 ? new Date(Number(timestampMs)) : new Date();
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  const hh = String(dt.getHours()).padStart(2, '0');
  const mi = String(dt.getMinutes()).padStart(2, '0');
  const ss = String(dt.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} · ${hh}:${mi}:${ss}`;
}

function normalizeSeverity(value) {
  const raw = String(value || '').toLowerCase();
  if (raw.includes('critical') || raw.includes('severe')) return 'critical';
  if (raw.includes('high')) return 'high';
  if (raw.includes('low') || raw.includes('safe')) return 'low';
  return 'medium';
}

function normalizeRisk(value) {
  const sev = normalizeSeverity(value);
  if (sev === 'critical') return 'critical';
  if (sev === 'high') return 'high';
  if (sev === 'low') return 'medium';
  return 'medium';
}

function toReportShape(analysis) {
  if (!analysis || typeof analysis !== 'object') return null;

  const fallbackUrl = String(analysis.url || '');
  let site = String(analysis.domain || '').trim();
  if (!site && fallbackUrl) {
    try {
      site = new URL(fallbackUrl).hostname.replace(/^www\./, '');
    } catch {
      site = fallbackUrl;
    }
  }
  if (!site) site = 'unknown-site';

  const privacy = analysis.privacy || {};
  const manipulation = analysis.manipulation || {};
  const overall = analysis.overall || {};

  const darkPatterns = Array.isArray(manipulation.patterns)
    ? manipulation.patterns.map((pattern, index) => ({
        id: index + 1,
        type: pattern.name || pattern.type || 'Dark Pattern',
        description: pattern.description || pattern.text || 'Pattern detected during live scan.',
        severity: normalizeSeverity(pattern.severity),
        dpdpRef: pattern.law || 'DPDP Act 2023',
      }))
    : [];

  const trackers = Array.isArray(privacy.trackers)
    ? privacy.trackers.map((tracker, index) => ({
        name: tracker.name || tracker.domain || `Tracker ${index + 1}`,
        category: tracker.type || 'Tracker',
        risk: normalizeRisk(tracker.riskLevel || privacy.riskLevel || 'medium'),
        requests: Number(tracker.requests || tracker.hits || 1),
      }))
    : [];

  const legalMappings = Array.isArray(analysis.regulatoryViolations)
    ? analysis.regulatoryViolations.map((item, index) => {
        const section = item.section || item.law || item.regulation || `Section ${index + 1}`;
        const title = item.issue || item.title || item.violation || item.pattern || 'Potential compliance issue';
        const description = [
          item.law,
          item.penalty ? `Penalty: ${item.penalty}` : '',
          item.authority ? `Authority: ${item.authority}` : '',
        ].filter(Boolean).join(' · ') || item.description || 'Flagged during analysis.';
        return { section, title, description, risk: 'violation' };
      })
    : [];

  const totalRequests = Number(analysis?.network_activity?.total_request_count || 0);

  const securityScoreRaw = Number(overall.riskScore);
  const fallbackRisk = Math.max(Number(privacy.riskScore || 0), Number(manipulation.riskScore || 0));
  const securityScore = Number.isFinite(securityScoreRaw) ? securityScoreRaw : fallbackRisk;

  return {
    ...REPORT,
    site,
    timestamp: formatReportTimestamp(analysis.timestamp),
    securityScore: Math.max(0, Math.min(10, Number(securityScore || 0))),
    darkPatterns,
    trackers,
    aiAnalysis: analysis.aiInsight || overall.insight || 'Live analysis completed. Review findings below.',
    legalMappings,
    totalRequests,
  };
}

async function hydrateReportFromStorage() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return;

  const storedAnalysis = await new Promise((resolve) => {
    chrome.storage.local.get(['consumershield_last_report'], (result) => {
      resolve(result?.consumershield_last_report || null);
    });
  });

  const mapped = toReportShape(storedAnalysis);
  LAST_ANALYSIS = storedAnalysis;
  if (mapped) {
    REPORT = mapped;
    HAS_SCAN = true;
  }
}

function scoreConfig(s) {
  if (s <= 2) return { color: '#39FF14', glow: 'rgba(57,255,20,.4)', level: 'SECURE' };
  if (s <= 5) return { color: '#F5E642', glow: 'rgba(245,230,66,.4)', level: 'MODERATE' };
  if (s <= 8) return { color: '#FF6B00', glow: 'rgba(255,107,0,.4)', level: 'HIGH' };
  return { color: '#FF003C', glow: 'rgba(255,0,60,.4)', level: 'CRITICAL' };
}

function sevConfig(sev) {
  return ({
    critical: { color: '#FF003C', bg: 'rgba(255,0,60,.06)', border: 'rgba(255,0,60,.28)', label: 'CRITICAL', pulse: true },
    high: { color: '#FF6B00', bg: 'rgba(255,107,0,.06)', border: 'rgba(255,107,0,.28)', label: 'HIGH', pulse: false },
    medium: { color: '#F5E642', bg: 'rgba(245,230,66,.05)', border: 'rgba(245,230,66,.22)', label: 'MEDIUM', pulse: false },
    low: { color: '#00F0FF', bg: 'rgba(0,240,255,.04)', border: 'rgba(0,240,255,.18)', label: 'LOW', pulse: false },
  }[sev] || { color: '#00F0FF', bg: 'rgba(0,240,255,.04)', border: 'rgba(0,240,255,.18)', label: 'LOW', pulse: false });
}

function riskConfig(r) {
  return ({
    critical: { color: '#FF003C', bg: 'rgba(255,0,60,.1)' },
    high: { color: '#FF6B00', bg: 'rgba(255,107,0,.1)' },
    medium: { color: '#F5E642', bg: 'rgba(245,230,66,.1)' },
  }[r] || { color: '#F5E642', bg: 'rgba(245,230,66,.1)' });
}

function buildStats() {
  const stats = [
    { label: 'Security Score', val: `${REPORT.securityScore}/10`, sub: 'Overall risk rating', color: '#FF003C' },
    { label: 'Dark Patterns', val: REPORT.darkPatterns.length, sub: 'Manipulative elements found', color: '#FF003C' },
    { label: 'Active Trackers', val: REPORT.trackers.length, sub: 'Third-party surveillance', color: '#FF6B00' },
    { label: 'Legal Violations', val: REPORT.legalMappings.filter((mapping) => mapping.risk === 'violation').length, sub: 'DPDP Act / CCPA guideline breaches', color: '#FF003C' },
    { label: 'Total Requests', val: REPORT.totalRequests || REPORT.trackers.reduce((count, tracker) => count + tracker.requests, 0), sub: 'Third-party network calls', color: '#F5E642' },
  ];

  const grid = document.getElementById('stat-grid');
  stats.forEach((stat) => {
    const tile = document.createElement('div');
    tile.className = 'stat-tile';
    tile.innerHTML = `
      <div class="stat-top"><span class="stat-label">${stat.label}</span></div>
      <div class="stat-val" style="color:${stat.color};text-shadow:0 0 20px ${stat.color}55">${stat.val}</div>
      <div class="stat-sub">${stat.sub}</div>`;
    const bar = document.createElement('div');
    bar.style.cssText = `position:absolute;top:0;left:0;right:0;height:2px;background:${stat.color};opacity:.4;`;
    tile.appendChild(bar);
    grid.appendChild(tile);
  });
}

function buildDarkPatterns() {
  const grid = document.getElementById('dark-pattern-grid');
  if (!REPORT.darkPatterns.length) {
    grid.innerHTML = emptyState(HAS_SCAN ? 'No dark patterns were detected on this page.' : 'No scan loaded.');
    return;
  }
  REPORT.darkPatterns.forEach((pattern, index) => {
    const cfg = sevConfig(pattern.severity);
    const card = document.createElement('div');
    card.className = 'dp-card';
    card.style.cssText = `background:${cfg.bg};border:1px solid ${cfg.border};transition-delay:${index * 0.1}s`;
    let inner = '';
    if (cfg.pulse) inner += `<div class="dp-card-pulse" style="background:${cfg.color}"></div>`;
    inner += `
      <div class="dp-card-top">
        <div class="dp-card-left">
          <div class="dp-icon" style="background:${cfg.color}14;border-color:${cfg.color}33">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke="${cfg.color}" stroke-width="1.5" stroke-linecap="round"/></svg>
          </div>
          <div>
            <div class="dp-type">${esc(pattern.type)}</div>
            <div class="dp-dpdp">/// ${esc(pattern.dpdpRef)}</div>
          </div>
        </div>
        <span class="severity-badge" style="color:${cfg.color};border-color:${cfg.color}66;background:${cfg.color}0F">${cfg.label}</span>
      </div>
      <p class="dp-desc" style="color:#9AAABB">${esc(pattern.description)}</p>
      <div class="dp-bottom-line" style="background:${cfg.color}"></div>`;
    card.innerHTML = inner;
    grid.appendChild(card);
  });
}

function buildTrackers() {
  const rows = document.getElementById('tracker-rows');
  if (!REPORT.trackers.length) {
    rows.innerHTML = emptyState(HAS_SCAN ? 'No third-party trackers were detected on this page.' : 'No scan loaded.');
    return;
  }
  const maxReq = Math.max(1, ...REPORT.trackers.map((tracker) => tracker.requests));
  REPORT.trackers.forEach((tracker, index) => {
    const cfg = riskConfig(tracker.risk);
    const pct = Math.round((tracker.requests / maxReq) * 100);
    const row = document.createElement('div');
    row.className = 'tracker-row';
    row.style.transitionDelay = `${index * 0.08}s`;
    row.innerHTML = `
      <div>
        <div class="tracker-name">${esc(tracker.name)}</div>
        <div class="tracker-cat-row">
          <span class="tracker-cat">/// ${esc(tracker.category)}</span>
          <div class="tracker-bar-track"><div class="tracker-bar-fill" style="background:${cfg.color}" data-w="${pct}"></div></div>
        </div>
      </div>
      <div class="tracker-req">${tracker.requests}<span> req</span></div>
      <span class="risk-badge" style="color:${cfg.color};border-color:${cfg.color}66;background:${cfg.bg}">${esc(tracker.risk.toUpperCase())}</span>`;
    rows.appendChild(row);
  });
}

function buildAI() {
  document.getElementById('ai-text').textContent = REPORT.aiAnalysis;
  // Findings are derived from the scan itself, never hardcoded.
  const findings = [];
  const countBySeverity = (sev) => REPORT.darkPatterns.filter((p) => p.severity === sev).length;
  const severe = countBySeverity('critical') + countBySeverity('high');
  const violations = REPORT.legalMappings.filter((m) => m.risk === 'violation').length;
  if (REPORT.darkPatterns.length) {
    findings.push({ label: `${REPORT.darkPatterns.length} manipulative design pattern(s) on this page`, score: severe ? 'HIGH RISK' : 'FLAGGED', color: severe ? '#FF003C' : '#F5E642' });
  }
  if (REPORT.trackers.length) {
    findings.push({ label: `${REPORT.trackers.length} third-party tracker(s) loaded`, score: REPORT.trackers.length >= 5 ? 'HIGH RISK' : 'FLAGGED', color: REPORT.trackers.length >= 5 ? '#FF6B00' : '#F5E642' });
  }
  if (violations) {
    findings.push({ label: `${violations} potential legal violation(s) mapped`, score: 'VIOLATION', color: '#FF003C' });
  }
  if (HAS_SCAN && !findings.length) {
    findings.push({ label: 'No dark patterns, trackers or violations found', score: 'CLEAR', color: '#39FF14' });
  }
  const grid = document.getElementById('ai-findings');
  findings.forEach((finding) => {
    const el = document.createElement('div');
    el.className = 'ai-finding';
    el.innerHTML = `<span class="ai-finding-label">${esc(finding.label)}</span><span class="ai-finding-score" style="color:${finding.color}">${esc(finding.score)}</span>`;
    grid.appendChild(el);
  });
}

function buildLegal() {
  const list = document.getElementById('legal-list');
  if (!REPORT.legalMappings.length) {
    list.innerHTML = emptyState(HAS_SCAN ? 'No legal violations were mapped for this page.' : 'No scan loaded.');
    return;
  }
  REPORT.legalMappings.forEach((mapping, index) => {
    const isViolation = mapping.risk === 'violation';
    const color = isViolation ? '#FF003C' : '#00F0FF';
    const card = document.createElement('div');
    card.className = 'legal-card';
    card.style.cssText = `background:${color}07;border:1px solid ${color}20;border-left:3px solid ${color}55;transition-delay:${index * 0.08}s`;
    const iconSvg = isViolation
      ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="#FF003C" stroke-width="1.5"/><line x1="15" y1="9" x2="9" y2="15" stroke="#FF003C" stroke-width="1.5" stroke-linecap="round"/><line x1="9" y1="9" x2="15" y2="15" stroke="#FF003C" stroke-width="1.5" stroke-linecap="round"/></svg>`
      : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="#00F0FF" stroke-width="1.5"/><line x1="12" y1="8" x2="12" y2="12" stroke="#00F0FF" stroke-width="1.5" stroke-linecap="round"/><circle cx="12" cy="16" r=".5" fill="#00F0FF" stroke="#00F0FF" stroke-width="1"/></svg>`;
    card.innerHTML = `
      <div class="legal-inner">
        <div class="legal-icon" style="background:${color}10;border-color:${color}2A">${iconSvg}</div>
        <div class="legal-meta">
          <div class="legal-tags">
            <span class="legal-section-label" style="color:${color}">${esc(mapping.section)}</span>
            <span class="legal-tag" style="color:${color};border-color:${color}44;background:${color}0F">${isViolation ? 'VIOLATION' : 'RISK FLAG'}</span>
          </div>
          <div class="legal-title" style="color:#EDF0F5">${esc(mapping.title)}</div>
          <p class="legal-desc" style="color:#8A9BB0">${esc(mapping.description)}</p>
        </div>
      </div>`;
    list.appendChild(card);
  });
}

function formatWallTimestamp(value) {
  if (!value) return 'N/A';
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return String(value);
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  const hh = String(dt.getHours()).padStart(2, '0');
  const mi = String(dt.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function toExternalUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '#';
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

function toDisplayUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'unknown-site';
  try {
    const parsed = /^https?:\/\//i.test(raw) ? new URL(raw) : new URL(`https://${raw}`);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return raw;
  }
}

function normalizeDetectedPatterns(patterns) {
  if (!Array.isArray(patterns)) return [];
  return patterns
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function shortTxHash(value) {
  return shortHex(value);
}

function shortAddress(value) {
  return shortHex(value);
}

function shortHex(value) {
  const tx = String(value || '').trim();
  if (!tx) return 'N/A';
  if (tx.length <= 18) return tx;
  return `${tx.slice(0, 10)}...${tx.slice(-8)}`;
}

function toSafeRiskScore(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(10, Number(parsed.toFixed(1))));
}

async function backendEndpoints(path) {
  const endpoints = [];
  if (window.location?.origin?.startsWith('http')) {
    endpoints.push(`${window.location.origin}${path}`);
  }

  if (chrome?.storage?.local) {
    const configured = await new Promise((resolve) => {
      chrome.storage.local.get([BACKEND_URL_KEY], (result) => {
        resolve(String(result?.[BACKEND_URL_KEY] || '').trim());
      });
    });
    if (configured) {
      endpoints.push(`${configured}${path}`);
    }
  }

  BACKEND_BASE_URLS.forEach((baseUrl) => {
    endpoints.push(`${baseUrl}${path}`);
  });

  return [...new Set(endpoints)];
}

async function requestBackend(path, { method = 'GET', body = null, timeoutMs = 8000 } = {}) {
  const endpoints = await backendEndpoints(path);
  let lastError = null;

  for (const endpoint of endpoints) {
    try {
      const requestInit = {
        method,
        headers: { 'Content-Type': 'application/json' },
        cache: method === 'GET' ? 'no-store' : 'default',
        body: body ? JSON.stringify(body) : undefined,
      };

      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' && timeoutMs > 0) {
        requestInit.signal = AbortSignal.timeout(timeoutMs);
      }

      const response = await fetch(endpoint, requestInit);
      if (!response.ok) {
        throw new Error(`Request failed (${response.status})`);
      }

      return await response.json();
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('Unable to reach backend API');
}

function buildReportSavePayload(analysis) {
  if (!analysis || typeof analysis !== 'object') return null;

  const url = String(analysis.url || '').trim();
  if (!url) return null;

  const privacyRisk = toSafeRiskScore(analysis?.privacy?.riskScore, 0);
  const manipulationRisk = toSafeRiskScore(analysis?.manipulation?.riskScore, 0);
  const fallbackOverall = Math.max(privacyRisk, manipulationRisk);
  const overallRisk = toSafeRiskScore(analysis?.overall?.riskScore, fallbackOverall);

  const patternNames = [...new Set(
    (Array.isArray(analysis?.manipulation?.patterns) ? analysis.manipulation.patterns : [])
      .map((pattern) => String(pattern?.name || pattern?.type || '').trim())
      .filter(Boolean)
  )];

  const trackerCount = Array.isArray(analysis?.privacy?.trackers)
    ? analysis.privacy.trackers.length
    : 0;

  return {
    url,
    domain: String(analysis.domain || '').trim() || null,
    privacy_risk: privacyRisk,
    manipulation_risk: manipulationRisk,
    overall_risk: overallRisk,
    pattern_names: patternNames,
    tracker_count: trackerCount,
    combined_insight: String(analysis.aiInsight || analysis?.overall?.insight || '').trim() || null,
    anchor_on_save: true,
  };
}

async function persistCurrentReportToBackend() {
  const payload = buildReportSavePayload(LAST_ANALYSIS);
  if (!payload) return;

  try {
    await requestBackend('/reports/save', {
      method: 'POST',
      body: payload,
      timeoutMs: 12000,
    });
  } catch (error) {
    console.warn('[ConsumerShield] Could not persist report before wall-of-shame render', error);
  }
}

async function fetchWallOfShame() {
  const payload = await requestBackend('/wall-of-shame', { timeoutMs: 9000 });
  if (Array.isArray(payload)) {
    return payload;
  }
  throw new Error('Wall of Shame response is not an array');
}

function mapWallOfShameRow(row) {
  const detectedPatterns = normalizeDetectedPatterns(row?.detected_patterns);
  const riskScore = Number(row?.risk_score || 0);
  const rawUrl = String(row?.url || '').trim();
  const blockchainTxHash = String(row?.blockchain_tx_hash || row?.tx_hash || '').trim() || null;
  const contractAddress = String(row?.contract_address || row?.contractAddress || '').trim() || null;

  return {
    url: toDisplayUrl(rawUrl),
    href: toExternalUrl(rawUrl),
    riskScore: Number.isFinite(riskScore) ? riskScore : 0,
    darkPatterns: detectedPatterns,
    timestamp: formatWallTimestamp(row?.timestamp),
    blockchainTxHash,
    blockchainProof: Boolean(row?.blockchain_proof),
    contractAddress,
  };
}

async function buildWallOfShame() {
  const grid = document.getElementById('top-five-grid');
  const list = document.getElementById('full-shame-list');
  if (!grid || !list) return;

  grid.innerHTML = '';
  list.innerHTML = '<div class="shame-row visible" style="grid-template-columns:1fr">Loading wall of shame data...</div>';

  let wallData = [];
  try {
    const apiRows = await fetchWallOfShame();
    wallData = apiRows
      .map(mapWallOfShameRow)
      .filter((item) => item.riskScore >= 7)
      .sort((a, b) => b.riskScore - a.riskScore);
  } catch (error) {
    console.warn('[ConsumerShield] Failed to load /wall-of-shame', error);
    list.innerHTML = '<div class="shame-row visible" style="grid-template-columns:1fr">Unable to load wall data from backend.</div>';
    return;
  }

  REPORT.wallOfShame = wallData;
  grid.innerHTML = '';
  list.innerHTML = '';

  if (!wallData.length) {
    list.innerHTML = '<div class="shame-row visible" style="grid-template-columns:1fr">No reports with risk score >= 7 yet.</div>';
    return;
  }

  wallData.slice(0, 5).forEach((site, index) => {
    const card = document.createElement('div');
    card.className = 'top-five-card';
    card.style.transitionDelay = `${index * 0.08}s`;
    const txLabel = site.blockchainTxHash
      ? `Tx: ${shortTxHash(site.blockchainTxHash)}`
      : (site.blockchainProof ? 'Tx: anchored' : 'Tx: pending');
    const chainLabel = site.contractAddress
      ? `Contract: ${shortAddress(site.contractAddress)} · ${txLabel}`
      : txLabel;
    card.innerHTML = `
      <div class="top-five-rank">${index + 1}</div>
      <div class="top-five-content">
        <a href="${esc(site.href)}" target="_blank" rel="noopener noreferrer" class="top-five-url">${esc(site.url)}</a>
        <div class="top-five-meta">
          <div class="top-five-score">${site.riskScore.toFixed(1)}</div>
          <div class="top-five-reports">${esc(site.timestamp)}</div>
        </div>
        <div class="top-five-patterns">${site.darkPatterns.map((pattern) => `<span class="pattern-tag">${esc(pattern)}</span>`).join('')}</div>
          <div class="top-five-reports">${esc(chainLabel)}</div>
      </div>`;
    grid.appendChild(card);
  });

  wallData.forEach((site, index) => {
    const row = document.createElement('div');
    row.className = 'shame-row';
    row.style.transitionDelay = `${index * 0.04}s`;
    const txCellMain = site.blockchainTxHash
      ? `<a href="https://sepolia.etherscan.io/tx/${encodeURIComponent(site.blockchainTxHash)}" target="_blank" rel="noopener noreferrer">${esc(shortTxHash(site.blockchainTxHash))}</a>`
      : (site.blockchainProof ? 'anchored' : 'pending');
    const contractLine = site.contractAddress
      ? `<div style="margin-top:4px;font-size:11px;opacity:.78"><a href="https://sepolia.etherscan.io/address/${encodeURIComponent(site.contractAddress)}" target="_blank" rel="noopener noreferrer">contract ${esc(shortAddress(site.contractAddress))}</a></div>`
      : '';
    row.innerHTML = `
      <a href="${esc(site.href)}" target="_blank" rel="noopener noreferrer" class="shame-url">${esc(site.url)}</a>
      <div class="shame-score">${site.riskScore.toFixed(1)}</div>
      <div class="shame-patterns">${site.darkPatterns.map((pattern) => `<span class="shame-pattern-tag">${esc(pattern)}</span>`).join('')}</div>
      <div class="shame-date">${esc(site.timestamp)}</div>
      <div class="shame-tx">${txCellMain}${contractLine}</div>`;
    list.appendChild(row);
  });

  // The wall is rebuilt on every poll, so the new cards and rows have to be
  // registered for the reveal animation again or they stay invisible.
  observeReveal(grid.querySelectorAll('.top-five-card'));
  observeReveal(list.querySelectorAll('.shame-row'));
}

function initGauge() {
  const score = Math.min(10, Math.max(0, REPORT.securityScore));
  const cfg = scoreConfig(score);
  const radius = 110;
  const circumference = 2 * Math.PI * radius;

  const glow = document.getElementById('gauge-glow');
  glow.style.background = `radial-gradient(circle, ${cfg.glow} 0%, transparent 70%)`;

  const track = document.getElementById('gauge-track');
  track.setAttribute('stroke-dasharray', `${circumference * 0.75} ${circumference}`);

  const tickGroup = document.getElementById('gauge-ticks');
  for (let index = 0; index <= 10; index += 1) {
    const angle = (index / 10) * 0.75 * 2 * Math.PI;
    const x1 = 150 + (radius - 20) * Math.cos(angle);
    const y1 = 150 + (radius - 20) * Math.sin(angle);
    const x2 = 150 + (radius - 10) * Math.cos(angle);
    const y2 = 150 + (radius - 10) * Math.sin(angle);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x1);
    line.setAttribute('y1', y1);
    line.setAttribute('x2', x2);
    line.setAttribute('y2', y2);
    line.setAttribute('stroke', index % 5 === 0 ? 'rgba(245,230,66,.25)' : 'rgba(255,255,255,.07)');
    line.setAttribute('stroke-width', index % 5 === 0 ? 2.5 : 1.25);
    tickGroup.appendChild(line);
  }

  const arc = document.getElementById('gauge-arc');
  arc.setAttribute('stroke', cfg.color);
  arc.style.filter = `drop-shadow(0 0 6px ${cfg.color}) drop-shadow(0 0 12px ${cfg.glow})`;

  const scoreEl = document.getElementById('gauge-score-num');
  const riskEl = document.getElementById('gauge-risk-label');
  scoreEl.style.color = cfg.color;
  scoreEl.style.textShadow = `0 0 20px ${cfg.glow}, 0 0 40px ${cfg.glow}`;
  riskEl.textContent = cfg.level;
  riskEl.style.color = cfg.color;
  riskEl.style.borderColor = cfg.color;
  riskEl.style.background = `${cfg.color}18`;

  const duration = 1600;
  const start = performance.now();
  function tick(now) {
    const progress = Math.min(1, (now - start) / duration);
    const ease = 1 - Math.pow(1 - progress, 3);
    const current = score * ease;
    scoreEl.textContent = current.toFixed(1);
    arc.setAttribute('stroke-dasharray', `${circumference * (current / 10) * 0.75} ${circumference}`);
    if (progress < 1) requestAnimationFrame(tick);
    else scoreEl.textContent = String(score);
  }
  requestAnimationFrame(tick);
}

let REVEAL_OBSERVER = null;

function observeReveal(elements) {
  if (!REVEAL_OBSERVER) return; // initScrollReveal picks up everything rendered before it runs
  elements.forEach((el) => {
    if (!el.classList.contains('visible')) REVEAL_OBSERVER.observe(el);
  });
}

function initScrollReveal() {
  REVEAL_OBSERVER = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        REVEAL_OBSERVER.unobserve(entry.target);
      }
    });
  }, { threshold: 0.06 });
  observeReveal(document.querySelectorAll('.content-section,.dp-card,.tracker-row,.legal-card,.top-five-card,.shame-row'));

  const barObs = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        const bar = entry.target.querySelector('.tracker-bar-fill');
        if (bar) setTimeout(() => { bar.style.width = `${bar.dataset.w}%`; }, 200);
        barObs.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1 });
  document.querySelectorAll('.tracker-row').forEach((el) => barObs.observe(el));
}

function initExport() {
  const btn = document.getElementById('btn-export');
  const labelEl = document.getElementById('export-label');
  const iconDl = document.getElementById('export-icon-dl');
  const iconSpin = document.getElementById('export-icon-spin');
  const iconOk = document.getElementById('export-icon-ok');
  let busy = false;
  btn.addEventListener('click', () => {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    iconDl.style.display = 'none';
    iconSpin.style.display = 'inline';
    labelEl.textContent = 'Exporting…';
    const lines = [
      'ConsumerShield — Security Analysis Report',
      '==========================================',
      `Site      : ${REPORT.site}`,
      `Timestamp : ${REPORT.timestamp}`,
      `Score     : ${REPORT.securityScore} / 10`,
      '',
      'DARK PATTERNS',
      '─────────────',
      ...REPORT.darkPatterns.map((pattern) => `[${pattern.severity.toUpperCase()}] ${pattern.type}  (${pattern.dpdpRef})\n  ${pattern.description}`),
      '',
      'PRIVACY TRACKERS',
      '────────────────',
      ...REPORT.trackers.map((tracker) => `${tracker.name}  •  ${tracker.category}  •  Risk: ${tracker.risk.toUpperCase()}  •  ${tracker.requests} req`),
      '',
      'AI ANALYSIS',
      '───────────',
      REPORT.aiAnalysis,
      '',
      'LEGAL MAPPING  (DPDP Act 2023)',
      '──────────────────────────────',
      ...REPORT.legalMappings.map((mapping) => `${mapping.section}  ·  ${mapping.title}  [${mapping.risk.toUpperCase()}]\n  ${mapping.description}`),
      '',
      'Disclaimer: This report is generated by ConsumerShield AI for informational purposes only.',
    ];
    setTimeout(() => {
      const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `consumershield-${REPORT.site}-${Date.now()}.txt`;
      anchor.click();
      URL.revokeObjectURL(url);
      iconSpin.style.display = 'none';
      iconOk.style.display = 'inline';
      labelEl.textContent = 'Exported!';
      btn.disabled = false;
      setTimeout(() => {
        iconOk.style.display = 'none';
        iconDl.style.display = 'inline';
        labelEl.textContent = 'Export Report';
        busy = false;
      }, 2500);
    }, 600);
  });
}

function initRescan() {
  const button = document.getElementById('btn-rescan');
  if (!button) return;
  button.addEventListener('click', () => window.location.reload());
}

document.addEventListener('DOMContentLoaded', async () => {
  await hydrateReportFromStorage();
  await persistCurrentReportToBackend();
  document.getElementById('meta-site').textContent = REPORT.site;
  const statusNode = document.getElementById('analysis-status');
  if (statusNode) statusNode.textContent = HAS_SCAN ? 'Analysis Complete' : 'No scan loaded';
  document.getElementById('meta-time').textContent = REPORT.timestamp;
  buildStats();
  buildDarkPatterns();
  buildTrackers();
  buildAI();
  buildLegal();
  await buildWallOfShame();
  initGauge();
  initScrollReveal();
  initExport();
  initRescan();
  
  setInterval(async () => {
    console.log('[ConsumerShield] Polling wall of shame...');
    await buildWallOfShame();
  }, 30000);
});