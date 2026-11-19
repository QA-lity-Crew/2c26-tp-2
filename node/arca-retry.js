import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createArcaProtection } from './arca-protection.js';

const RETRYABLE_HTTP = new Set([500, 502, 503, 504]);
const TERMINAL = new Set(['approved', 'rejected']);

export function readArcaPolicy(env = process.env) {
  const protection = env.ARCA_PROTECTION ?? 'off';
  if (!['off', 'on'].includes(protection)) throw new Error('ARCA_PROTECTION debe ser off u on');
  const raw = env.ARCA_MAX_RETRIES ?? (protection === 'on' ? '2' : '0');
  if (!/^[012]$/.test(raw)) {
    throw new Error('ARCA_MAX_RETRIES debe ser 0, 1 o 2');
  }
  const maxRetries = Number(raw);
  const concurrency = env.ARCA_MAX_CONCURRENT ?? (protection === 'on' ? '150' : '0');
  if (!/^(0|[1-9][0-9]{0,3})$/.test(concurrency) || Number(concurrency) > 1000) {
    throw new Error('ARCA_MAX_CONCURRENT debe ser un entero entre 0 y 1000');
  }
  const circuitEnabled = protection === 'on';
  return Object.freeze({
    maxRetries,
    policy: circuitEnabled || Number(concurrency) > 0 ? 'protected' : maxRetries === 0 ? 'no_retry' : 'retry',
    circuitEnabled,
    maxConcurrent: Number(concurrency),
    // Espera FIFO local antes de adquirir cupo. No requiere cambiar el deploy.
    maxQueued: Number(concurrency) > 0 ? 1000 : 0,
    maxQueueWaitMs: 1000,
    circuitOpenMs: 5000,
    circuitMinSamples: 20,
    circuitFailureRatio: 0.8,
    attemptTimeoutMs: 2000,
    totalTimeoutMs: 2500,
    baseDelayMs: 100,
  });
}

function validationUrl(arcaUri) {
  const base = new URL(arcaUri);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password
      || base.search || base.hash || !['', '/'].includes(base.pathname)) {
    throw new Error('Configuracion de ARCA invalida');
  }
  return new URL('/validar', base).href;
}

function retryAfterMs(headers, wallNow) {
  const raw = headers?.['retry-after'];
  if (raw === undefined) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const when = Date.parse(String(raw));
  return Number.isFinite(when) ? Math.max(0, when - wallNow()) : 0;
}

