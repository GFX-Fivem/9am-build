import puppeteer, { type Page } from "puppeteer";
import { readFile, writeFile } from "fs/promises";
import path from "path";
import chalk from "chalk";

const AUTH_STATE_FILE = path.resolve(import.meta.dirname, "../auth-state.json");
const BASE_URL = "https://portal.cfx.re/assets/created-assets";
const OUTPUT_FILE = path.resolve(import.meta.dirname, "../assets.json");

interface Asset {
  id: number;
  name: string; // e.g. "gfx-arena"
  version: "escrow" | "opensource" | "unknown";
  rawLabel: string; // e.g. "[Escrow] gfx-arena"
  lastUpdated: string;
  status: string;
}

async function ensureLoggedIn(page: Page): Promise<void> {
  if (!page.url().includes("/login")) return;
  console.log(chalk.gray("Walking portal SSO..."));
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button, a"));
    for (const b of buttons) {
      const cls = b.getAttribute("class") || "";
      const txt = (b as HTMLElement).innerText?.toLowerCase() || "";
      if (cls.toLowerCase().includes("login_nowrap") || txt.includes("sign in with cfx.re") || txt.includes("cfx.re")) {
        (b as HTMLElement).click();
        return;
      }
    }
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (page.url().includes("portal.cfx.re") && !page.url().includes("/login")) return;
  }
}

async function scrapePage(page: Page): Promise<Asset[]> {
  // Wait for table to render
  const tableDeadline = Date.now() + 20_000;
  while (Date.now() < tableDeadline) {
    const rowCount = await page.evaluate(() => document.querySelectorAll("table tr").length).catch(() => 0);
    if (rowCount > 1) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await new Promise((r) => setTimeout(r, 1500));

  return page.evaluate(() => {
    const out: any[] = [];
    const rows = Array.from(document.querySelectorAll("table tr"));
    for (const row of rows) {
      // Use the row's full innerText and split on newlines/tabs — table cells
      // in the portal SPA are wrapped in nested divs/spans which can confuse
      // strict td-based parsing. Format observed:
      //   "944849\n[Open Source] gfx-killfeed\n07.04.2026 05:38:02\nACTIVE\nDOWNLOAD"
      const txt = ((row as HTMLElement).innerText || "").trim();
      if (!txt) continue;
      const parts = txt.split(/[\n\t]+/).map((s) => s.trim()).filter(Boolean);
      if (parts.length < 4) continue;
      const id = parseInt(parts[0], 10);
      if (!Number.isFinite(id)) continue;
      const nameText = parts[1] || "";
      const updated = parts[2] || "";
      const status = parts[3] || "";

      // Naming on the portal is inconsistent. Examples in the wild:
      //   "[Escrow] gfx-arena" / "[ESCROW] gfx-attachment"
      //   "[Open Source] Redm Kit" / "[Open Src] gfx-arena" / "[OpenSrc] GFX MDT"
      //   "Escrow GFX Christmas Truck" (no brackets)
      //   "Open Src GFX Tebex Shop"
      //   "gfx-inventory" (no prefix at all — older single-asset products)
      const bracketed = nameText.match(/^\[(Escrow|Open Source|Open Src|OpenSrc|Open src)\]\s*(.+)$/i);
      const unbracketed = nameText.match(/^(Escrow|Open Source|Open Src|OpenSrc|Open Src)\s+(.+)$/i);
      const m = bracketed || unbracketed;
      let version: "escrow" | "opensource" | "unknown" = "unknown";
      let name = nameText;
      if (m) {
        version = /escrow/i.test(m[1]) ? "escrow" : "opensource";
        name = m[2].trim();
      }

      out.push({ id, name, version, rawLabel: nameText, lastUpdated: updated, status });
    }
    return out;
  });
}

async function clickNextPage(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button, a"));
    for (const b of buttons) {
      const txt = ((b as HTMLElement).innerText || "").trim().toLowerCase();
      const aria = (b.getAttribute("aria-label") || "").toLowerCase();
      if ((txt === "next" || aria.includes("next page") || aria === "next") && !b.hasAttribute("disabled")) {
        const disabledClass = /disabled/i.test(b.getAttribute("class") || "");
        if (!disabledClass) {
          (b as HTMLElement).click();
          return true;
        }
      }
    }
    return false;
  });
}

