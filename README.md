# Private Company Valuation

A Node.js–based private market intelligence pipeline that collects, normalizes, and stores private company valuation data from multiple sources including:

* CB Insights
* Yahoo Finance Private Markets
* Forge Global

The system uses Playwright rendering, Cheerio parsing, and MongoDB bulk upserts to build a clean, deduplicated private company valuation database.

## Features

* Multi-source private company valuation scraping
* Dynamic page rendering using Nexus + Playwright
* Domain extraction & normalization
* Duplicate prevention using MongoDB upserts
* Parallel scraping with `p-limit`
* Session caching & retry handling
* MongoDB-first architecture
* Sequential pipeline execution via `run-all.js`

## Tech Stack

* Node.js
* Axios
* Cheerio
* Playwright
* MongoDB
* p-limit

## Run

Install packages:

```bash id="qqejh8"
npm install axios cheerio mongodb p-limit playwright
```

Run all scrapers:

```bash id="p5nyy0"
node run-all.js
```

## Collections

* `cbinsightsPVTValuation`
* `yahooPVTValuation`
* `forgeglobalPVTValuation`

## Use Cases

* Venture capital intelligence
* Unicorn tracking
* Startup valuation monitoring
* Private market analytics
* Investment research