export function createArcaValidator({
  post,
  arcaUri,
  policy = readArcaPolicy(),
  emitAttempt = () => {},
  emitRetry = () => {},
  emitOperation = () => {},
  emitProtection,
  emitTransition = () => {},
  sleep = delay,
  now = () => performance.now(),
  wallNow = () => Date.now(),
  jitter = randomInt,
}) {
  const url = validationUrl(arcaUri);
  const protection = createArcaProtection({ policy, now,
    onTransition: event => emitTransition({ ...event, policy: policy.policy }) });
  if (emitProtection) {
    const heartbeat = setInterval(() => emitProtection({ ...protection.snapshot(), policy: policy.policy }), 1000);
    heartbeat.unref?.();
  }

  async function runValidation(dni, permit) {
    // Todo estado mutable pertenece a esta validacion, no al worker completo.
    const started = now();
    const attempts = [];
    let final = { ok: false, approved: false, authCode: null,
      obs: 'ARCA service unavailable', status: 'error' };
    let nextDelayMs = 0;
    let backoffMs = 0;
    let firstAttemptRetryable = false;
    let stopReason = 'time_budget';
    let retryAfterSeconds = 0;
    const maxRetries = permit.probe ? 0 : policy.maxRetries;
    function circuitStopped() {
      if (protection.canCall(permit)) return false;
      final = { ok: false, approved: false, authCode: null,
        obs: 'ARCA circuit is temporarily open', status: 'circuit_open' };
      stopReason = 'circuit_open';
      retryAfterSeconds = protection.snapshot().retryAfterSeconds;
      return true;
    }

    for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
      if (circuitStopped()) break;
      let remaining = policy.totalTimeoutMs - (now() - started);
      if (attempt > 1) {
        // No recortar Retry-After para volver a llamar antes de lo pedido.
        if (nextDelayMs >= remaining) { stopReason = 'time_budget'; break; }
        const waiting = now();
        await sleep(nextDelayMs);
        const waitedMs = Math.max(0, now() - waiting);
        backoffMs += waitedMs;
        remaining = policy.totalTimeoutMs - (now() - started);
        if (remaining <= 0) { stopReason = 'time_budget'; break; }
        if (circuitStopped()) break;
        emitRetry({ policy: policy.policy, attempt, delayMs: waitedMs });
      }
      if (remaining <= 0) { stopReason = 'time_budget'; break; }

      const requestStarted = now();
      const timeout = Math.max(1, Math.min(policy.attemptTimeoutMs, Math.floor(remaining)));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      timer.unref?.();
      let response;
      let status = 'error';
      let errorType = 'network';
      let httpStatus = 0;

      try {
        response = await post(url, { dni: String(dni) }, {
          timeout,
          signal: controller.signal,
          maxRedirects: 0,
          validateStatus: () => true,
        });
        httpStatus = response.status;
        if (httpStatus === 200 && response.data) {
          const approved = response.data.ok === true || response.data.ok === 'true';
          status = approved ? 'approved' : 'rejected';
          errorType = 'none';
          final = { ok: true, approved,
            authCode: response.data.codigoAutorizacion || null,
            obs: approved ? null : 'ARCA did not authorize the transaction (fiscal restrictions)',
            status };
        } else {
          errorType = RETRYABLE_HTTP.has(httpStatus) ? `http_${httpStatus}` : 'http_other';
          final = { ok: false, approved: false, authCode: null,
            obs: 'ARCA returned an unexpected response', status };
        }
      } catch (error) {
        const timedOut = controller.signal.aborted || error.code === 'ECONNABORTED'
          || error.code === 'ETIMEDOUT';
        status = timedOut ? 'timeout' : 'error';
        errorType = timedOut ? 'timeout' : 'network';
        final = { ok: false, approved: false, authCode: null,
          obs: timedOut ? 'ARCA validation timed out' : 'Exception communicating with ARCA service',
          status };
      } finally {
        clearTimeout(timer);
      }

      const durationMs = Math.max(0, now() - requestStarted);
      attempts.push({ attempt, status, httpStatus, errorType, durationMs });
      emitAttempt({ durationMs, status, policy: policy.policy, attempt, errorType });
      if (attempt === 1) firstAttemptRetryable = RETRYABLE_HTTP.has(httpStatus);

      // ok:false fiscal, 4xx, red, timeout y respuestas inesperadas son terminales.
      if (TERMINAL.has(status)) { stopReason = 'completed'; break; }
      if (!RETRYABLE_HTTP.has(httpStatus)) { stopReason = 'non_retryable'; break; }
      if (attempt > maxRetries) {
        stopReason = permit.probe ? 'probe_failed' : policy.maxRetries === 0 ? 'disabled' : 'attempt_limit';
        break;
      }

      const base = policy.baseDelayMs * (2 ** (attempt - 1));
      nextDelayMs = Math.max(base + jitter(0, Math.floor(base / 2) + 1),
        retryAfterMs(response?.headers, wallNow));
    }

    const durationMs = Math.max(0, now() - started);
    const recovered = attempts.length > 1 && TERMINAL.has(final.status);
    const httpTimeMs = attempts.reduce((total, attempt) => total + attempt.durationMs, 0);
    return { ...final, policy: policy.policy, attempts: attempts.length,
      attemptResults: attempts, recovered, durationMs, firstAttemptRetryable,
      stopReason, backoffMs, httpTimeMs, retryAfterSeconds };
  }

  function healthOf(result) {
    if (!result || ['circuit_open', 'concurrency_rejected'].includes(result.status)) return 'ignore';
    if (result.ok) return 'success'; // Un rechazo fiscal es una respuesta sana de ARCA.
    const last = result.attemptResults.at(-1);
    if (last && (['timeout', 'network'].includes(last.errorType)
        || (last.httpStatus >= 500 && last.httpStatus <= 599) || last.httpStatus === 429)) return 'failure';
    return 'ignore';
  }

  return async function validateWithArca(dni) {
    const started = now();
    const admission = await protection.acquire();
    let result;
    if (!admission.allowed) {
      const circuit = admission.reason === 'circuit_open';
      result = { ok: false, approved: false, authCode: null,
        obs: circuit ? 'ARCA circuit is temporarily open'
          : admission.reason === 'queue_timeout' ? 'ARCA validation queue wait timed out'
          : 'ARCA validation queue is full',
        status: circuit ? 'circuit_open' : 'concurrency_rejected',
        policy: policy.policy, attempts: 0, attemptResults: [], recovered: false,
        firstAttemptRetryable: false, stopReason: admission.reason,
        backoffMs: 0, httpTimeMs: 0, durationMs: Math.max(0, now() - started),
        retryAfterSeconds: admission.retryAfterSeconds };
    } else {
      try {
        result = await runValidation(dni, admission.permit);
      } finally {
        protection.leave(admission.permit, healthOf(result));
      }
    }
    result.queued = admission.queued;
    result.queueWaitMs = admission.queueWaitMs;
    // La operacion incluye espera en cola + validacion. La validacion conserva
    // su presupuesto propio de 2500 ms: como maximo nominal, 1000 + 2500 ms.
    result.durationMs = Math.max(0, now() - started);
    result.circuitState = protection.snapshot().state;
    // La telemetria no recibe DNI, autorizaciones ni el cuerpo completo del resultado.
    const { status, durationMs, attempts, recovered, firstAttemptRetryable,
      stopReason, backoffMs, httpTimeMs, queued, queueWaitMs } = result;
    emitOperation({ policy: policy.policy, status, durationMs, attempts, recovered,
      firstAttemptRetryable, stopReason, backoffMs, httpTimeMs, queued, queueWaitMs });
    return result;
  };
}
