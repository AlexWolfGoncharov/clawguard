import {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  type ButtonInteraction,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import { getConfig } from '../utils/config.js';
import logger from '../utils/logger.js';
import { formatForDiscord } from '../core/diff.js';
import * as queue from '../core/queue.js';
import { getStagingEngine } from '../core/staging.js';
import { getBudgetTracker } from '../core/budget.js';
import { notifyResolution } from '../openclaw/plugin.js';
import type { QueueEntry } from '../core/queue.js';
import type { DiffResult } from '../core/diff.js';

const log = logger.child('discord');

let client: Client | null = null;
let channelId: string = '';

/**
 * Initialize and connect the Discord bot.
 */
export async function startDiscord(): Promise<void> {
  const config = getConfig();
  if (!config.channels.discord.enabled) {
    log.info('Discord channel disabled in config');
    return;
  }

  const { token, channelId: configuredChannelId } = config.channels.discord;

  if (!token || token === 'YOUR_BOT_TOKEN') {
    log.warn('Discord token not configured — skipping');
    return;
  }

  channelId = configuredChannelId;

  client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  });

  client.once(Events.ClientReady, (c) => {
    log.info(`Discord bot logged in as ${c.user.tag}`);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;
    await handleButtonInteraction(interaction);
  });

  client.on(Events.Error, (err) => {
    log.error('Discord client error:', err);
  });

  try {
    await client.login(token);
  } catch (err) {
    log.error('Failed to login to Discord:', err);
    throw err;
  }

  process.once('SIGINT', () => stopDiscord());
  process.once('SIGTERM', () => stopDiscord());
}

/**
 * Send a diff notification to the Discord channel.
 */
export async function sendDiffNotification(
  entry: QueueEntry,
  diff: DiffResult
): Promise<void> {
  if (!client || !channelId) return;

  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) {
    log.warn(`Discord channel ${channelId} not found or not text-based`);
    return;
  }

  const content = formatForDiscord(diff);
  const row = buildApprovalRow(entry.id);

  try {
    if ('send' in channel) {
      await channel.send({ content, components: [row] });
      log.info(`Sent Discord diff notification for change ${entry.id}`);
    } else {
      log.error(`Channel does not support send()`);
    }
  } catch (err) {
    log.error(`Failed to send Discord notification for ${entry.id}:`, err);
  }
}

function buildApprovalRow(
  changeId: string
): ActionRowBuilder<MessageActionRowComponentBuilder> {
  const approveBtn = new ButtonBuilder()
    .setCustomId(`approve:${changeId}`)
    .setLabel('✅ Apply')
    .setStyle(ButtonStyle.Success);

  const rejectBtn = new ButtonBuilder()
    .setCustomId(`reject:${changeId}`)
    .setLabel('❌ Reject')
    .setStyle(ButtonStyle.Danger);

  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    approveBtn,
    rejectBtn
  );
}

async function handleButtonInteraction(interaction: ButtonInteraction): Promise<void> {
  const [action, changeId] = interaction.customId.split(':');

  if (action !== 'approve' && action !== 'reject') return;

  const staging = getStagingEngine();

  try {
    if (action === 'approve') {
      // Plugin mode: unblock the waiting hook. Standalone: apply directly.
      const handledByHook = notifyResolution(changeId, true);
      if (!handledByHook) {
        queue.resolveChange(changeId, 'approved');
        staging.apply(changeId);
      }
      await interaction.update({
        content: `✅ Change \`${changeId.slice(0, 8)}...\` approved.`,
        components: [],
      });
    } else {
      // Plugin mode: unblock the waiting hook. Standalone: reject directly.
      const handledByHook = notifyResolution(changeId, false);
      if (!handledByHook) {
        queue.resolveChange(changeId, 'rejected');
        staging.reject(changeId);
      }
      await interaction.update({
        content: `❌ Change \`${changeId.slice(0, 8)}...\` rejected.`,
        components: [],
      });
    }
  } catch (err) {
    log.error(`Error handling Discord button ${action}:${changeId}:`, err);
    await interaction.reply({
      content: `Error: ${err instanceof Error ? err.message : String(err)}`,
      ephemeral: true,
    });
  }
}

/**
 * Send a budget alert to the Discord channel.
 */
export async function sendBudgetAlert(message: string): Promise<void> {
  if (!client || !channelId) return;

  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) return;

  try {
    const tracker = getBudgetTracker();
    const status = tracker.checkBudget();

    const content =
      `⚠️ **Budget Alert** — ${message}\n` +
      `Today: \`$${status.used_today_usd.toFixed(4)}\` / \`$${status.limit_usd.toFixed(2)}\` (${status.percentage.toFixed(1)}%)`;

    if ('send' in channel) {
      await channel.send(content);
    }
  } catch (err) {
    log.error('Failed to send Discord budget alert:', err);
  }
}

export function stopDiscord(): void {
  if (client) {
    client.destroy();
    client = null;
    log.info('Discord bot stopped');
  }
}
