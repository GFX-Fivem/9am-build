// Create a new asset on the Cfx.re portal by automating the "ADD ASSET"
// flow: open the modal, fill the asset name, attach a zip, submit, then
// scrape the resulting asset list to discover the new asset ID.
import puppeteer, { type Page } from "puppeteer";
import { readFile, writeFile } from "fs/promises";
import path from "path";
import chalk from "chalk";

const AUTH_STATE_FILE = path.resolve(import.meta.dirname, "../auth-state.json");
const PORTAL_URL = "https://portal.cfx.re/assets/created-assets";

async function ensureLoggedIn(page: Page): Promise<void> {
  if (!page.url().includes("/login")) return;
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

interface CreateOptions {
  assetName: string;     // e.g. "[Open Source] gfx-deathcam"
  zipPath: string;       // absolute path to the .zip to upload
}

export async function createAsset(opts: CreateOptions): Promise<{ id: number | null; rawLabel: string }> {
  console.log(chalk.bold(`\n9am-build — Creating asset "${opts.assetName}"\n`));
  console.log(chalk.gray(`Source: ${opts.zipPath}`));

  const cookies = JSON.parse(await readFile(AUTH_STATE_FILE, "utf-8"));

  const browser = await puppeteer.launch({
    headless: process.env.HEADLESS === "false" ? false : true,
    protocolTimeout: 180_000,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--window-size=1280,800"],
    defaultViewport: { width: 1280, height: 800 },
  });
  const page = (await browser.pages())[0];
  await browser.defaultBrowserContext().setCookie(...cookies);

  await page.goto(`${PORTAL_URL}?page=1&sort=asset.id&direction=desc`, { waitUntil: "load", timeout: 60_000 });
  await new Promise((r) => setTimeout(r, 3000));
  await ensureLoggedIn(page);
  await new Promise((r) => setTimeout(r, 4000));

  // Click ADD ASSET (one eval so we don't lose the button between renders)
  const clicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    for (const b of buttons) {
      const tc = (b.textContent || "").toUpperCase();
      if (tc.includes("ADD") && tc.includes("ASSET") && (b as HTMLElement).offsetParent !== null) {
        (b as HTMLElement).click();
        return true;
      }
    }
    return false;
  });
  if (!clicked) {
    await browser.close();
    throw new Error("Couldn't find ADD ASSET button on the portal page.");
  }
  console.log(chalk.gray("ADD ASSET clicked, waiting for modal..."));
  await new Promise((r) => setTimeout(r, 3000));

  // Fill asset name. The modal has placeholder "Enter asset name".
  const nameTyped = await page.evaluate((nm: string) => {
    const inputs = Array.from(document.querySelectorAll("input"));
    for (const inp of inputs) {
      const ph = (inp.getAttribute("placeholder") || "").toLowerCase();
      if (ph.includes("asset name") && !ph.includes("search")) {
        (inp as HTMLInputElement).focus();
        // Use the React-friendly value setter
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
        setter.call(inp, nm);
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }
    return false;
  }, opts.assetName);
  if (!nameTyped) {
    await browser.close();
    throw new Error("Couldn't find asset-name input in the ADD ASSET modal.");
  }
  console.log(chalk.gray(`Asset name set: "${opts.assetName}"`));
  await new Promise((r) => setTimeout(r, 1000));

  // Attach the zip file
  const fileInput = await page.$("input[type='file']");
  if (!fileInput) {
    await browser.close();
    throw new Error("Couldn't find file input in the ADD ASSET modal.");
  }
  await (fileInput as any).uploadFile(opts.zipPath);
  console.log(chalk.gray(`File attached: ${opts.zipPath}`));
  await new Promise((r) => setTimeout(r, 2000));

  // Click UPLOAD FILE
  const submitted = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    for (const b of buttons) {
      const tc = (b.textContent || "").trim().toUpperCase();
      if (tc === "UPLOAD FILE" && (b as HTMLElement).offsetParent !== null) {
        (b as HTMLElement).click();
        return true;
      }
    }
    return false;
  });
  if (!submitted) {
    await browser.close();
    throw new Error("Couldn't find UPLOAD FILE button to submit the form.");
  }
  console.log(chalk.gray("UPLOAD FILE clicked, waiting for portal to process..."));

  // Wait for the modal to close — poll for the absence of the upload button
  // or for a URL change. Allow up to 2 minutes.
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const stillOpen = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      return buttons.some((b) => (b.textContent || "").trim().toUpperCase() === "UPLOAD FILE" && (b as HTMLElement).offsetParent !== null);
    }).catch(() => true);
    if (!stillOpen) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log(chalk.gray("Modal closed (upload presumed complete). Refreshing list..."));
  await new Promise((r) => setTimeout(r, 3000));

  // Reload and find the new asset by name
  await page.goto(`${PORTAL_URL}?page=1&sort=asset.id&direction=desc`, { waitUntil: "load", timeout: 60_000 });
  await new Promise((r) => setTimeout(r, 4000));
  await ensureLoggedIn(page);
  await new Promise((r) => setTimeout(r, 3000));

  const found = await page.evaluate((needle: string) => {
    const rows = Array.from(document.querySelectorAll("table tr"));
    const out: any[] = [];
    for (const row of rows) {
      const txt = ((row as HTMLElement).innerText || "").trim();
      if (!txt) continue;
      const parts = txt.split(/[\n\t]+/).map((s) => s.trim()).filter(Boolean);
      if (parts.length < 2) continue;
      const id = parseInt(parts[0], 10);
      if (!Number.isFinite(id)) continue;
      out.push({ id, name: parts[1] });
    }
    // Pick the row whose label contains all whitespace-separated tokens of the needle
    const tokens = needle.toLowerCase().replace(/[\[\]]/g, " ").split(/\s+/).filter(Boolean);
    let match = out.find((r) => {
      const lower = r.name.toLowerCase();
      return tokens.every((t: string) => lower.includes(t));
    });
    return { match, total: out.length };
  }, opts.assetName);

  await browser.close();

  if (found.match) {
    console.log(chalk.green(`\n✓ Created asset ID ${found.match.id} ("${found.match.name}")`));
    return { id: found.match.id, rawLabel: found.match.name };
  } else {
    console.log(chalk.yellow(`\nUpload submitted but couldn't auto-discover the new ID. Check the portal manually. (${found.total} rows scanned)`));
    return { id: null, rawLabel: opts.assetName };
  }
}
