import dgram from "dgram";
import { readArcaPolicy } from "./arca-retry.js";
const ACTIVE_POLICY = readArcaPolicy().policy;

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

  const recovery = exchangeResult.arcaRecovered ? 'after_retry' : 'first_attempt';
  emitMetrics(metrics.map(line => `${line}|#policy:${ACTIVE_POLICY},recovery:${recovery}`));
}

/**
 * Emits telemetry specifically for ARCA external service validations.
 * @param {Object} arcaTelemetry
 * @param {boolean} arcaTelemetry.ok - If ARCA approved the transaction
 * @param {boolean} arcaTelemetry.authorized - If status code was 200 and approved
 * @param {number} arcaTelemetry.durationMs - Latency of the HTTP request to ARCA in ms
 * @param {string} arcaTelemetry.status - "approved" | "rejected" | "timeout" | "error"
 */
export function emitArcaMetrics({ durationMs, status, policy, attempt, errorType }) {
  const tags = `policy:${policy},attempt:${attempt},error_type:${errorType}`;
  emitMetrics([
    `arca.validation.latency:${durationMs}|ms|#${tags}`,
    `arca.validation.count:1|c|#status:${status},${tags}`,
    `arca.validation.${status}:1|c|#${tags}`,
  ]);
}

export function emitArcaRetryMetrics({ policy, attempt, delayMs }) {
  emitMetrics([
    `arca.retry.count:1|c|#policy:${policy},attempt:${attempt}`,
    `arca.retry.delay:${delayMs}|ms|#policy:${policy},attempt:${attempt}`,
  ]);
}

export function emitArcaOperationMetrics({ policy, status, durationMs, attempts, recovered,
  firstAttemptRetryable, stopReason, backoffMs, httpTimeMs }) {
  const technicalError = status === 'error' || status === 'timeout';
  const localRejection = status === 'circuit_open' || status === 'concurrency_rejected';
  emitMetrics([
    `arca.operation.count:1|c|#policy:${policy},status:${status},attempts:${attempts},stop_reason:${stopReason}`,
    `arca.operation.latency:${durationMs}|ms|#policy:${policy}`,
    `arca.operation.attempts_total:${attempts}|c|#policy:${policy}`,
    `arca.operation.technical_error:${technicalError ? 1 : 0}|c|#policy:${policy}`,
    `arca.operation.unavailable:${technicalError || localRejection ? 1 : 0}|c|#policy:${policy}`,
    `arca.operation.recovered:${recovered ? 1 : 0}|c|#policy:${policy},status:${status}`,
    `arca.operation.retry_eligible:${firstAttemptRetryable ? 1 : 0}|c|#policy:${policy}`,
    `arca.operation.backoff:${backoffMs}|ms|#policy:${policy}`,
    `arca.operation.http_time:${httpTimeMs}|ms|#policy:${policy}`,
  ]);
}

export function emitArcaProtectionMetrics({ policy, state, active, limit }) {
  const stateCode = { disabled: -1, closed: 0, open: 1, half_open: 2 }[state];
  emitMetrics([
    `arca.protection.inflight:${active}|g|#policy:${policy}`,
    `arca.protection.limit:${limit}|g|#policy:${policy}`,
    `arca.circuit.state:${stateCode}|g|#policy:${policy}`,
  ]);
}

export function emitArcaCircuitTransition({ policy, previous, state }) {
  emitMetrics([`arca.circuit.transition:1|c|#policy:${policy},state:${state}`]);
  console.info('[ARCA circuit]', JSON.stringify({ previous, state }));
}

