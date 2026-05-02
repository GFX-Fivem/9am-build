import puppeteer from "puppeteer";
import { writeFile } from "fs/promises";
import path from "path";
import chalk from "chalk";

const AUTH_STATE_FILE = path.resolve(import.meta.dirname, "../auth-state.json");
const FORUM_LOGIN_URL = "https://forum.cfx.re/login";
const PORTAL_URL = "https://portal.cfx.re/assets/created-assets";

// Cookies-only login. Skips passkey entirely — operator just types their
// Cfx.re forum password + 2FA in a visible browser. After the manual forum
// login the script also walks the portal SSO flow so that portal session
// cookies are captured too. Cookies are good for ~30 days; re-run if
// uploads start failing.
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

  // Forum login captured. Now drive the Cfx.re portal SSO flow so portal
  // session cookies are saved alongside the forum cookies.
  console.log(chalk.gray("\nCompleting Cfx.re portal SSO..."));
  try {
    await page.goto(PORTAL_URL, { waitUntil: "load", timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 2000));

    // If portal redirected to /login, click "Sign in with Cfx.re"
    if (page.url().includes("/login")) {
      const clicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("button, a"));
        for (const b of buttons) {
          const cls = b.getAttribute("class") || "";
          const txt = (b as HTMLElement).innerText?.toLowerCase() || "";
          if (cls.toLowerCase().includes("login_nowrap") || txt.includes("sign in with cfx.re") || txt.includes("cfx.re")) {
            (b as HTMLElement).click();
            return true;
          }
        }
        return false;
      });
      if (!clicked) console.log(chalk.yellow("Couldn't auto-click SSO button — please click 'Sign in with Cfx.re' in the browser, then press Enter."));
      else console.log(chalk.gray("Clicked Cfx.re SSO button."));

      // Wait for either auto-redirect to portal or manual click completion
      const sso_deadline = Date.now() + 60_000;
      while (Date.now() < sso_deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        if (page.url().includes("portal.cfx.re") && !page.url().includes("/login")) break;
      }
    }

    // Wait for portal to actually render the assets page
    const deadline = Date.now() + 30_000;
    let portalLoaded = false;
    while (Date.now() < deadline) {
      const ok = await page.evaluate(() => document.body.innerText.includes("Created Assets") || document.body.innerText.includes("Granted Assets")).catch(() => false);
      if (ok) { portalLoaded = true; break; }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (portalLoaded) console.log(chalk.green("Portal session captured."));
    else console.log(chalk.yellow(`Portal may not be fully loaded (URL: ${page.url()}). Cookies saved anyway — try 'bun run list-assets' to verify.`));
  } catch (err: any) {
    console.log(chalk.yellow(`Portal SSO step failed (${err.message}). Cookies still saved — re-run if uploads fail.`));
  }

  const cookies = await browser.defaultBrowserContext().cookies();
  await writeFile(AUTH_STATE_FILE, JSON.stringify(cookies, null, 2), "utf-8");
  console.log(chalk.green(`\nSaved ${cookies.length} cookies to auth-state.json.`));
  console.log(chalk.gray("These typically last ~30 days on Discourse. Re-run `bun run login` if uploads start failing.\n"));

  await browser.close();
}
