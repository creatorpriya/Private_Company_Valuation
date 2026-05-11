import "./file-polyfill.js";   // ✅ MUST be first

import fs from "fs";
import axios from "axios";
import { load } from "cheerio";
import pLimit from "p-limit";
import crypto from "crypto";
import { CONFIG } from "./config.js";
import { getCollection } from "./mongo.js";

const { Host, USERNAME, PASSWORD } = CONFIG;
const COLLECTION_NAME = "cbinsightsPVTValuation";

const NEXUS_BASE = `${Host}/nexus/v1`;

const CSV_FILE = "cbinsights_unicorns.csv";

/* =========================================================
   CSV HEADER INIT (DISABLED)
========================================================= */
const HEADERS = [
  "companyId",
  "company",
  "domain",
  "updatedAt",
  "valuation",
  "dateJoined",
  "country",
  "city",
  "industry",
  "investors",
];

// ❌ CSV DISABLED
// if (!fs.existsSync(CSV_FILE)) {
//   fs.writeFileSync(CSV_FILE, HEADERS.join(",") + "\n");
// }

/* =========================================================
   CSV APPENDER (DISABLED)
========================================================= */
// ❌ CSV DISABLED
// function appendToCSV(row) {
//   const escape = (v) =>
//     `"${String(v ?? "").replace(/"/g, '""')}"`;

//   const line = HEADERS.map((key) => escape(row[key])).join(",");
//   fs.appendFileSync(CSV_FILE, line + "\n");
// }

/* =========================================================
   NORMALIZE + COMPANY ID (fallback only)
========================================================= */
function normalizeCompany(name) {
  return name.toLowerCase().replace(/\s+/g, "").trim();
}

function generateCompanyId(name) {
  return crypto
    .createHash("md5")
    .update(normalizeCompany(name))
    .digest("hex");
}

/* =========================================================
   SESSION (CACHED)
========================================================= */
let session = null;

async function getSessionId(force = false) {
  if (!force && session && Date.now() - session.time < 20 * 60 * 1000) {
    return session.id;
  }

  const resp = await axios.post(
    `${Host}/nexus/v1/login`,
    { email: USERNAME, password: PASSWORD }
  );

  session = {
    id: resp?.data?.data?.sessionId,
    time: Date.now(),
  };

  console.log("🔐 Session acquired");
  return session.id;
}

/* =========================================================
   COMPANY CACHE
========================================================= */
const companyCache = new Map();

/* =========================================================
   GET OR CREATE COMPANY (NEXUS)
========================================================= */
async function getOrCreateCompany(domain, name, sessionId) {
  if (!domain) return null;

  // ✅ cache hit
  if (companyCache.has(domain)) {
    return companyCache.get(domain);
  }

  const headers = { sessionId };

  try {
    const res = await axios.get(
      `${NEXUS_BASE}/companies?domain=${domain}`,
      { headers }
    );

    const id = res?.data?.data?.list?.[0]?.id;

    if (id) {
      companyCache.set(domain, id);
      return id;
    }
  } catch (err) {
    if (err.response?.status !== 404) {
      console.error(`❌ GET failed for ${domain}`);
    }
  }

  // ➕ create if not exists
  try {
    console.log(`➕ Creating company: ${name} (${domain})`);

    const createRes = await axios.post(
      `${NEXUS_BASE}/companies`,
      [{ name, domain }],
      { headers }
    );

    const id = createRes.data?.data?.[0]?.id;

    if (id) {
      companyCache.set(domain, id);
      return id;
    }
  } catch (err) {
    console.error(`❌ CREATE failed for ${domain}`);
  }

  return null;
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
  } catch {
    return "";
  }
}

