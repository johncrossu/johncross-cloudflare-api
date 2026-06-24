const PAYTO_ADDRESS = "0xa1ee7650d9214b4913fb775e9093491e56369f82";
const FACILITATOR_URL = "https://x402.org/facilitator";
const NETWORK = "eip155:8453";
const BRAND = "johncross.base.eth / J-sey Enterprises";

function paymentRequired(price, description, resourcePath) {
  return new Response(JSON.stringify({
    x402Version: 1,
    accepts: [{ scheme: "exact", network: NETWORK, maxAmountRequired: price, resource: resourcePath, description, payTo: PAYTO_ADDRESS, asset: "USDC", brand: BRAND }],
  }), { status: 402, headers: { "Content-Type": "application/json" } });
}

async function verifyAndSettle(paymentHeader, price) {
  const verifyRes = await fetch(`${FACILITATOR_URL}/verify`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paymentHeader, paymentRequirements: { scheme: "exact", network: NETWORK, payTo: PAYTO_ADDRESS, maxAmountRequired: price } }),
  });
  const verification = await verifyRes.json();
  if (!verification.isValid) return false;
  await fetch(`${FACILITATOR_URL}/settle`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paymentHeader }) });
  return true;
}

function stripHtml(html) {
  return html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const paymentHeader = request.headers.get("x-payment");

    if (path === "/") {
      return Response.json({ business: "J-sey Enterprises", brand: "johncross.base.eth", status: "running", endpoints: ["/wallet-info", "/scrape", "/token-price"] });
    }

    if (path === "/wallet-info") {
      const price = "$0.002";
      if (!paymentHeader) return paymentRequired(price, "Base wallet balance + tx count", path + url.search);
      if (!(await verifyAndSettle(paymentHeader, price))) return Response.json({ error: "Payment verification failed" }, { status: 402 });
      const address = url.searchParams.get("address");
      if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) return Response.json({ error: "Provide a valid ?address=0x..." }, { status: 400 });
      try {
        const rpcRes = await fetch("https://mainnet.base.org", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify([
            { jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] },
            { jsonrpc: "2.0", id: 2, method: "eth_getTransactionCount", params: [address, "latest"] },
          ]),
        });
        const [balRes, txRes] = await rpcRes.json();
        const balanceWei = BigInt(balRes.result);
        const balanceETH = (Number(balanceWei) / 1e18).toString();
        const txCount = parseInt(txRes.result, 16);
        return Response.json({ address, network: "base", balanceETH, transactionCount: txCount });
      } catch (err) { return Response.json({ error: "Failed to fetch wallet info", details: String(err) }, { status: 500 }); }
    }

    if (path === "/scrape") {
      const price = "$0.002";
      if (!paymentHeader) return paymentRequired(price, "Clean text scrape of a webpage", path + url.search);
      if (!(await verifyAndSettle(paymentHeader, price))) return Response.json({ error: "Payment verification failed" }, { status: 402 });
      const targetUrl = url.searchParams.get("url");
      if (!targetUrl || !/^https?:\/\//.test(targetUrl)) return Response.json({ error: "Provide a valid ?url=https://..." }, { status: 400 });
      try {
        const pageRes = await fetch(targetUrl, { headers: { "User-Agent": "Mozilla/5.0 (compatible; x402-scrape-bot/1.0)" } });
        const html = await pageRes.text();
        const cleanText = stripHtml(html).slice(0, 5000);
        return Response.json({ url: targetUrl, contentLength: cleanText.length, text: cleanText });
      } catch (err) { return Response.json({ error: "Failed to scrape page", details: String(err) }, { status: 500 }); }
    }

    if (path === "/token-price") {
      const price = "$0.002";
      if (!paymentHeader) return paymentRequired(price, "Live token price in USD", path + url.search);
      if (!(await verifyAndSettle(paymentHeader, price))) return Response.json({ error: "Payment verification failed" }, { status: 402 });
      const symbol = (url.searchParams.get("symbol") || "").toLowerCase();
      if (!symbol) return Response.json({ error: "Provide a ?symbol=bitcoin" }, { status: 400 });
      try {
        const cgRes = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${symbol}&vs_currencies=usd`);
        const data = await cgRes.json();
        if (!data[symbol]) return Response.json({ error: `No price found for '${symbol}'` }, { status: 404 });
        return Response.json({ symbol, priceUSD: data[symbol].usd, fetchedAt: new Date().toISOString() });
      } catch (err) { return Response.json({ error: "Failed to fetch price", details: String(err) }, { status: 500 }); }
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
};