export async function listAssets(): Promise<void> {
  console.log(chalk.bold("\n9am-build — Listing assets from Cfx.re portal\n"));

  const cookies = JSON.parse(await readFile(AUTH_STATE_FILE, "utf-8"));

  const browser = await puppeteer.launch({
    headless: process.env.HEADLESS === "false" ? false : true,
    protocolTimeout: 120_000,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled", "--window-size=1280,800"],
    defaultViewport: { width: 1280, height: 800 },
  });
  const page = (await browser.pages())[0];
  await browser.defaultBrowserContext().setCookie(...cookies);

  // Sort by id ascending → smaller IDs first → page 1 has oldest assets
  // We don't actually care about order since we paginate everything; just
  // pick a stable URL.
  const url = `${BASE_URL}?page=1&sort=asset.id&direction=desc`;
  console.log(chalk.gray(`Loading ${url}...`));
  await page.goto(url, { waitUntil: "load", timeout: 60_000 });
  await new Promise((r) => setTimeout(r, 3000));
  await ensureLoggedIn(page);

  // After SSO, the SPA may need a few seconds to mount the asset table.
  // Wait until either the table renders or we land on a sensible URL.
  const settleDeadline = Date.now() + 30_000;
  while (Date.now() < settleDeadline) {
    const rowCount = await page.evaluate(() => document.querySelectorAll("table tr").length).catch(() => 0);
    if (rowCount > 1) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  await new Promise((r) => setTimeout(r, 2000));

  // Re-navigate to the canonical sorted URL once we're authenticated, in case
  // the SSO redirect dropped the query string.
  if (!page.url().includes("created-assets")) {
    await page.goto(url, { waitUntil: "load", timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 5000));
  }

  // Debug: dump screenshot + html if no rows visible (helps diagnose headless issues)
  const haveRows = await page.evaluate(() => document.querySelectorAll("table tr").length > 1).catch(() => false);
  if (!haveRows) {
    const dbgPng = path.resolve(import.meta.dirname, "../debug-list-assets.png");
    const dbgHtml = path.resolve(import.meta.dirname, "../debug-list-assets.html");
    try {
      await page.screenshot({ path: dbgPng as `${string}.png`, fullPage: true });
      const html = await page.content();
      await writeFile(dbgHtml, html, "utf-8");
      console.log(chalk.yellow(`No rows found. Saved debug artifacts: ${dbgPng}, ${dbgHtml}`));
    } catch (e: any) {
      console.log(chalk.red(`Debug dump failed: ${e.message}`));
    }
  }

  const all: Asset[] = [];
  const seen = new Set<number>();
  let pageNum = 1;
  const MAX_PAGES = 30; // safety stop in case pagination misbehaves
  while (pageNum <= MAX_PAGES) {
    console.log(chalk.gray(`Scraping page ${pageNum}...`));
    const rows = await scrapePage(page);
    let newCount = 0;
    for (const r of rows) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        all.push(r);
        newCount++;
      }
    }
    console.log(chalk.gray(`  Page ${pageNum}: ${rows.length} rows (${newCount} new)`));
    if (rows.length === 0) break;
    if (newCount === 0 && pageNum > 1) break;

    // Try URL-based pagination — more reliable than chasing the SPA's Next button
    pageNum++;
    const nextUrl = `${BASE_URL}?page=${pageNum}&sort=asset.id&direction=desc`;
    await page.goto(nextUrl, { waitUntil: "load", timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 2500));
  }

  // Group gfx-* assets by name with escrow/opensource ids paired
  const gfx = all.filter((a) => /^gfx-/i.test(a.name));
  const grouped: Record<string, { escrow?: number; opensource?: number; raw: Asset[] }> = {};
  for (const a of gfx) {
    if (!grouped[a.name]) grouped[a.name] = { raw: [] };
    grouped[a.name].raw.push(a);
    if (a.version === "escrow") grouped[a.name].escrow = a.id;
    else if (a.version === "opensource") grouped[a.name].opensource = a.id;
  }

  await writeFile(
    OUTPUT_FILE,
    JSON.stringify({ scrapedAt: new Date().toISOString(), totalAssets: all.length, gfxGrouped: grouped, allAssets: all }, null, 2),
    "utf-8"
  );

  console.log(chalk.green(`\n✓ Scraped ${all.length} total assets across ${pageNum} page(s) → ${OUTPUT_FILE}`));
  console.log(chalk.bold(`\ngfx-* asset map:\n`));
  const keys = Object.keys(grouped).sort();
  for (const k of keys) {
    const g = grouped[k];
    const e = g.escrow !== undefined ? String(g.escrow) : "—";
    const o = g.opensource !== undefined ? String(g.opensource) : "—";
    console.log(`  ${k.padEnd(28)}  escrow=${e.padEnd(8)}  opensource=${o}`);
  }

  await browser.close();
}
