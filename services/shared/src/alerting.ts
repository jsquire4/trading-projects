/**
 * Alerting & Logging Module
 *
 * Shared dependency for all Meridian services. Provides structured logging
 * and alert dispatch (console + optional webhook).
 */

export type AlertLevel = "info" | "warn" | "error" | "critical";

export interface AlertPayload {
  level: AlertLevel;
  service: string;
  message: string;
  context?: Record<string, unknown>;
  timestamp: string;
}

const WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL;

function formatLog(payload: AlertPayload): string {
  const ctx = payload.context ? ` ${JSON.stringify(payload.context)}` : "";
  return `[${payload.timestamp}] [${payload.level.toUpperCase()}] [${payload.service}] ${payload.message}${ctx}`;
}

async function sendWebhook(payload: AlertPayload): Promise<void> {
  if (!WEBHOOK_URL) return;
  try {
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    console.error(`[ALERT] Webhook delivery failed: ${WEBHOOK_URL}`);
  }
}

function createPayload(
  level: AlertLevel,
  service: string,
  message: string,
  context?: Record<string, unknown>,
): AlertPayload {
  return {
    level,
    service,
    message,
    context,
    timestamp: new Date().toISOString(),
  };
}

export function createLogger(service: string) {
  return {
    info(message: string, context?: Record<string, unknown>) {
      const p = createPayload("info", service, message, context);
      console.log(formatLog(p));
    },
    warn(message: string, context?: Record<string, unknown>) {
      const p = createPayload("warn", service, message, context);
      console.warn(formatLog(p));
    },
    error(message: string, context?: Record<string, unknown>) {
      const p = createPayload("error", service, message, context);
      console.error(formatLog(p));
      sendWebhook(p);
    },
    critical(message: string, context?: Record<string, unknown>) {
      const p = createPayload("critical", service, message, context);
      console.error(formatLog(p));
      sendWebhook(p);
    },
  };
}
