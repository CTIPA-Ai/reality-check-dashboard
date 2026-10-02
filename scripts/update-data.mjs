// Fetches live figures and writes data/dashboard.json.
// Runs in GitHub Actions on a schedule. Node 20+, no dependencies.
//
// Sources
//   Gas price  -> AAA national average (gasprices.aaa.com), fallback: EIA weekly (needs EIA_API_KEY secret)
//   Inflation  -> BLS CPI-U All Items (CUUR0000SA0), 12-month % change. Optional BLS_API_KEY secret.
//   Debt       -> U.S. Treasury FiscalData "Debt to the Penny" (no key)
//
// If a source fails, the previous value is kept so the widget never goes blank.

import { readFile, writeFile } from "node:fs/promises";

const OUT = "data/dashboard.json";
const UA = "Mozilla/5.0 (compatible; RealityCheckDashboard/1.0; +https://github.com)";

const config = JSON.parse(await readFile("config.json", "utf8"));
let prev = {};
try { prev = JSON.parse(await readFile(OUT, "utf8")); } catch {}

async function getText(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { "User-Agent": UA, ...(opts.headers || {}) } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}
const getJSON = async (url, opts) => JSON.parse(await getText(url, opts));

// ---------- Gas ----------
async function gasFromAAA() {
  const html = await getText("https://gasprices.aaa.com/");
  const price = html.match(/National Average\s*\$?\s*([0-9]+\.[0-9]{2,4})/i)
             || html.match(/class="numb">\s*\$([0-9]+\.[0-9]{2,4})/i);
  if (!price) throw new Error("AAA: price not found");
  const asOf = html.match(/Price as of\s*(?:<br>)?\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})/i);
  let date = null;
  if (asOf) {
    const y = asOf[3].length === 2 ? "20" + asOf[3] : asOf[3];
    date = `${y}-${asOf[1].padStart(2, "0")}-${asOf[2].padStart(2, "0")}`;
  }
  return { value: Number(price[1]), asOf: date, source: "AAA National Average", url: "https://gasprices.aaa.com/" };
}

async function gasFromEIA() {
  const key = process.env.EIA_API_KEY;
  if (!key) throw new Error("EIA: no EIA_API_KEY");
  const url = "https://api.eia.gov/v2/petroleum/pri/gnd/data/?frequency=weekly&data[0]=value"
    + "&facets[series][]=EMM_EPMR_PTE_NUS_DPG&sort[0][column]=period&sort[0][direction]=desc&length=1"
    + `&api_key=${encodeURIComponent(key)}`;
  const j = await getJSON(url);
  const row = j?.response?.data?.[0];
  if (!row) throw new Error("EIA: no data");
  return { value: Number(row.value), asOf: row.period, source: "EIA weekly U.S. regular", url: "https://www.eia.gov/petroleum/gasdiesel/" };
}

// ---------- Inflation ----------
async function inflationFromBLS() {
  const key = process.env.BLS_API_KEY;
  const url = key ? "https://api.bls.gov/publicAPI/v2/timeseries/data/" : "https://api.bls.gov/publicAPI/v1/timeseries/data/";
  const year = new Date().getUTCFullYear();
  const body = { seriesid: ["CUUR0000SA0"], startyear: String(year - 1), endyear: String(year) };
  if (key) body.registrationkey = key;
  const j = await getJSON(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const rows = j?.Results?.series?.[0]?.data;
  if (!rows?.length) throw new Error("BLS: " + (j?.message?.join(" ") || "no data"));
  const monthly = rows.filter(r => /^M(0[1-9]|1[0-2])$/.test(r.period) && r.value !== "-");
  const latest = monthly[0]; // BLS returns newest first
  const yearAgo = monthly.find(r => r.period === latest.period && Number(r.year) === Number(latest.year) - 1);
  if (!yearAgo) throw new Error("BLS: no year-ago value");
  const pct = (Number(latest.value) / Number(yearAgo.value) - 1) * 100;
  return {
    value: Math.round(pct * 10) / 10,
    period: `${latest.periodName} ${latest.year}`,
    source: "BLS CPI-U All Items, 12 months",
    url: "https://www.bls.gov/cpi/"
  };
}

// ---------- Debt ----------
async function debtFromTreasury() {
  const j = await getJSON("https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/debt_to_penny?sort=-record_date&page%5Bsize%5D=1");
  const row = j?.data?.[0];
  if (!row) throw new Error("Treasury: no data");
  return {
    value: Number(row.tot_pub_debt_out_amt),
    asOf: row.record_date,
    source: "U.S. Treasury “Debt to the Penny”",
    url: "https://fiscaldata.treasury.gov/datasets/debt-to-the-penny/"
  };
}

async function attempt(name, fns, fallback) {
  for (const fn of fns) {
    try { const v = await fn(); console.log(`✓ ${name}:`, v.value); return v; }
    catch (e) { console.warn(`✗ ${name}: ${e.message}`); }
  }
  console.warn(`… ${name}: keeping previous value`);
  return fallback ?? null;
}

// BLS v1 allows 25 calls/day. CPI is monthly, so only refetch every 6 hours.
const inflationStale = !prev.inflation?.checkedAt || (Date.now() - Date.parse(prev.inflation.checkedAt)) > 6 * 3600e3;

const [gas, debt, inflation] = await Promise.all([
  attempt("gas", [gasFromAAA, gasFromEIA], prev.gas),
  attempt("debt", [debtFromTreasury], prev.debt),
  inflationStale
    ? attempt("inflation", [inflationFromBLS], prev.inflation).then(v => v && v !== prev.inflation ? { ...v, checkedAt: new Date().toISOString() } : v)
    : Promise.resolve(prev.inflation)
]);

const next = {
  title: config.title,
  timezone: config.timezone,
  counters: config.counters,
  election: config.election,
  gas, inflation, debt
};

// Only write (and therefore commit) when something actually changed.
const strip = o => JSON.stringify({ ...o, updatedAt: undefined, inflation: o.inflation ? { ...o.inflation, checkedAt: undefined } : null });
if (strip(next) === strip(prev) && prev.updatedAt) {
  console.log("No changes.");
} else {
  next.updatedAt = new Date().toISOString();
  await writeFile(OUT, JSON.stringify(next, null, 2) + "\n");
  console.log("Wrote", OUT);
}