/* =========================================================
   EXTRACT TABLE
========================================================= */
function extractUnicornRows(html) {
  const $ = load(html);
  const rows = [];

  $("table tbody tr").each((_, row) => {
    const cols = $(row).find("td");
    if (!cols.length) return;

    const company = $(cols[0]).find("a").text().trim();
    const companyLink = $(cols[0]).find("a").attr("href");

    if (!company) return;

    rows.push({
      company,
      companyLink: companyLink
        ? companyLink.startsWith("http")
          ? companyLink
          : `https://www.cbinsights.com${companyLink}`
        : null,
      valuation: $(cols[1]).text().trim(),
      dateJoined: $(cols[2]).text().trim(),
      country: $(cols[3]).text().trim(),
      city: $(cols[4]).text().trim(),
      industry: $(cols[5]).text().trim(),
      investors: $(cols[6]).text().trim(),
    });
  });

  return rows;
}

/* =========================================================
   DOMAIN EXTRACT + NORMALIZE
========================================================= */
function normalizeDomain(domain) {
  return domain?.toLowerCase().replace(/^www\./, "").trim();
}

function extractDomainFromCompanyPage(html) {
  const $ = load(html);

  let domain = null;

  $("a").each((_, el) => {
    const href = $(el).attr("href");

    if (
      href &&
      href.startsWith("http") &&
      !href.includes("cbinsights.com") &&
      !href.includes("linkedin.com") &&
      !href.includes("twitter.com") &&
      !href.includes("facebook.com") &&
      !href.includes("crunchbase.com")
    ) {
      domain = href;
      return false;
    }
  });

  if (!domain) return null;

  try {
    return normalizeDomain(new URL(domain).hostname);
  } catch {
    return normalizeDomain(domain);
  }
}

/* =========================================================
   MAIN
========================================================= */
async function scrapeUnicorns() {
  try {
    const sessionId = await getSessionId();

    const html = await fetchHTMLContent(
      sessionId,
      "https://www.cbinsights.com/research-unicorn-companies"
    );

    if (!html) throw new Error("No HTML");

    const rows = extractUnicornRows(html);
    console.log(`📊 Found ${rows.length}`);

    const limit = pLimit(4);
    const results = [];

    await Promise.all(
      rows.map((row) =>
        limit(async () => {
          try {
            let domain = null;

            if (row.companyLink) {
              let companyHtml = await fetchHTMLContent(
                sessionId,
                row.companyLink
              );

              if (!companyHtml) {
                companyHtml = await fetchHTMLContent(
                  sessionId,
                  row.companyLink
                );
              }

              domain = extractDomainFromCompanyPage(companyHtml);
            }

            // ✅ GET COMPANY ID FROM NEXUS
            let companyId = null;

            if (domain) {
              companyId = await getOrCreateCompany(
                domain,
                row.company,
                sessionId
              );
            }

            // fallback
            if (!companyId) {
              companyId = generateCompanyId(row.company);
            }

            const finalDoc = {
              companyId,
              company: row.company,
              domain,
              updatedAt: new Date().toISOString(),
              valuation: row.valuation,
              dateJoined: row.dateJoined,
              country: row.country,
              city: row.city,
              industry: row.industry,
              investors: row.investors,
            };

            // ❌ CSV DISABLED
            // appendToCSV(finalDoc);

            results.push(finalDoc);

            console.log(`✅ ${finalDoc.company} → ${finalDoc.domain}`);

          } catch {
            console.error(`❌ ${row.company}`);
          }
        })
      )
    );

    const collection = await getCollection(COLLECTION_NAME);

    /* =====================================================
       🔥 NO DUPLICATES (DOMAIN FIRST)
    ===================================================== */
    const bulkOps = results.map((doc) => {
      const filter = doc.domain
        ? { domain: doc.domain }
        : { companyId: doc.companyId };

      return {
        updateOne: {
          filter,
          update: {
            $set: doc,
            $setOnInsert: { createdAt: new Date() },
          },
          upsert: true,
        },
      };
    });

    const res = await collection.bulkWrite(bulkOps, { ordered: false });

    console.log(`🆕 Inserted: ${res.upsertedCount}`);
    console.log(`♻️ Updated: ${res.modifiedCount}`);

  } catch (err) {
    console.error("❌ Error:", err.message);
  } finally {
    console.log("🛑 Finished");
    process.exit(0);
  }
}

scrapeUnicorns();