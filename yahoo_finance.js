import "./file-polyfill.js";

import fs from "fs";
import axios from "axios";
import { load } from "cheerio";
import { CONFIG } from "./config.js";
import { getCollection } from "./mongo.js";

const { Host, USERNAME, PASSWORD } = CONFIG;
const COLLECTION_NAME = "yahooPVTValuation";

// const CSV_FILE = "yahoo_finance_private_companies.csv";

/* =========================================================
   CSV HEADER (DISABLED)
========================================================= */
// function ensureCSVHeader() {
//   const header =
//     "symbol,company,companyDomain,qspPrice,estimatedValuation,latestFundingDate,totalAmountRaised,latestAmountRaised,totalFundingRounds,latestShareClass,updatedAt,sourceUrl\n";

//   if (!fs.existsSync(CSV_FILE)) {
//     fs.writeFileSync(CSV_FILE, header);
//   } else {
//     const content = fs.readFileSync(CSV_FILE, "utf-8");

//     if (!content.startsWith("symbol,")) {
//       fs.writeFileSync(CSV_FILE, header + content);
//     }
//   }
// }

/* =========================================================
   CSV APPENDER (DISABLED)
========================================================= */
// function appendToCSV(row) {
//   const escape = (v) =>
//     `"${String(v ?? "").replace(/"/g, '""')}"`;

//   const line = [
//     row.symbol,
//     row.company,
//     row.companyDomain,
//     row.qspPrice,
//     row.estimatedValuation,
//     row.latestFundingDate,
//     row.totalAmountRaised,
//     row.latestAmountRaised,
//     row.totalFundingRounds,
//     row.latestShareClass,
//     row.updatedAt,
//     row.sourceUrl,
//   ]
//     .map(escape)
//     .join(",");

//   fs.appendFileSync(CSV_FILE, line + "\n");
// }

/* =========================================================
   LOGIN
========================================================= */
async function getSessionId() {
  const resp = await axios.post(
    `${Host}/nexus/v1/login`,
    { email: USERNAME, password: PASSWORD },
    { validateStatus: () => true }
  );

  if (resp.status !== 200 || !resp?.data?.data?.sessionId) {
    throw new Error(`❌ login failed`);
  }

  console.log("✅ Got SessionId");
  return resp.data.data.sessionId;
}

/* =========================================================
   FETCH HTML
========================================================= */
async function fetchHTMLContent(sessionId, targetUrl) {
  try {
    const resp = await axios.post(
      `${Host}/nexus/v1/webpages`,
      {
        url: targetUrl,
        type: "playwright",
        waitFor: "div[data-testid='quote-statistics']",
        timeout: 60000,
      },
      {
        headers: {
          sessionId,
          referer: "https://finance.yahoo.com/",
        },
        timeout: 120000,
      }
    );

    return resp?.data?.data?.html || "";
  } catch (err) {
    console.error("❌ Fetch error:", targetUrl);
    return "";
  }
}

/* =========================================================
   EXTRACT URLS
========================================================= */
function extractCompanyProfileUrls(html) {
  const $ = load(html);
  const urls = new Set();

  $("a[href^='/quote/']").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    const match = href.match(/^\/quote\/([^/?]+)/);
    if (!match) return;

    const symbol = match[1];

    if (!symbol.endsWith(".PVT")) return;

    urls.add(`https://finance.yahoo.com/quote/${symbol}`);
  });

  console.log("🎯 Private companies:", urls.size);
  return [...urls];
}

/* =========================================================
   NORMALIZE DOMAIN
========================================================= */
function normalizeDomain(url) {
  if (!url) return "";

  return url
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .toLowerCase();
}

/* =========================================================
   EXTRACT DATA
========================================================= */
function extractYahooFinanceData(html, sourceUrl) {
  const $ = load(html);

  const company = $("#main-content-wrapper h1").first().text().trim();

  const rawPrice = $("[data-testid='qsp-price']").first().text().trim();
  const price =
    rawPrice && !rawPrice.includes("$") ? `$${rawPrice}` : rawPrice;

  let companyDomain = "";

  $("a").each((_, el) => {
    const href = $(el).attr("href") || "";
    if (href.includes("http") && !href.includes("yahoo")) {
      companyDomain = normalizeDomain(href);
      return false;
    }
  });

  const fundingData = {};

  $("div[data-testid='quote-statistics'] li").each((_, el) => {
    const label =
      $(el).find("span.label").attr("title")?.trim() ||
      $(el).find("span.label").text().trim();

    const value = $(el).find("span.value").text().trim();

    if (!label) return;

    if (label.includes("Estimated Valuation"))
      fundingData.estimatedValuation = value;

    if (label.includes("Latest Funding Date"))
      fundingData.latestFundingDate = value;

    if (label.includes("Total Amount Raised"))
      fundingData.totalAmountRaised = value;

    if (label.includes("Latest Amount Raised"))
      fundingData.latestAmountRaised = value;

    if (label.includes("Total Funding Rounds"))
      fundingData.totalFundingRounds = value;

    if (label.includes("Latest Share Class"))
      fundingData.latestShareClass = value;
  });

  return {
    symbol: sourceUrl.split("/quote/")[1],
    company,
    companyDomain,

    qspPrice: price,

    estimatedValuation: fundingData.estimatedValuation || "",
    latestFundingDate: fundingData.latestFundingDate || "",
    totalAmountRaised: fundingData.totalAmountRaised || "",
    latestAmountRaised: fundingData.latestAmountRaised || "",
    totalFundingRounds: fundingData.totalFundingRounds || "",
    latestShareClass: fundingData.latestShareClass || "",

    sourceUrl,
    updatedAt: new Date().toISOString(),
  };
}

/* =========================================================
   MAIN
========================================================= */
async function scrapeYahooFinance() {
  try {
    const sessionId = await getSessionId();

    // ensureCSVHeader(); // ❌ disabled

    const listingUrl =
      "https://finance.yahoo.com/markets/private-companies/highest-valuation/";

    const listingHtml = await fetchHTMLContent(sessionId, listingUrl);
    const urls = extractCompanyProfileUrls(listingHtml);

    const results = [];

    for (const url of urls) {
      console.log("➡️", url);

      const html = await fetchHTMLContent(sessionId, url);
      if (!html) continue;

      const data = extractYahooFinanceData(html, url);

      // appendToCSV(data); // ❌ disabled

      results.push(data);

      console.log("✅", data.company, "|", data.companyDomain);

      await new Promise((r) => setTimeout(r, 1200));
    }

    /* =====================================================
       MONGO UPSERT (NO DUPLICATES)
    ===================================================== */
    const collection = await getCollection(COLLECTION_NAME);

    const bulkOps = results.map((doc) => ({
      updateOne: {
        filter: {
          companyDomain: doc.companyDomain || doc.symbol, // safer fallback
        },
        update: {
          $set: doc,
          $setOnInsert: { createdAt: new Date() },
        },
        upsert: true,
      },
    }));

    if (bulkOps.length) {
      const res = await collection.bulkWrite(bulkOps, { ordered: false });

      console.log(`🆕 Inserted: ${res.upsertedCount}`);
      console.log(`♻️ Updated: ${res.modifiedCount}`);
    }

    console.log("🎉 DONE (Mongo only, CSV disabled)");
  } catch (err) {
    console.error(err.message);
  } finally {
    process.exit(0);
  }
}

scrapeYahooFinance();