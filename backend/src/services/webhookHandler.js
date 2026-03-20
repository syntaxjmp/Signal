import { EmbedBuilder, WebhookClient } from 'discord.js';
import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../config/database.js';

const SIGNAL_ORANGE = 0xf54725;

export function isValidDiscordWebhookUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return /^https:\/\/(canary\.|ptb\.)?discord\.com\/api\/webhooks\/\d+\/[\w-]+$/i.test(url.trim());
}

export async function getUserWebhook(userId) {
  const pool = getPool();
  const [[row]] = await pool.query(
    `SELECT id, user_id AS userId, webhook_url AS webhookUrl, is_active AS isActive
     FROM user_webhooks
     WHERE user_id = ?
     LIMIT 1`,
    [userId],
  );
  return row || null;
}

export async function setUserWebhook({ userId, webhookUrl }) {
  const pool = getPool();
  const trimmed = webhookUrl.trim();
  const [[existing]] = await pool.query(
    `SELECT id FROM user_webhooks WHERE user_id = ? LIMIT 1`,
    [userId],
  );
  if (existing) {
    await pool.execute(
      `UPDATE user_webhooks
       SET webhook_url = ?, is_active = 1, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ?`,
      [trimmed, userId],
    );
    return existing.id;
  }
  const id = uuidv4();
  await pool.execute(
    `INSERT INTO user_webhooks (id, user_id, webhook_url, is_active)
     VALUES (?, ?, ?, 1)`,
    [id, userId, trimmed],
  );
  return id;
}

export async function clearUserWebhook(userId) {
  const pool = getPool();
  await pool.execute(
    `UPDATE user_webhooks
     SET is_active = 0, updated_at = CURRENT_TIMESTAMP
     WHERE user_id = ?`,
    [userId],
  );
}

export async function sendWebhookForUser(userId, { title, description, fields = [], url }) {
  try {
    const hook = await getUserWebhook(userId);
    if (!hook || !hook.isActive || !hook.webhookUrl) return false;

    const client = new WebhookClient({ url: hook.webhookUrl });
    const embed = new EmbedBuilder()
      .setColor(SIGNAL_ORANGE)
      .setTitle(title || 'Signal Bot Update')
      .setDescription(description || '')
      .setTimestamp(new Date());

    if (url) embed.setURL(url);
    if (fields.length > 0) embed.setFields(fields.slice(0, 25));
    embed.setThumbnail('https://i.imgur.com/0ulXIRt.png');

    await client.send({
      username: 'Signal Bot',
      avatarURL: 'https://i.imgur.com/0ulXIRt.png',
      embeds: [embed],
    });
    return true;
  } catch (e) {
    console.warn('[webhook] send failed', e instanceof Error ? e.message : String(e));
    return false;
  }
}

