import chalk from "chalk";

const BRAND_COLOR = 0x00ff7f;

export interface DiscordChangelogOptions {
  repoName: string;
  changelog: string;
}

// Legacy AI-changelog hook. No longer called by server.ts in this fork — kept
// so a manual `bun run deploy` pipeline could still post one if someone wired
// it up. The autonomous flow uses sendDiscordDeployPing below instead.
export async function sendDiscordChangelog(options: DiscordChangelogOptions): Promise<void> {
  const webhookUrl = process.env.DISCORD_CHANGELOG_WEBHOOK;
  if (!webhookUrl) {
    console.log(chalk.yellow("[Discord] DISCORD_CHANGELOG_WEBHOOK is not set, skipping."));
    return;
  }

  const embed = {
    title: `${options.repoName} updated! 🚀`,
    description: `${options.changelog}\n\n📦 Download the latest version from [CFX Portal](https://portal.cfx.re/assets/granted-assets?page=1&sort=asset.updated_at&direction=asc&search=${encodeURIComponent(options.repoName)}).`,
    color: BRAND_COLOR,
    timestamp: new Date().toISOString(),
  };

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "9am studios",
      avatar_url: "https://cdn.9am.dev/logo.png",
      embeds: [embed],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Discord webhook failed (${response.status}): ${text}`);
  }

  console.log(chalk.green("[Discord] Changelog notification sent."));
}

export interface DiscordDeployPingOptions {
  repoName: string;
  commitSha: string;
  commitMessage: string;
  branch: string;
  compareUrl?: string;
}

export async function sendDiscordDeployPing(options: DiscordDeployPingOptions): Promise<void> {
  const webhookUrl = process.env.DISCORD_DEPLOY_WEBHOOK ?? process.env.DISCORD_CHANGELOG_WEBHOOK;
  if (!webhookUrl) {
    console.log(chalk.yellow("[Discord] DISCORD_DEPLOY_WEBHOOK is not set, skipping."));
    return;
  }

  const shortSha = options.commitSha.slice(0, 7);
  const firstLine = (options.commitMessage || "(no message)").split("\n")[0].slice(0, 200);

  const fields: { name: string; value: string; inline: boolean }[] = [
    { name: "Commit", value: `\`${shortSha}\``, inline: true },
    { name: "Branch", value: `\`${options.branch}\``, inline: true },
    { name: "Message", value: firstLine, inline: false },
  ];
  if (options.compareUrl) fields.push({ name: "Diff", value: options.compareUrl, inline: false });

  const embed = {
    title: `✅ Uploaded ${options.repoName}`,
    color: BRAND_COLOR,
    fields,
    timestamp: new Date().toISOString(),
  };

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "9am-build",
      embeds: [embed],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Discord webhook failed (${response.status}): ${text}`);
  }

  console.log(chalk.green(`[Discord] Deploy ping sent for ${options.repoName} @ ${shortSha}`));
}
