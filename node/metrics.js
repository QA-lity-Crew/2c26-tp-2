import dgram from "dgram";

const STATSD_HOST = process.env.STATSD_HOST || "localhost";
const STATSD_PORT = Number(process.env.STATSD_PORT) || 8125;

const socket = dgram.createSocket("udp4");

socket.on("error", (err) => {
  console.error("StatsD socket error:", err.message);
});

/**
 * Emits StatsD metrics for exchange and ARCA telemetry to Datadog agent.
 */
export function emitMetrics(metrics) {
  if (!metrics || metrics.length === 0) return;
  const payload = Buffer.from(metrics.join("\n") + "\n");
  socket.send(payload, 0, payload.length, STATSD_PORT, STATSD_HOST, (err) => {
    if (err) {
      console.error("Error sending StatsD metrics:", err.message);
    }
  });
}

/**
 * Emits business metrics for completed exchanges.
 */
export function emitExchangeMetrics(exchangeResult) {
  if (!exchangeResult || !exchangeResult.ok || !exchangeResult.request) return;

  const { baseCurrency, counterCurrency, baseAmount } = exchangeResult.request;
  const counterAmount = exchangeResult.counterAmount;

  const metrics = [
    `business.volume.${baseCurrency}:${baseAmount}|c`,
    `business.volume.${counterCurrency}:${counterAmount}|c`,
    `business.net.${baseCurrency}:${baseAmount}|c`,
    `business.net.${counterCurrency}:-${counterAmount}|c`,
    `business.exchange.success:1|c`,
  ];

  emitMetrics(metrics);
}

/**
 * Emits telemetry specifically for ARCA external service validations.
 * @param {Object} arcaTelemetry
 * @param {boolean} arcaTelemetry.ok - If ARCA approved the transaction
 * @param {boolean} arcaTelemetry.authorized - If status code was 200 and approved
 * @param {number} arcaTelemetry.durationMs - Latency of the HTTP request to ARCA in ms
 * @param {string} arcaTelemetry.status - "approved" | "rejected" | "timeout" | "error"
 */
export function emitArcaMetrics({ durationMs, status }) {
  const metrics = [
    `arca.validation.latency:${durationMs}|ms`,
    `arca.validation.count:1|c|#status:${status}`,
    `arca.validation.${status}:1|c`,
  ];

  emitMetrics(metrics);
}
