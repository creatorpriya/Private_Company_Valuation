import "./file-polyfill.js";   // ✅ MUST be first 

import fs from "fs";
import axios from "axios";
import { load } from "cheerio";
import pLimit from "p-limit";
import { CONFIG } from "./config.js";
import { getCollection } from "./mongo.js";

const { Host, USERNAME, PASSWORD } = CONFIG;
const COLLECTION_NAME = "forgeglobalPVTValuation";

const limit = pLimit(5);

/* =========================================================
   CSV CONFIG (❌ DISABLED)
========================================================= */

// const CSV_FILE = "forgeglobal.csv";

// function csvEscape(value) {
//   if (value === null || value === undefined) return "";
//   const str = String(value).replace(/"/g, '""');
//   return `"${str}"`;
// }

// function saveCSV(rows) {
//   if (!rows.length) return;

//   const fileExists = fs.existsSync(CSV_FILE);

//   const headers = [
//     "page",
//     "row",
//     "companyName",
//     "sector",
//     "forgePrice",
//     "sixMonthChange",
//     "oneYearChange",
//     "totalFunding",
//     "shareClass",
//     "amountRaised",
//     "postMoneyValuation",
//     "pricePerShare",
//     "domain",
//   ];

//   const lines = rows.map((row) =>
//     headers.map((h) => csvEscape(row[h])).join(",")
//   );

//   const data = lines.join("\n") + "\n";

//   if (!fileExists) {
//     fs.writeFileSync(CSV_FILE, headers.join(",") + "\n" + data);
//   } else {
//     fs.appendFileSync(CSV_FILE, data);
//   }
// }

/* =========================================================
   NORMALIZE DOMAIN
========================================================= */
function normalizeDomain(domain) {
  if (!domain) return null;

  return domain
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/$/, "")
    .toLowerCase()
    .trim();
}

/* =========================================================
   LOGIN
========================================================= */
async function getSessionId() {
  console.log("🔐 Logging in...");

  const resp = await axios.post(
    `${Host}/nexus/v1/login`,
    { email: USERNAME, password: PASSWORD },
    { validateStatus: () => true }
  );

  if (resp.status !== 200 || !resp?.data?.data?.sessionId) {
    console.error("❌ Login failed:", resp.data);
    throw new Error("login failed");
  }

  console.log("✅ Session acquired");
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
        waitFor: "networkidle",
        timeout: 60000,
      },
      {
        headers: { sessionId },
      }
    );

    return resp?.data?.data?.html || "";
  } catch (err) {
    console.error("❌ Fetch error:", err.message);
    return "";
  }
}

/* =========================================================
   EXTRACT LISTING DATA
========================================================= */
function extractForgeGlobal(html, pageNum) {
  const $ = load(html);
  const results = [];

  const rows = $("#searchResults table tbody tr");

  console.log(`🔍 Rows on page ${pageNum}:`, rows.length);

  rows.each((i, row) => {
    const $row = $(row);

    const companyAnchor = $row.find("td.col-title a");
    const companyName = companyAnchor.text().trim();
    const companyLink = companyAnchor.attr("href");

    if (!companyName) return;

    const getText = (selector) => $row.find(selector).text().trim();

    results.push({
      page: pageNum,
      row: i + 1,
      companyName,
      companyLink: companyLink
        ? companyLink.startsWith("http")
          ? companyLink
          : `https://forgeglobal.com${companyLink}`
        : null,

      sector: $row
        .find("td.col-sector a")
        .map((_, el) => $(el).text().trim())
        .get()
        .join(", "),

      forgePrice: getText("td[data-column='forgePrice']"),
      sixMonthChange: getText("td[data-column='sixMonth']"),
      oneYearChange: getText("td[data-column='oneYear']"),

      totalFunding: getText("td[data-column='totalFunding']"),
      shareClass: getText("td[data-column='round']"),
      amountRaised: getText("td[data-column='amountRaised']"),

      postMoneyValuation: getText("td[data-column='postMoneyValuation']"),
      pricePerShare: getText("td[data-column='price']"),
    });
  });

  return results;
}

/* =========================================================
   EXTRACT DOMAIN
========================================================= */
function extractDomainFromCompanyPage(html) {
  const $ = load(html);

  let domain =
    $("div.website-url a").attr("href") ||
    $("a[href^='http']")
      .filter((_, el) => {
        const text = $(el).text().toLowerCase();
        return text.includes("website") || text.includes(".com");
      })
      .first()
      .attr("href");

  return normalizeDomain(domain);
}

/* =========================================================
   MAIN
========================================================= */
async function scrapeForgeGlobal() {
  try {
    const sessionId = await getSessionId();
    const results = [];

    const MAX_PAGES = 209;

    for (let p = 1; p <= MAX_PAGES; p++) {
      console.log(`\n🔎 PAGE ${p}`);

      let html = await fetchHTMLContent(
        sessionId,
        `https://forgeglobal.com/search-companies/?page=${p}`
      );

      if (!html) {
        console.log("🔁 Retry...");
        await new Promise((r) => setTimeout(r, 3000));
        html = await fetchHTMLContent(
          sessionId,
          `https://forgeglobal.com/search-companies/?page=${p}`
        );
      }

      if (!html) continue;

      const pageData = extractForgeGlobal(html, p);

      await Promise.all(
        pageData.map((row) =>
          limit(async () => {
            try {
              if (row.companyLink) {
                const companyHtml = await fetchHTMLContent(
                  sessionId,
                  row.companyLink
                );
                row.domain = extractDomainFromCompanyPage(companyHtml);
              } else {
                row.domain = null;
              }

              console.log(`✅ ${row.companyName} → ${row.domain}`);
            } catch {
              row.domain = null;
            } finally {
              delete row.companyLink;
            }
          })
        )
      );

      results.push(...pageData);

      // ❌ CSV SAVE DISABLED
      // saveCSV(pageData);

      await new Promise((r) => setTimeout(r, 2000));
    }

    console.log("🎉 TOTAL:", results.length);

    /* ================= MONGO UPSERT ================= */
    const collection = await getCollection(COLLECTION_NAME);
    const now = new Date();

    const bulkOps = results.map((doc) => ({
      updateOne: {
        filter: doc.domain
          ? { domain: doc.domain }
          : { companyName: doc.companyName },
        update: {
          $set: { ...doc, updatedAt: now },
          $setOnInsert: { createdAt: now },
        },
        upsert: true,
      },
    }));

    if (bulkOps.length) {
      const res = await collection.bulkWrite(bulkOps, { ordered: false });

      console.log(`🆕 Inserted: ${res.upsertedCount}`);
      console.log(`♻️ Updated: ${res.modifiedCount}`);
    }
  } catch (err) {
    console.error("❌ Fatal:", err.message);
  } finally {
    console.log("🛑 Finished");
    process.exit(0);
  }
}

scrapeForgeGlobal();