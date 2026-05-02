import puppeteer from "puppeteer";
import { writeFile } from "fs/promises";
import path from "path";
import chalk from "chalk";

const AUTH_STATE_FILE = path.resolve(import.meta.dirname, "../auth-state.json");
const FORUM_LOGIN_URL = "https://forum.cfx.re/login";

// Cookies-only login. Skips passkey entirely — operator just types their
// Cfx.re forum password + 2FA in a visible browser. Cookies are good for
// ~30 days; re-run if uploads start failing.
export async function loginAndSaveCookies(): Promise<void> {
  console.log(chalk.bold("\n9am-build — Manual Cookie Login\n"));
  console.log(chalk.gray("Opening a browser. Log into your Cfx.re forum account, then press Enter."));
  console.log(chalk.gray("No passkey required. Cookies will be saved for the upload pipeline.\n"));

  const browser = await puppeteer.launch({
    headless: false,
    protocolTimeout: 120_000,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1280,800",
    ],
    defaultViewport: { width: 1280, height: 800 },
  });
  const page = (await browser.pages())[0];
  await page.goto(FORUM_LOGIN_URL, { waitUntil: "load" });

  console.log(chalk.bold.cyan("════════════════════════════════════════"));
  console.log(chalk.bold.cyan("  In the browser:"));
  console.log(chalk.bold.cyan("  1. Log into the Cfx.re forum (username + password + 2FA)"));
  console.log(chalk.bold.cyan("  2. Wait until you're on a forum.cfx.re page and clearly logged in"));
  console.log(chalk.bold.cyan("  3. Come back here and press Enter"));
  console.log(chalk.bold.cyan("════════════════════════════════════════\n"));

  await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));

  const cookies = await browser.defaultBrowserContext().cookies();
  await writeFile(AUTH_STATE_FILE, JSON.stringify(cookies, null, 2), "utf-8");
  console.log(chalk.green(`\nSaved ${cookies.length} cookies to auth-state.json.`));
  console.log(chalk.gray("These typically last ~30 days on Discourse. Re-run `bun run login` if uploads start failing.\n"));

  await browser.close();
}
