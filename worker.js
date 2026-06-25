const PAYTO_ADDRESS = "0xa1ee7650d9214b4913fb775e9093491e56369f82";
const CDP_HOST = "api.cdp.coinbase.com";

const NETWORKS = [
  { network: "eip155:8453",  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", name: "Base" },
  { network: "eip155:1",     asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", name: "Ethereum" },
  { network: "eip155:137",   asset: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", name: "Polygon" },
  { network: "eip155:43114", asset: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", name: "Avalanche" },
  { network: "eip155:42161", asset: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", name: "Arbitrum" },
  { network: "eip155:10",    asset: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", name: "Optimism" },
  { network: "eip155:42220", asset: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", name: "Celo" },
  { network: "eip155:324",   asset: "0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4", name: "zkSync Era" },
  { network: "eip155:59144", asset: "0x176211869cA2b568f2A7D4EE941E073a821EE1ff", name: "Linea" },
  { network: "eip155:1329",  asset: "0x3894085Ef7Ff0f0aeDf52E2A2704928d1Ec074F1", name: "Sei" },
];

// Per-endpoint pricing: [base, surgeAfter1000]
const ENDPOINT_PRICES = {
  "/wallet-info":       [0.002, 0.003],
  "/scrape":            [0.002, 0.003],
  "/token-price":       [0.002, 0.003],
  "/gas-price":         [0.003, 0.004],
  "/forex-rates":       [0.003, 0.004],
  "/nft-metadata":      [0.003, 0.004],
  "/defi-yields":       [0.006, 0.007],
  "/carbon-footprint":  [0.006, 0.007],
  "/clinical-trials":   [0.006, 0.007],
  "/webhook-bridge":    [0.006, 0.007],
  "/contract-risk":     [0.015, 0.016],
  "/tx-explain":        [0.015, 0.016],
  "/company-lookup":    [0.015, 0.016],
  "/real-estate":       [0.015, 0.016],
  "/patent-search":     [0.015, 0.016],
  "/sanctions-check":   [0.025, 0.026],
  "/supply-chain-risk": [0.025, 0.026],
  "/court-records":     [0.025, 0.026],
};

// Cache TTLs in seconds
const CACHE_TTL = {
  "/wallet-info":       15,
  "/scrape":            60,
  "/token-price":       30,
  "/gas-price":         15,
  "/forex-rates":       3600,
  "/nft-metadata":      600,
  "/defi-yields":       300,
  "/carbon-footprint":  3600,
  "/clinical-trials":   3600,
  "/webhook-bridge":    0,
  "/contract-risk":     600,
  "/tx-explain":        600,
  "/company-lookup":    86400,
  "/real-estate":       86400,
  "/patent-search":     86400,
  "/sanctions-check":   300,
  "/supply-chain-risk": 3600,
  "/court-records":     3600,
};

function base64UrlEncode(bytes) {
  let str = btoa(String.fromCharCode(...bytes));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importEd25519Key(secretBase64) {
  const raw = Uint8Array.from(atob(secretBase64), c => c.charCodeAt(0));
  const seed = raw.slice(0, 32);
  const pkcs8Prefix = new Uint8Array([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]);
  const pkcs8 = new Uint8Array(pkcs8Prefix.length + seed.length);
  pkcs8.set(pkcs8Prefix, 0);
  pkcs8.set(seed, pkcs8Prefix.length);
  return crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
}

async function generateCdpJwt(env, method, path) {
  const key = await importEd25519Key(env.CDP_API_SECRET);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "EdDSA", kid: env.CDP_API_KEY_ID, typ: "JWT", nonce: crypto.randomUUID() };
  const payload = { sub: env.CDP_API_KEY_ID, iss: "cdp", aud: ["cdp_service"], nbf: now, exp: now + 120, uris: [`${method} ${CDP_HOST}${path}`] };
  const encHeader = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const encPayload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = `${encHeader}.${encPayload}`;
  const sigBuf = await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(signingInput));
  const encSig = base64UrlEncode(new Uint8Array(sigBuf));
  return `${signingInput}.${encSig}`;
}

function priceToAtomic(priceUSD) {
  return String(Math.round(priceUSD * 1e6));
}

async function getEndpointPrice(env, path) {
  const [base, surge] = ENDPOINT_PRICES[path] || [0.002, 0.003];
  const monthKey = new Date().toISOString().slice(0, 7);
  const counterKey = `counter:${path}:${monthKey}`;
  const countStr = await env.PRICE_CACHE.get(counterKey);
  const count = countStr ? parseInt(countStr) : 0;
  return { price: count >= 1000 ? surge : base, count, monthKey, counterKey };
}

async function incrementEndpointCounter(env, counterKey, count) {
  await env.PRICE_CACHE.put(counterKey, String(count + 1));
}

function buildAccepts(priceUSD) {
  const amount = priceToAtomic(priceUSD);
  return NETWORKS.map(n => ({
    scheme: "exact", network: n.network, amount, asset: n.asset,
    payTo: PAYTO_ADDRESS, maxTimeoutSeconds: 60,
    mimeType: "application/json", extra: { name: "USD Coin", version: "2" },
  }));
}

function paymentRequired(priceUSD, description, resourcePath, inputSchema) {
  const payload = {
    x402Version: 2,
    resource: { url: "https://johncross-data-api.johncrossugwuegede.workers.dev" + resourcePath, description, mimeType: "application/json" },
    extensions: { bazaar: { discoverable: true, category: "data", tags: ["api", "agents", "data"] } },
    accepts: buildAccepts(priceUSD),
  };
  const encoded = btoa(JSON.stringify(payload));
  return new Response(JSON.stringify(payload), {
    status: 402,
    headers: { "Content-Type": "application/json", "PAYMENT-REQUIRED": encoded },
  });
}

async function verifyAndSettle(env, paymentHeader, priceUSD) {
  const amount = priceToAtomic(priceUSD);
  let decoded;
  try {
    decoded = JSON.parse(decodeURIComponent(escape(atob(paymentHeader.replace(/-/g,"+").replace(/_/g,"/")))));
  } catch(e) {
    return { ok: false, detail: { error: "Could not decode payment header" } };
  }
  const paidNetwork = decoded?.payload?.authorization?.chainId ? `eip155:${decoded.payload.authorization.chainId}` : NETWORKS[0].network;
  const networkInfo = NETWORKS.find(n => n.network === paidNetwork) || NETWORKS[0];
  const paymentRequirements = { scheme: "exact", network: networkInfo.network, amount, asset: networkInfo.asset, payTo: PAYTO_ADDRESS, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } };
  const body = JSON.stringify({ x402Version: 1, paymentPayload: decoded, paymentRequirements });
  const verifyJwt = await generateCdpJwt(env, "POST", "/platform/v2/x402/verify");
  const verifyRes = await fetch(`https://${CDP_HOST}/platform/v2/x402/verify`, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${verifyJwt}` }, body });
  const verification = await verifyRes.json();
  if (!verification.isValid) return { ok: false, detail: verification };
  const settleJwt = await generateCdpJwt(env, "POST", "/platform/v2/x402/settle");
  const settleRes = await fetch(`https://${CDP_HOST}/platform/v2/x402/settle`, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${settleJwt}` }, body });
  const settlement = await settleRes.json();
  return { ok: true, settlement };
}

// ── CACHE HELPERS ──────────────────────────────────────────────
async function cacheGet(env, key) {
  try { const v = await env.PRICE_CACHE.get(key); return v ? JSON.parse(v) : null; } catch { return null; }
}
async function cacheSet(env, key, data, ttl) {
  if (ttl > 0) await env.PRICE_CACHE.put(key, JSON.stringify(data), { expirationTtl: ttl });
}

// ── FALLBACK FETCH ─────────────────────────────────────────────
async function tryFetch(urls) {
  for (const { url, options } of urls) {
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(5000) });
      if (res.ok) return await res.json();
    } catch { continue; }
  }
  return null;
}

function stripHtml(html) {
  return html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// ── ENDPOINT HANDLERS ──────────────────────────────────────────

async function handleGasPrice(url, env) {
  const cacheKey = `cache:/gas-price`;
  const cached = await cacheGet(env, cacheKey);
  if (cached) return { ...cached, _cached: true };

  const chains = [
    { name: "Base", rpc: "https://mainnet.base.org", chainId: "0x2105" },
    { name: "Ethereum", rpc: "https://eth.llamarpc.com", chainId: "0x1" },
    { name: "Polygon", rpc: "https://polygon.llamarpc.com", chainId: "0x89" },
    { name: "Arbitrum", rpc: "https://arbitrum.llamarpc.com", chainId: "0xa4b1" },
    { name: "Optimism", rpc: "https://optimism.llamarpc.com", chainId: "0xa" },
    { name: "Avalanche", rpc: "https://avalanche.public-rpc.com", chainId: "0xa86a" },
  ];

  const results = {};
  await Promise.allSettled(chains.map(async (chain) => {
    try {
      const res = await fetch(chain.rpc, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_gasPrice", params: [] }),
        signal: AbortSignal.timeout(4000)
      });
      const data = await res.json();
      if (data.result) {
        const gweiRaw = Number(BigInt(data.result)) / 1e9;
        results[chain.name] = { gwei: gweiRaw.toFixed(4), chainId: chain.chainId };
      }
    } catch { results[chain.name] = { error: "unavailable" }; }
  }));

  const out = { gasPrice: results, fetchedAt: new Date().toISOString() };
  await cacheSet(env, cacheKey, out, CACHE_TTL["/gas-price"]);
  return { ...out, _cached: false };
}

async function handleForexRates(url, env) {
  const base = (url.searchParams.get("base") || "USD").toUpperCase();
  const cacheKey = `cache:/forex-rates:${base}`;
  const cached = await cacheGet(env, cacheKey);
  if (cached) return { ...cached, _cached: true };

  const data = await tryFetch([
    { url: `https://api.frankfurter.app/latest?from=${base}` },
    { url: `https://open.er-api.com/v6/latest/${base}` },
  ]);

  if (!data) return null;
  const out = { base, rates: data.rates || data.conversion_rates, fetchedAt: new Date().toISOString() };
  await cacheSet(env, cacheKey, out, CACHE_TTL["/forex-rates"]);
  return { ...out, _cached: false };
}

async function handleNftMetadata(url, env) {
  const address = url.searchParams.get("address");
  const tokenId = url.searchParams.get("tokenId");
  const network = url.searchParams.get("network") || "ethereum";
  if (!address) return { error: "Provide ?address=0x..." };

  const cacheKey = `cache:/nft-metadata:${address}:${tokenId}:${network}`;
  const cached = await cacheGet(env, cacheKey);
  if (cached) return { ...cached, _cached: true };

  const chainMap = { ethereum: 1, polygon: 137, base: 8453, arbitrum: 42161 };
  const chainId = chainMap[network.toLowerCase()] || 1;

  const data = await tryFetch([
    { url: `https://api.covalenthq.com/v1/${chainId}/tokens/${address}/nft_metadata/${tokenId || 1}/` },
    { url: `https://metadata.ens.domains/mainnet/${address}/${tokenId || 1}` },
  ]);

  const out = { address, tokenId, network, metadata: data, fetchedAt: new Date().toISOString() };
  await cacheSet(env, cacheKey, out, CACHE_TTL["/nft-metadata"]);
  return { ...out, _cached: false };
}

async function handleDefiYields(url, env) {
  const protocol = (url.searchParams.get("protocol") || "").toLowerCase();
  const cacheKey = `cache:/defi-yields:${protocol}`;
  const cached = await cacheGet(env, cacheKey);
  if (cached) return { ...cached, _cached: true };

  const data = await tryFetch([{ url: "https://yields.llama.fi/pools" }]);
  if (!data) return null;

  let pools = data.data || [];
  if (protocol) pools = pools.filter(p => p.project?.toLowerCase().includes(protocol));
  pools = pools.slice(0, 20).map(p => ({
    protocol: p.project, chain: p.chain, symbol: p.symbol,
    apy: p.apy?.toFixed(2), tvlUsd: p.tvlUsd
  }));

  const out = { protocol: protocol || "all", topPools: pools, fetchedAt: new Date().toISOString() };
  await cacheSet(env, cacheKey, out, CACHE_TTL["/defi-yields"]);
  return { ...out, _cached: false };
}

async function handleCarbonFootprint(url, env) {
  const activity = url.searchParams.get("activity");
  const country = url.searchParams.get("country") || "US";
  if (!activity) return { error: "Provide ?activity=flying or driving or electricity" };

  const cacheKey = `cache:/carbon-footprint:${activity}:${country}`;
  const cached = await cacheGet(env, cacheKey);
  if (cached) return { ...cached, _cached: true };

  // Emission factors (kgCO2 per unit) — standard IPCC values, no API needed
  const factors = {
    flying: { factor: 0.255, unit: "per km per passenger", source: "IPCC" },
    driving: { factor: 0.171, unit: "per km (average car)", source: "IPCC" },
    electricity: { factor: 0.233, unit: "per kWh (global average)", source: "IEA" },
    beef: { factor: 27.0, unit: "per kg", source: "OurWorldInData" },
    chicken: { factor: 6.9, unit: "per kg", source: "OurWorldInData" },
    shipping: { factor: 0.089, unit: "per tonne-km", source: "IMO" },
  };

  const result = factors[activity.toLowerCase()] || { error: `Unknown activity. Try: ${Object.keys(factors).join(", ")}` };
  const out = { activity, country, co2: result, fetchedAt: new Date().toISOString() };
  await cacheSet(env, cacheKey, out, CACHE_TTL["/carbon-footprint"]);
  return { ...out, _cached: false };
}

async function handleClinicalTrials(url, env) {
  const condition = url.searchParams.get("condition");
  const status = url.searchParams.get("status") || "RECRUITING";
  if (!condition) return { error: "Provide ?condition=diabetes" };

  const cacheKey = `cache:/clinical-trials:${condition}:${status}`;
  const cached = await cacheGet(env, cacheKey);
  if (cached) return { ...cached, _cached: true };

  const data = await tryFetch([{
    url: `https://clinicaltrials.gov/api/v2/studies?query.cond=${encodeURIComponent(condition)}&filter.overallStatus=${status}&pageSize=10`,
    options: { headers: { "Accept": "application/json" } }
  }]);

  if (!data) return null;
  const studies = (data.studies || []).map(s => ({
    nctId: s.protocolSection?.identificationModule?.nctId,
    title: s.protocolSection?.identificationModule?.briefTitle,
    status: s.protocolSection?.statusModule?.overallStatus,
    phase: s.protocolSection?.designModule?.phases?.[0],
    sponsor: s.protocolSection?.sponsorCollaboratorsModule?.leadSponsor?.name,
  }));

  const out = { condition, status, count: studies.length, studies, fetchedAt: new Date().toISOString() };
  await cacheSet(env, cacheKey, out, CACHE_TTL["/clinical-trials"]);
  return { ...out, _cached: false };
}

async function handleContractRisk(url, env) {
  const address = url.searchParams.get("address");
  const chainId = url.searchParams.get("chainId") || "1";
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) return { error: "Provide valid ?address=0x..." };

  const cacheKey = `cache:/contract-risk:${chainId}:${address}`;
  const cached = await cacheGet(env, cacheKey);
  if (cached) return { ...cached, _cached: true };

  const [goplusData, honeypotData] = await Promise.allSettled([
    tryFetch([{ url: `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${address}` }]),
    tryFetch([{ url: `https://api.honeypot.is/v2/IsHoneypot?address=${address}` }]),
  ]);

  const goplus = goplusData.status === "fulfilled" ? goplusData.value : null;
  const honeypot = honeypotData.status === "fulfilled" ? honeypotData.value : null;
  const tokenData = goplus?.result?.[address.toLowerCase()] || {};

  const out = {
    address, chainId,
    risk: {
      isHoneypot: honeypot?.isHoneypot ?? tokenData.is_honeypot === "1",
      isOpenSource: tokenData.is_open_source === "1",
      isMintable: tokenData.is_mintable === "1",
      hasProxyContract: tokenData.is_proxy === "1",
      canTakeBackOwnership: tokenData.can_take_back_ownership === "1",
      buyTax: tokenData.buy_tax,
      sellTax: tokenData.sell_tax,
      holderCount: tokenData.holder_count,
      riskScore: honeypot?.riskLevel || "unknown",
    },
    fetchedAt: new Date().toISOString()
  };
  await cacheSet(env, cacheKey, out, CACHE_TTL["/contract-risk"]);
  return { ...out, _cached: false };
}

async function handleTxExplain(url, env) {
  const txHash = url.searchParams.get("txHash");
  const network = (url.searchParams.get("network") || "base").toLowerCase();
  if (!txHash || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) return { error: "Provide valid ?txHash=0x..." };

  const cacheKey = `cache:/tx-explain:${network}:${txHash}`;
  const cached = await cacheGet(env, cacheKey);
  if (cached) return { ...cached, _cached: true };

  const rpcMap = {
    base: "https://mainnet.base.org",
    ethereum: "https://eth.llamarpc.com",
    polygon: "https://polygon.llamarpc.com",
    arbitrum: "https://arbitrum.llamarpc.com",
    optimism: "https://optimism.llamarpc.com",
  };
  const rpc = rpcMap[network] || rpcMap.base;

  const [txRes, receiptRes] = await Promise.allSettled([
    fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionByHash", params: [txHash] }) }),
    fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_getTransactionReceipt", params: [txHash] }) }),
  ]);

  const tx = txRes.status === "fulfilled" ? (await txRes.value.json()).result : null;
  const receipt = receiptRes.status === "fulfilled" ? (await receiptRes.value.json()).result : null;

  if (!tx) return { error: "Transaction not found" };

  const valueETH = tx.value ? (Number(BigInt(tx.value)) / 1e18).toFixed(6) : "0";
  const gasUsed = receipt?.gasUsed ? parseInt(receipt.gasUsed, 16) : null;
  const status = receipt?.status === "0x1" ? "Success" : receipt?.status === "0x0" ? "Failed" : "Pending";
  const isContract = tx.input && tx.input !== "0x";

  let explanation = `Transaction on ${network}: `;
  if (!isContract) {
    explanation += `Sent ${valueETH} ETH from ${tx.from} to ${tx.to}.`;
  } else {
    explanation += `Contract interaction from ${tx.from} to contract ${tx.to}.`;
    if (valueETH !== "0") explanation += ` Included ${valueETH} ETH.`;
  }
  explanation += ` Status: ${status}.`;
  if (gasUsed) explanation += ` Gas used: ${gasUsed.toLocaleString()}.`;

  const out = { txHash, network, status, from: tx.from, to: tx.to, valueETH, gasUsed, isContractCall: isContract, explanation, fetchedAt: new Date().toISOString() };
  await cacheSet(env, cacheKey, out, CACHE_TTL["/tx-explain"]);
  return { ...out, _cached: false };
}

async function handleCompanyLookup(url, env) {
  const name = url.searchParams.get("name");
  const country = url.searchParams.get("country") || "";
  if (!name) return { error: "Provide ?name=company+name" };

  const cacheKey = `cache:/company-lookup:${name}:${country}`;
  const cached = await cacheGet(env, cacheKey);
  if (cached) return { ...cached, _cached: true };

  const q = country ? `${encodeURIComponent(name)}&jurisdiction_code=${country.toLowerCase()}` : encodeURIComponent(name);
  const data = await tryFetch([
    { url: `https://api.opencorporates.com/v0.4/companies/search?q=${q}&per_page=5` },
  ]);

  if (!data) return null;
  const companies = (data.results?.companies || []).map(c => c.company).map(c => ({
    name: c.name, jurisdiction: c.jurisdiction_code,
    companyNumber: c.company_number, status: c.current_status,
    incorporatedOn: c.incorporation_date, registeredAddress: c.registered_address_in_full,
    opencorporatesUrl: c.opencorporates_url,
  }));

  const out = { query: name, country: country || "global", results: companies, fetchedAt: new Date().toISOString() };
  await cacheSet(env, cacheKey, out, CACHE_TTL["/company-lookup"]);
  return { ...out, _cached: false };
}

async function handleRealEstate(url, env) {
  const address = url.searchParams.get("address");
  if (!address) return { error: "Provide ?address=123+Main+St+New+York" };

  const cacheKey = `cache:/real-estate:${address}`;
  const cached = await cacheGet(env, cacheKey);
  if (cached) return { ...cached, _cached: true };

  const data = await tryFetch([{
    url: `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&addressdetails=1&limit=3`,
    options: { headers: { "User-Agent": "JSey-DataAPI/1.0 (contact: johncrossugwuegede@gmail.com)" } }
  }]);

  if (!data || !data.length) return { error: "Address not found" };
  const place = data[0];

  const out = {
    query: address,
    found: {
      displayName: place.display_name,
      lat: place.lat, lon: place.lon,
      type: place.type, class: place.class,
      address: place.address,
      osmId: place.osm_id,
    },
    note: "Property valuation data requires a regional data provider. Location data confirmed.",
    fetchedAt: new Date().toISOString()
  };
  await cacheSet(env, cacheKey, out, CACHE_TTL["/real-estate"]);
  return { ...out, _cached: false };
}

async function handlePatentSearch(url, env) {
  const query = url.searchParams.get("query");
  const inventor = url.searchParams.get("inventor") || "";
  const assignee = url.searchParams.get("assignee") || "";
  if (!query && !inventor && !assignee) return { error: "Provide ?query=solar+panel or ?inventor=tesla or ?assignee=apple" };

  const cacheKey = `cache:/patent-search:${query}:${inventor}:${assignee}`;
  const cached = await cacheGet(env, cacheKey);
  if (cached) return { ...cached, _cached: true };

  let q = {};
  if (query) q._text_any = { patent_title: query, patent_abstract: query };
  if (inventor) q.inventor_last_name = inventor;
  if (assignee) q.assignee_organization = assignee;

  const data = await tryFetch([{
    url: `https://api.patentsview.org/patents/query?q=${encodeURIComponent(JSON.stringify(q))}&f=["patent_number","patent_title","patent_date","inventor_last_name","assignee_organization"]&o={"per_page":10}`,
    options: { headers: { "Accept": "application/json" } }
  }]);

  if (!data) return null;
  const out = { query: query || inventor || assignee, count: data.total_patent_count || 0, patents: data.patents || [], fetchedAt: new Date().toISOString() };
  await cacheSet(env, cacheKey, out, CACHE_TTL["/patent-search"]);
  return { ...out, _cached: false };
}

async function handleSanctionsCheck(url, env) {
  const name = url.searchParams.get("name");
  if (!name) return { error: "Provide ?name=person+or+company+name" };

  const cacheKey = `cache:/sanctions-check:${name.toLowerCase()}`;
  const cached = await cacheGet(env, cacheKey);
  if (cached) return { ...cached, _cached: true };

  const data = await tryFetch([
    { url: `https://api.opensanctions.org/search?q=${encodeURIComponent(name)}&limit=5`, options: { headers: { "Accept": "application/json" } } },
  ]);

  if (!data) return null;
  const results = (data.results || []).map(r => ({
    name: r.caption, score: r.score,
    schema: r.schema, datasets: r.datasets,
    sanctionedBy: r.properties?.program || [],
    countries: r.properties?.country || [],
    birthDate: r.properties?.birthDate?.[0] || null,
  }));

  const out = {
    query: name,
    sanctionsFound: results.length > 0,
    matchCount: results.length,
    matches: results,
    disclaimer: "For compliance purposes only. Always verify with official sources.",
    fetchedAt: new Date().toISOString()
  };
  await cacheSet(env, cacheKey, out, CACHE_TTL["/sanctions-check"]);
  return { ...out, _cached: false };
}

async function handleSupplyChainRisk(url, env) {
  const company = url.searchParams.get("company");
  const country = url.searchParams.get("country") || "";
  if (!company) return { error: "Provide ?company=company+name" };

  const cacheKey = `cache:/supply-chain-risk:${company}:${country}`;
  const cached = await cacheGet(env, cacheKey);
  if (cached) return { ...cached, _cached: true };

  const [sanctionsData, corporateData] = await Promise.allSettled([
    tryFetch([{ url: `https://api.opensanctions.org/search?q=${encodeURIComponent(company)}&limit=3`, options: { headers: { "Accept": "application/json" } } }]),
    tryFetch([{ url: `https://api.opencorporates.com/v0.4/companies/search?q=${encodeURIComponent(company)}&per_page=3` }]),
  ]);

  const sanctions = sanctionsData.status === "fulfilled" ? sanctionsData.value : null;
  const corporate = corporateData.status === "fulfilled" ? corporateData.value : null;

  const sanctionHits = sanctions?.results?.length || 0;
  const companyFound = corporate?.results?.companies?.length || 0;
  const riskScore = sanctionHits > 0 ? "HIGH" : companyFound === 0 ? "MEDIUM" : "LOW";

  const out = {
    company, country: country || "global",
    riskScore,
    factors: {
      sanctionsExposure: sanctionHits > 0,
      sanctionHits,
      registeredCompaniesFound: companyFound,
      geopoliticalRisk: country ? "Check country-specific advisories" : "Unknown",
    },
    recommendation: riskScore === "HIGH" ? "Do not engage without legal review." : riskScore === "MEDIUM" ? "Proceed with caution. Request documentation." : "Low risk. Standard due diligence applies.",
    fetchedAt: new Date().toISOString()
  };
  await cacheSet(env, cacheKey, out, CACHE_TTL["/supply-chain-risk"]);
  return { ...out, _cached: false };
}

async function handleCourtRecords(url, env) {
  const query = url.searchParams.get("query");
  const court = url.searchParams.get("court") || "";
  if (!query) return { error: "Provide ?query=case+name+or+party" };

  const cacheKey = `cache:/court-records:${query}:${court}`;
  const cached = await cacheGet(env, cacheKey);
  if (cached) return { ...cached, _cached: true };

  const courtParam = court ? `&court=${encodeURIComponent(court)}` : "";
  const data = await tryFetch([{
    url: `https://www.courtlistener.com/api/rest/v4/dockets/?q=${encodeURIComponent(query)}${courtParam}&page_size=10`,
    options: { headers: { "Accept": "application/json" } }
  }]);

  if (!data) return null;
  const cases = (data.results || []).map(c => ({
    caseName: c.case_name, docketNumber: c.docket_number,
    court: c.court, dateFiled: c.date_filed,
    dateTerminated: c.date_terminated, causeOfAction: c.cause,
    url: `https://www.courtlistener.com${c.absolute_url}`,
  }));

  const out = { query, court: court || "all", count: data.count || 0, cases, fetchedAt: new Date().toISOString() };
  await cacheSet(env, cacheKey, out, CACHE_TTL["/court-records"]);
  return { ...out, _cached: false };
}

async function handleWebhookBridge(url, env, request) {
  // Register: POST /webhook-bridge?action=register&callbackUrl=https://...
  // Trigger:  POST /webhook-bridge?action=trigger&webhookId=xxx
  const action = url.searchParams.get("action") || "info";

  if (action === "register") {
    const callbackUrl = url.searchParams.get("callbackUrl");
    if (!callbackUrl) return { error: "Provide ?callbackUrl=https://your-endpoint.com" };
    const webhookId = crypto.randomUUID();
    await env.PRICE_CACHE.put(`webhook:${webhookId}`, JSON.stringify({ callbackUrl, createdAt: new Date().toISOString() }), { expirationTtl: 2592000 });
    return { webhookId, callbackUrl, triggerUrl: `https://johncross-data-api.johncrossugwuegede.workers.dev/webhook-bridge?action=trigger&webhookId=${webhookId}`, message: "Webhook registered. Share the triggerUrl. Each trigger costs $0.006." };
  }

  if (action === "trigger") {
    const webhookId = url.searchParams.get("webhookId");
    if (!webhookId) return { error: "Provide ?webhookId=xxx" };
    const stored = await env.PRICE_CACHE.get(`webhook:${webhookId}`);
    if (!stored) return { error: "Webhook not found or expired" };
    const { callbackUrl } = JSON.parse(stored);
    let body = {};
    try { if (request.method === "POST") body = await request.json(); } catch {}
    const triggerRes = await fetch(callbackUrl, { method: "POST", headers: { "Content-Type": "application/json", "X-Webhook-Id": webhookId }, body: JSON.stringify({ ...body, triggeredAt: new Date().toISOString() }) });
    return { webhookId, callbackUrl, triggered: true, callbackStatus: triggerRes.status, triggeredAt: new Date().toISOString() };
  }

  return { service: "Webhook Bridge", usage: "Register a webhook URL, get paid $0.006 each time it's triggered. Actions: register, trigger" };
}

// ── MAIN HANDLER ───────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const paymentHeader = request.headers.get("payment-signature") || request.headers.get("x-payment");

    // ── STATIC ROUTES ──
    if (path === "/favicon.ico" || path === "/favicon.png") {
      const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAABtElEQVR4nO1b27LCIAwExy+s33n8RXyoOKcpl5CGJhD2SZ1Kd5dNaKt4dxe2EJqOf3vfickB/U7SKriGTobwD8otHILZCL7BeguHYDLi+iB3C4e4aAT9y9LCIYhGPEgn0ybeOTKndgM0io8gcMPHRrPwFJAlgUvAaOKdQ3OuGzCi+AgEd1oTnAhlA0ae/YiKhrwBM4iPKGhJd8qK+PB3jY9/8Y2VGzeJxMqwesDpk5miD5HQthJweDfz7EcAjeYT8Py9Epr9aucGYFk1thDiivCsHduCVjEasJeAhdqH+Go23wOWAdIEpPEwWf8RWwgrAdIEpMF6HYC9SNF0vWA+AeYNYC0BLHKlIlEa5hOwDJAmIA1SD8DWKucT314wn4D9OXmn+4G7E9C8iry9N5+AZYA0AWnsBtz0r0xV+Go2n4DjzCNXA63rO3oV+Jd4kZshvc8DLPQCoNF8DzgbMHMK1j9EzkgbMGMKMprKQmf50aQwoeUSmCEJFQ2rB1SPGDkFCO64BIxoApJzuzDtjbFxstp7gOY0ELjRmqBGE4ic1rY5Lh52N05CmN06C2F283QOSrfPfwAr5YQUC+rGvgAAAABJRU5ErkJggg=="), c => c.charCodeAt(0));
      return new Response(png, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } });
    }

    if (path === "/") {
      const { price, count } = await getEndpointPrice(env, "/wallet-info");
      return Response.json({
        business: "J-sey", brand: "johncross.base.eth", status: "running",
        facilitator: "CDP (Bazaar-listed)", currentBasePrice: `$${price}`,
        callsThisMonth: count, supportedNetworks: NETWORKS.map(n => n.name),
        endpoints: Object.keys(ENDPOINT_PRICES),
      });
    }

    if (path === "/openapi.json") {
      return Response.json({
        openapi: "3.0.0",
        info: { title: "J-sey Data API", description: "18-endpoint pay-per-call API. USDC on 10 EVM networks via x402.", version: "2.0.0", contact: { email: "johncrossugwuegede@gmail.com" } },
        servers: [{ url: "https://johncross-data-api.johncrossugwuegede.workers.dev" }],
      });
    }

    if (path === "/.well-known/x402") {
      return Response.json({
        x402Version: 2, name: "J-sey",
        description: "18-endpoint pay-per-call data API. USDC on 10 EVM networks.",
        supportedNetworks: NETWORKS.map(n => ({ name: n.name, network: n.network })),
        resources: Object.entries(ENDPOINT_PRICES).map(([ep, [base]]) => ({
          resource: ep, method: "GET", price: `$${base}`
        })),
      });
    }

    // ── PAID ROUTES ──
    if (!ENDPOINT_PRICES[path]) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const { price, count, monthKey, counterKey } = await getEndpointPrice(env, path);

    if (!paymentHeader) {
      const inputSchemas = {
        "/wallet-info":       { type: "object", properties: { address: { type: "string", description: "0x wallet address", example: "0xa1ee..." } }, required: ["address"] },
        "/scrape":            { type: "object", properties: { url: { type: "string", description: "URL to scrape", example: "https://example.com" } }, required: ["url"] },
        "/token-price":       { type: "object", properties: { symbol: { type: "string", description: "CoinGecko id", example: "bitcoin" } }, required: ["symbol"] },
        "/gas-price":         { type: "object", properties: {} },
        "/forex-rates":       { type: "object", properties: { base: { type: "string", description: "Base currency", example: "USD" } } },
        "/nft-metadata":      { type: "object", properties: { address: { type: "string" }, tokenId: { type: "string" }, network: { type: "string" } }, required: ["address"] },
        "/defi-yields":       { type: "object", properties: { protocol: { type: "string", description: "Protocol name", example: "aave" } } },
        "/carbon-footprint":  { type: "object", properties: { activity: { type: "string", description: "flying|driving|electricity|beef|chicken|shipping", example: "flying" }, country: { type: "string" } }, required: ["activity"] },
        "/clinical-trials":   { type: "object", properties: { condition: { type: "string", example: "diabetes" }, status: { type: "string", example: "RECRUITING" } }, required: ["condition"] },
        "/webhook-bridge":    { type: "object", properties: { action: { type: "string", description: "register|trigger" }, callbackUrl: { type: "string" }, webhookId: { type: "string" } } },
        "/contract-risk":     { type: "object", properties: { address: { type: "string" }, chainId: { type: "string", example: "1" } }, required: ["address"] },
        "/tx-explain":        { type: "object", properties: { txHash: { type: "string" }, network: { type: "string", example: "base" } }, required: ["txHash"] },
        "/company-lookup":    { type: "object", properties: { name: { type: "string" }, country: { type: "string", description: "ISO 2-letter code" } }, required: ["name"] },
        "/real-estate":       { type: "object", properties: { address: { type: "string", example: "123 Main St New York" } }, required: ["address"] },
        "/patent-search":     { type: "object", properties: { query: { type: "string" }, inventor: { type: "string" }, assignee: { type: "string" } } },
        "/sanctions-check":   { type: "object", properties: { name: { type: "string", description: "Person or company name" } }, required: ["name"] },
        "/supply-chain-risk": { type: "object", properties: { company: { type: "string" }, country: { type: "string" } }, required: ["company"] },
        "/court-records":     { type: "object", properties: { query: { type: "string" }, court: { type: "string" } }, required: ["query"] },
      };
      return paymentRequired(price, path, path + url.search, inputSchemas[path]);
    }

    // Verify payment
    let result;
    try { result = await verifyAndSettle(env, paymentHeader, price); }
    catch (err) { return Response.json({ error: "Payment processing error", details: String(err) }, { status: 500 }); }
    if (!result.ok) return Response.json({ error: "Payment verification failed", details: result.detail }, { status: 402 });

    await incrementEndpointCounter(env, counterKey, count);

    // Route to handler
    let data;
    try {
      if (path === "/wallet-info") {
        const address = url.searchParams.get("address");
        if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) return Response.json({ error: "Provide valid ?address=0x..." }, { status: 400 });
        const cacheKey = `cache:/wallet-info:${address}`;
        const cached = await cacheGet(env, cacheKey);
        if (cached) return Response.json({ ...cached, _cached: true });
        const rpcRes = await fetch("https://mainnet.base.org", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }, { jsonrpc: "2.0", id: 2, method: "eth_getTransactionCount", params: [address, "latest"] }]) });
        const [balRes, txRes] = await rpcRes.json();
        const balanceETH = (Number(BigInt(balRes.result)) / 1e18).toString();
        const txCount = parseInt(txRes.result, 16);
        data = { address, network: "base", balanceETH, transactionCount: txCount };
        await cacheSet(env, cacheKey, data, CACHE_TTL["/wallet-info"]);
        return Response.json({ ...data, _cached: false });
      }

      if (path === "/scrape") {
        const targetUrl = url.searchParams.get("url");
        if (!targetUrl || !/^https?:\/\//.test(targetUrl)) return Response.json({ error: "Provide valid ?url=https://..." }, { status: 400 });
        const cacheKey = `cache:/scrape:${targetUrl}`;
        const cached = await cacheGet(env, cacheKey);
        if (cached) return Response.json({ ...cached, _cached: true });
        const pageRes = await fetch(targetUrl, { headers: { "User-Agent": "Mozilla/5.0 (compatible; x402-scrape-bot/1.0)" } });
        const html = await pageRes.text();
        const cleanText = stripHtml(html).slice(0, 5000);
        data = { url: targetUrl, contentLength: cleanText.length, text: cleanText };
        await cacheSet(env, cacheKey, data, CACHE_TTL["/scrape"]);
        return Response.json({ ...data, _cached: false });
      }

      if (path === "/token-price") {
        const symbol = (url.searchParams.get("symbol") || "").toLowerCase();
        if (!symbol) return Response.json({ error: "Provide ?symbol=bitcoin" }, { status: 400 });
        const cacheKey = `cache:/token-price:${symbol}`;
        const cached = await cacheGet(env, cacheKey);
        if (cached) return Response.json({ ...cached, _cached: true });
        const symbolMap = { bitcoin: "BTC", ethereum: "ETH", solana: "SOL", cardano: "ADA", ripple: "XRP", dogecoin: "DOGE", litecoin: "LTC" };
        const ticker = symbolMap[symbol];
        let priceUSD = null, source = null;
        if (ticker) {
          try {
            const cbRes = await fetch(`https://api.coinbase.com/v2/prices/${ticker}-USD/spot`);
            const cbData = await cbRes.json();
            if (cbData.data?.amount) { priceUSD = parseFloat(cbData.data.amount); source = "coinbase"; }
          } catch {}
        }
        if (!priceUSD) {
          try {
            const cgRes = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${symbol}&vs_currencies=usd`, { headers: { "User-Agent": "JSeyEnterprises-DataAPI/1.0" } });
            const cgData = await cgRes.json();
            if (cgData[symbol]?.usd) { priceUSD = cgData[symbol].usd; source = "coingecko"; }
          } catch {}
        }
        if (!priceUSD) return Response.json({ error: `No price found for '${symbol}'` }, { status: 404 });
        data = { symbol, priceUSD, fetchedAt: new Date().toISOString(), source };
        await cacheSet(env, cacheKey, data, CACHE_TTL["/token-price"]);
        return Response.json({ ...data, _cached: false });
      }

      if (path === "/gas-price")         data = await handleGasPrice(url, env);
      if (path === "/forex-rates")        data = await handleForexRates(url, env);
      if (path === "/nft-metadata")       data = await handleNftMetadata(url, env);
      if (path === "/defi-yields")        data = await handleDefiYields(url, env);
      if (path === "/carbon-footprint")   data = await handleCarbonFootprint(url, env);
      if (path === "/clinical-trials")    data = await handleClinicalTrials(url, env);
      if (path === "/webhook-bridge")     data = await handleWebhookBridge(url, env, request);
      if (path === "/contract-risk")      data = await handleContractRisk(url, env);
      if (path === "/tx-explain")         data = await handleTxExplain(url, env);
      if (path === "/company-lookup")     data = await handleCompanyLookup(url, env);
      if (path === "/real-estate")        data = await handleRealEstate(url, env);
      if (path === "/patent-search")      data = await handlePatentSearch(url, env);
      if (path === "/sanctions-check")    data = await handleSanctionsCheck(url, env);
      if (path === "/supply-chain-risk")  data = await handleSupplyChainRisk(url, env);
      if (path === "/court-records")      data = await handleCourtRecords(url, env);

      if (!data) return Response.json({ error: "All providers unavailable. Retry in 15s.", owner_wallet_touched: false }, { status: 503 });
      return Response.json(data);

    } catch (err) {
      return Response.json({ error: "Internal error", details: String(err) }, { status: 500 });
    }
  },
};
