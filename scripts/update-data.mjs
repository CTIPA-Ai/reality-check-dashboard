// Fetches official figures and writes data/dashboard.json — the single source of truth
// that every view of the Reality Check Dashboard reads.
// Runs in GitHub Actions every 30 minutes. Node 20+, no dependencies.
//
// Sources (primary government sources only)
//   Gas price -> EIA weekly U.S. Regular All Formulations Retail Gasoline Price, series EMM_EPMR_PTE_NUS_DPG ($/gal)
//               Uses the EIA_API_KEY secret; falls back to the public DEMO_KEY if the secret is missing.
//   Inflation -> BLS CPI-U All Items, U.S. city average, NOT seasonally adjusted (CUUR0000SA0), 12-month % change.
//               Optional BLS_API_KEY secret (raises the daily limit from 25 to 500 requests).
//   Debt      -> U.S. Treasury FiscalData "Debt to the Penny", tot_pub_debt_out_amt (total public debt outstanding).
//
// Rules
//   * A source is only asked again when a newer observation could actually exist (see `due`).
//   * Every response is validated; anything malformed is rejected.
//   * On any failure the previous valid observation is kept unchanged, with its original date.
//   * `retrievedAt` is the time the stored observation was last fetched AND validated. It is never
//     bumped for cached data.
//   * The file (and therefore a commit) only changes when an observation or its stale flag changes.

import { readFile, writeFile } from "node:fs/promises";

const OUT = "data/dashboard.json";
const UA = "RealityCheckDashboard/1.1 (+https://github.com/CTIPA-Ai/reality-check-dashboard)";
const TZ = "America/New_York";
const NOW = new Date();
const FORCE = process.env.FORCE_REFRESH === "1" || process.env.FORCE_REFRESH === "true";

const config = JSON.parse(await readFile("config.json", "utf8"));
let prev = {};
try { prev = JSON.parse(await readFile(OUT, "utf8")); } catch {}

// ---------- helpers ----------
const todayET = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(NOW); // YYYY-MM-DD
const dayNum = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 864e5;
const daysAgo = s => dayNum(todayET()) - dayNum(s);
const isYMD = s => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));
const redact = s => String(s).replace(/(api_key|registrationkey)=[^&\s"]+/gi, "$1=***");
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getText(url, opts = {}) {
  let lastErr;
  for (let tryNo = 1; tryNo <= 2; tryNo++) {            // one quick retry for transient errors
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(20000),
        headers: { "User-Agent": UA, Accept: "application/json", ...(opts.headers || {}) } });
      if (res.status === 429) throw Object.assign(new Error("HTTP 429 rate limited"), { final: true });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      if (e.final) break;
      if (tryNo < 2) await sleep(3000);
    }
  }
  throw new Error(`${redact(url.split("?")[0])} -> ${redact(lastErr?.message)}`);
}
const getJSON = async (url, opts) => JSON.parse(await getText(url, opts));

// Weekday/business-day helpers in ET (used to decide whether a newer record can exist yet)
const weekday = s => new Date(s + "T12:00:00Z").getUTCDay(); // 0=Sun
const addDays = (s, n) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10) + n)).toISOString().slice(0, 10);
const nextBusinessDay = s => { let d = addDays(s, 1); while ([0, 6].includes(weekday(d))) d = addDays(d, 1); return d; };

