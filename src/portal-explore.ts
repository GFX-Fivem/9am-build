// One-off script: navigate the portal asset list and dump button/link
// metadata so we can find the "Create new asset" flow.
import puppeteer from "puppeteer";
import { readFile, writeFile } from "fs/promises";
import path from "path";
import chalk from "chalk";

const AUTH_STATE_FILE = path.resolve(import.meta.dirname, "../auth-state.json");
const OUTPUT = path.resolve(import.meta.dirname, "../portal-explore.json");

export async function exploreCreateFlow(): Promise<void> {
  console.log(chalk.bold("\n9am-build — Portal exploration\n"));
  const cookies = JSON.parse(await readFile(AUTH_STATE_FILE, "utf-8"));

  const browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 120_000,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--window-size=1280,800"],
    defaultViewport: { width: 1280, height: 800 },
  });
  const page = (await browser.pages())[0];
  await browser.defaultBrowserContext().setCookie(...cookies);

  await page.goto("https://portal.cfx.re/assets/created-assets?page=1", { waitUntil: "load", timeout: 60_000 });
  await new Promise((r) => setTimeout(r, 3000));

  // SSO redirect handling
  if (page.url().includes("/login")) {
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
    await new Promise((r) => setTimeout(r, 5000));
  }
  await new Promise((r) => setTimeout(r, 5000));

  const data = await page.evaluate(() => {
    const result: any = { url: location.href, title: document.title };
    // Scrape + click ADD ASSET in the SAME evaluation so we don't lose the
    // button between renders.
    let clickedAddAsset: any = false;
    const allButtons = Array.from(document.querySelectorAll("button"));
    const allTexts = allButtons.map((b, i) => ({
      i,
      tc: (b.textContent || "").trim().slice(0, 60),
      inner: ((b as HTMLElement).innerText || "").trim().slice(0, 60),
      visible: (b as HTMLElement).offsetParent !== null,
    }));
    // Find ADD ASSET via case-insensitive textContent match across all buttons
    for (const b of allButtons) {
      const tc = (b.textContent || "").toUpperCase();
      if (tc.includes("ADD") && tc.includes("ASSET") && (b as HTMLElement).offsetParent !== null) {
        (b as HTMLElement).click();
        clickedAddAsset = { tc: tc.slice(0, 60) };
        break;
      }
    }
    result.clickedAddAsset = clickedAddAsset;
    result.allTextsSample = allTexts.filter((t) => /ADD|ASSET|UPLOAD|CREATE|NEW/i.test(t.tc + t.inner)).slice(0, 30);
    // All buttons + their text/aria/class
    result.buttons = allButtons.map((b) => ({
      text: (b as HTMLElement).innerText?.trim().slice(0, 100) || "",
      aria: b.getAttribute("aria-label") || "",
      cls: (b.getAttribute("class") || "").slice(0, 100),
      hidden: (b as HTMLElement).offsetParent === null,
    })).filter((b) => b.text.length > 0 || b.aria.length > 0);
    // All links
    result.links = Array.from(document.querySelectorAll("a")).map((a) => ({
      text: (a as HTMLElement).innerText?.trim().slice(0, 100) || "",
      href: (a as HTMLAnchorElement).href || "",
    })).filter((l) => l.text.length > 0).slice(0, 80);
    // Anything mentioning create/new/upload
    result.createCandidates = Array.from(document.querySelectorAll("button, a")).filter((el) => {
      const txt = ((el as HTMLElement).innerText || "").toLowerCase();
      const aria = (el.getAttribute("aria-label") || "").toLowerCase();
      return /new asset|create|add asset|new\b|upload|publish/.test(txt + " " + aria);
    }).map((el) => ({
      tag: el.tagName,
      text: (el as HTMLElement).innerText?.trim().slice(0, 200) || "",
      aria: el.getAttribute("aria-label") || "",
      href: (el as HTMLAnchorElement).href || "",
      cls: (el.getAttribute("class") || "").slice(0, 150),
    }));
    return result;
  });

  await writeFile(OUTPUT, JSON.stringify(data, null, 2), "utf-8");
  console.log(chalk.green(`URL: ${data.url}`));
  console.log(chalk.green(`Title: ${data.title}`));
  console.log(chalk.bold(`\nCreate candidates: ${data.createCandidates.length}`));
  for (const c of data.createCandidates) console.log(`  ${c.tag} "${c.text}" aria="${c.aria}" href=${c.href}`);

  console.log(chalk.gray(`\nADD ASSET clicked in first eval: ${data.clickedAddAsset}`));
  await new Promise((r) => setTimeout(r, 4000));

  const modal = await page.evaluate(() => {
    return {
      url: location.href,
      // dialogs / modal containers
      modals: Array.from(document.querySelectorAll("[role='dialog'], [class*='Modal'], [class*='Dialog'], [class*='modal'], [class*='dialog']")).map((el) => ({
        cls: (el.getAttribute("class") || "").slice(0, 200),
        text: ((el as HTMLElement).innerText || "").trim().slice(0, 1000),
      })),
      // form fields on the page
      inputs: Array.from(document.querySelectorAll("input, textarea, select")).map((el) => ({
        tag: el.tagName,
        type: el.getAttribute("type") || "",
        name: el.getAttribute("name") || "",
        placeholder: el.getAttribute("placeholder") || "",
        label: (el.previousElementSibling as HTMLElement | null)?.innerText?.trim().slice(0, 80) || "",
        cls: (el.getAttribute("class") || "").slice(0, 100),
      })),
      // buttons inside dialogs
      buttons: Array.from(document.querySelectorAll("[role='dialog'] button, [class*='odal'] button, [class*='ialog'] button")).map((b) => ({
        text: (b as HTMLElement).innerText?.trim().slice(0, 80) || "",
        type: b.getAttribute("type") || "",
        cls: (b.getAttribute("class") || "").slice(0, 100),
      })),
    };
  });

  await writeFile(path.resolve(import.meta.dirname, "../portal-add-asset.json"), JSON.stringify(modal, null, 2), "utf-8");
  console.log(chalk.bold(`\nADD ASSET modal:\n  URL after click: ${modal.url}`));
  console.log(chalk.bold(`  Modals: ${modal.modals.length}`));
  modal.modals.slice(0, 3).forEach((m: any, i: number) => console.log(`    [${i}] ${m.text.slice(0, 300)}`));
  console.log(chalk.bold(`\n  Inputs: ${modal.inputs.length}`));
  modal.inputs.forEach((inp: any) => console.log(`    ${inp.tag}[type=${inp.type}] name="${inp.name}" placeholder="${inp.placeholder}" label="${inp.label}"`));
  console.log(chalk.bold(`\n  Modal buttons: ${modal.buttons.length}`));
  modal.buttons.forEach((b: any) => console.log(`    "${b.text}" type=${b.type}`));

  console.log(chalk.gray(`\nFull dump → ${OUTPUT}`));
  await browser.close();
}
