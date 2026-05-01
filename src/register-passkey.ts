import puppeteer, { type Browser } from "puppeteer";
import chalk from "chalk";
import { access, readFile, writeFile } from "fs/promises";
import path from "path";
import { getAuthenticatedContext } from "./auth.js";
import { setupVirtualAuthenticator, getRegisteredCredentials, saveCredential, loadCredential } from "./passkey.js";

const FORUM_SECURITY_URL = "https://forum.cfx.re/u/me/preferences/security";
const FORUM_LOGIN_URL = "https://forum.cfx.re/login";
const AUTH_STATE_FILE = path.resolve(import.meta.dirname, "../auth-state.json");

async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

async function bootstrapManualLogin(): Promise<Browser> {
  console.log(chalk.yellow("\nNo session cookies and no passkey on file."));
  console.log(chalk.yellow("Launching a visible browser so you can log into the Cfx.re forum manually."));
  console.log(chalk.yellow("(Set HEADLESS=false in your environment if you don't see a window.)\n"));

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
  console.log(chalk.bold.cyan("  1. Log into the Cfx.re forum"));
  console.log(chalk.bold.cyan("  2. Stay on any forum.cfx.re page once logged in"));
  console.log(chalk.bold.cyan("  3. Come back here and press Enter"));
  console.log(chalk.bold.cyan("════════════════════════════════════════\n"));

  await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));

  const cookies = await browser.defaultBrowserContext().cookies();
  await writeFile(AUTH_STATE_FILE, JSON.stringify(cookies, null, 2), "utf-8");
  console.log(chalk.green(`Saved ${cookies.length} cookies to auth-state.json.\n`));

  return browser;
}

export async function registerPasskey(): Promise<void> {
  console.log(chalk.bold("\n9am-build — Passkey Registration\n"));

  // 1. Get auth context. Bootstrap a headed manual login if neither cookies
  //    nor a registered passkey credential exist (otherwise getAuthenticatedContext
  //    fails with "Passkey login failed" before we ever reach the registration step).
  console.log(chalk.gray("Logging into forum..."));
  const hasCookies = await fileExists(AUTH_STATE_FILE);
  const hasCredential = (await loadCredential()) !== null;
  let browser: Browser;
  if (!hasCookies && !hasCredential) {
    browser = await bootstrapManualLogin();
  } else {
    browser = await getAuthenticatedContext();
  }
  const page = (await browser.pages())[0];

  // 2. Create virtual authenticator (without loading credential)
  const authenticatorId = await setupVirtualAuthenticator(page);

  // 3. Navigate to forum security settings
  await page.goto(FORUM_SECURITY_URL, { waitUntil: "networkidle2" });
  await new Promise((r) => setTimeout(r, 2000));

  console.log(chalk.bold.cyan("\n════════════════════════════════════════"));
  console.log(chalk.bold.cyan("  In the browser:"));
  console.log(chalk.bold.cyan("  1. Click 'Add passkey' button"));
  console.log(chalk.bold.cyan("  2. Enter a passkey name and confirm"));
  console.log(chalk.bold.cyan("  3. Come back here when done"));
  console.log(chalk.bold.cyan("════════════════════════════════════════\n"));

  // 4. Wait for user to add passkey
  console.log(chalk.gray("Waiting for passkey registration... (press Enter to continue)"));
  await new Promise<void>((resolve) => {
    process.stdin.once("data", () => resolve());
  });

  // 5. Extract and save credential
  const credentials = await getRegisteredCredentials(page, authenticatorId);

  if (credentials.length === 0) {
    console.log(chalk.red("No passkey credentials found. Registration may have failed."));
    await browser.close();
    process.exit(1);
  }

  const credential = credentials[credentials.length - 1];
  await saveCredential(credential);

  console.log(chalk.green(`\nPasskey registered successfully! (rpId: ${credential.rpId})`));
  console.log(chalk.gray("Credential saved to passkey-credential.json.\n"));

  await browser.close();
}