// ---------- metric definitions ----------
const METRICS = {
  gas: {
    source: "EIA weekly U.S. regular gasoline retail price",
    url: "https://www.eia.gov/petroleum/gasdiesel/",
    dataset: "EIA API v2 petroleum/pri/gnd, series EMM_EPMR_PTE_NUS_DPG",
    units: "USD per gallon",
    frequency: "weekly (EIA publishes Monday afternoon ET; Tuesday after federal holidays)",
    staleAfterDays: 10,
    // New week's figure can't exist until 7 days after the last observation date.
    due: p => !p?.asOf || daysAgo(p.asOf) >= 7 || p.source !== METRICS.gas.source,
    async fetch() {
      const key = process.env.EIA_API_KEY || "DEMO_KEY";
      const url = "https://api.eia.gov/v2/petroleum/pri/gnd/data/?frequency=weekly&data[0]=value"
        + "&facets[series][]=EMM_EPMR_PTE_NUS_DPG&sort[0][column]=period&sort[0][direction]=desc&length=1"
        + `&api_key=${encodeURIComponent(key)}`;
      const j = await getJSON(url);
      const row = j?.response?.data?.[0];
      if (!row) throw new Error("EIA: no data" + (j?.error ? " (" + redact(JSON.stringify(j.error)) + ")" : ""));
      if (row.series !== "EMM_EPMR_PTE_NUS_DPG" || row.duoarea !== "NUS" || row.product !== "EPMR" || row.process !== "PTE")
        throw new Error("EIA: unexpected series " + row.series);
      if (row.units !== "$/GAL") throw new Error("EIA: unexpected units " + row.units);
      const value = Number(row.value);
      if (!Number.isFinite(value) || value < 1 || value > 10) throw new Error("EIA: implausible value " + row.value);
      if (!isYMD(row.period) || daysAgo(row.period) < 0 || daysAgo(row.period) > 60) throw new Error("EIA: bad date " + row.period);
      return { value, asOf: row.period };
    },
    key: v => `${v.value}|${v.asOf}`
  },

  inflation: {
    source: "BLS CPI-U All Items, 12 months",
    url: "https://www.bls.gov/cpi/",
    dataset: "BLS series CUUR0000SA0 (CPI-U, U.S. city average, all items, not seasonally adjusted)",
    units: "percent change from same month one year earlier",
    frequency: "monthly (BLS release schedule: https://www.bls.gov/schedule/news_release/cpi.htm)",
    staleAfterDays: 80,
    // Month M is released around mid-month M+1, so the month after the one we hold can't
    // appear before the 8th of the month after that.
    // Without a BLS key (25 requests/day) only ask on even UTC hours; with a key ask every run.
    due: p => {
      if (!p?.period) return true;
      const m = String(p.period).match(/^(\w+)\s+(\d{4})$/);
      if (!m) return true;
      const monthIdx = new Date(`${m[1]} 1, 2000`).getMonth();
      const earliest = new Date(Date.UTC(+m[2], monthIdx + 2, 8)).toISOString().slice(0, 10); // next month's release
      if (todayET() < earliest) return false;
      return process.env.BLS_API_KEY ? true : NOW.getUTCHours() % 2 === 0 && NOW.getUTCMinutes() < 30;
    },
    async fetch() {
      const key = process.env.BLS_API_KEY;
      const url = key ? "https://api.bls.gov/publicAPI/v2/timeseries/data/" : "https://api.bls.gov/publicAPI/v1/timeseries/data/";
      const year = NOW.getUTCFullYear();
      const body = { seriesid: ["CUUR0000SA0"], startyear: String(year - 1), endyear: String(year) };
      if (key) body.registrationkey = key;
      const j = await getJSON(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (j?.status !== "REQUEST_SUCCEEDED") throw new Error("BLS: " + redact((j?.message || []).join(" ") || j?.status || "bad response"));
      const s = j?.Results?.series?.[0];
      if (s?.seriesID !== "CUUR0000SA0") throw new Error("BLS: unexpected series");
      const monthly = (s.data || []).filter(r => /^M(0[1-9]|1[0-2])$/.test(r.period) && Number.isFinite(Number(r.value)) && Number(r.value) > 0);
      monthly.sort((a, b) => (b.year + b.period).localeCompare(a.year + a.period)); // newest first, don't trust API order
      const latest = monthly[0];
      if (!latest) throw new Error("BLS: no monthly data");
      const yearAgo = monthly.find(r => r.period === latest.period && Number(r.year) === Number(latest.year) - 1);
      if (!yearAgo) throw new Error("BLS: no year-ago value for " + latest.periodName + " " + latest.year);
      const pct = (Number(latest.value) / Number(yearAgo.value) - 1) * 100;
      if (!Number.isFinite(pct) || pct < -10 || pct > 30) throw new Error("BLS: implausible change " + pct);
      return {
        value: Math.round(pct * 10) / 10,
        period: `${latest.periodName} ${latest.year}`,
        index: Number(latest.value),
        indexYearAgo: Number(yearAgo.value)
      };
    },
    key: v => `${v.value}|${v.period}`
  },

  debt: {
    source: "U.S. Treasury “Debt to the Penny”",
    url: "https://fiscaldata.treasury.gov/datasets/debt-to-the-penny/",
    dataset: "FiscalData v2/accounting/od/debt_to_penny, field tot_pub_debt_out_amt",
    units: "USD",
    frequency: "daily on business days (each record is published the next business day)",
    staleAfterDays: 7,
    // The record for business day D is published on business day D+1, so nothing newer can exist
    // until the business day after the next one.
    due: p => !p?.asOf || todayET() >= nextBusinessDay(nextBusinessDay(p.asOf)),
    async fetch() {
      const j = await getJSON("https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/debt_to_penny"
        + "?sort=-record_date&page%5Bsize%5D=1&fields=record_date,tot_pub_debt_out_amt,debt_held_public_amt,intragov_hold_amt");
      const row = j?.data?.[0];
      if (!row) throw new Error("Treasury: no data");
      const total = Number(row.tot_pub_debt_out_amt), pub = Number(row.debt_held_public_amt), intra = Number(row.intragov_hold_amt);
      if (!Number.isFinite(total) || total < 1e13 || total > 1e14) throw new Error("Treasury: implausible total " + row.tot_pub_debt_out_amt);
      if (Number.isFinite(pub) && Number.isFinite(intra) && Math.abs(pub + intra - total) > 1)
        throw new Error("Treasury: total does not equal public + intragovernmental");
      if (!isYMD(row.record_date) || daysAgo(row.record_date) < 0 || daysAgo(row.record_date) > 30) throw new Error("Treasury: bad date " + row.record_date);
      return { value: total, asOf: row.record_date, debtHeldByPublic: pub, intragovernmentalHoldings: intra };
    },
    key: v => `${v.value}|${v.asOf}`
  }
};

// Never let an older observation replace a newer one.
function isOlder(next, old) {
  if (!old) return false;
  if (next.asOf && old.asOf) return next.asOf < old.asOf;
  if (next.period && old.period) return Date.parse("1 " + next.period) < Date.parse("1 " + old.period);
  return false;
}

async function update(id) {
  const m = METRICS[id], p = prev[id] ?? null;
  const meta = { id, source: m.source, url: m.url, dataset: m.dataset, units: m.units, frequency: m.frequency };
  let result = p;

  // Once a day (16:00–16:29 UTC run) re-check every source anyway, to pick up revisions.
  const dailyRecheck = NOW.getUTCHours() === 16 && NOW.getUTCMinutes() < 30;
  if (FORCE || dailyRecheck || m.due(p)) {
    try {
      const v = await m.fetch();
      if (p && p.source === m.source && isOlder(v, p)) {
        console.warn(`✗ ${id}: source returned older observation; keeping ${p.asOf || p.period}`);
      } else if (p && p.source === m.source && p.retrievedAt && m.key(v) === m.key(p)) {
        console.log(`= ${id}: no new observation (${p.asOf || p.period})`);
      } else {
        const now = NOW.toISOString();
        result = { ...v, ...meta, retrievedAt: now };
        if (id === "inflation") result.checkedAt = now;   // kept for backward compatibility
        console.log(`✓ ${id}:`, v.value, v.asOf || v.period);
      }
    } catch (e) {
      console.warn(`✗ ${id}: ${redact(e.message)} — keeping previous value`);
    }
  } else {
    console.log(`… ${id}: not due yet (latest ${p?.asOf || p?.period})`);
  }

  if (!result) return null;                              // never fabricate a first value
  const obsDate = result.asOf || (result.period ? new Date(Date.parse("1 " + result.period)).toISOString().slice(0, 10) : null);
  const stale = obsDate ? daysAgo(obsDate) > m.staleAfterDays : true;
  return { ...result, stale };
}

const [gas, inflation, debt] = await Promise.all(["gas", "inflation", "debt"].map(update));

const next = {
  title: config.title,
  timezone: config.timezone,
  counters: config.counters,
  election: config.election,
  gas, inflation, debt
};

// Only write (and therefore commit) when something actually changed.
const strip = o => JSON.stringify({ ...o, updatedAt: undefined });
if (prev.updatedAt && strip(next) === strip(prev)) {
  console.log("No changes.");
} else {
  next.updatedAt = NOW.toISOString();
  await writeFile(OUT, JSON.stringify(next, null, 2) + "\n");
  console.log("Wrote", OUT);
}
