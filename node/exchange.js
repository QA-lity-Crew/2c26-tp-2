import { nanoid } from "nanoid";
import * as state from "./state.js";
import axios from 'axios';
import config from './config.js';
import { emitExchangeMetrics, emitArcaMetrics, emitArcaRetryMetrics, emitArcaOperationMetrics,
  emitArcaProtectionMetrics, emitArcaCircuitTransition } from "./metrics.js";
import { createArcaValidator, readArcaPolicy } from "./arca-retry.js";

export const init = state.init;
export const getAccounts = state.getAccounts;
export const getRates = state.getRates;
export const getLog = state.getLog;
export const setAccountBalance = state.setAccountBalance;

export const EXCHANGE_ERROR_CODES = Object.freeze({
  RATE_CHANGED: "RATE_CHANGED",
  ARCA_ERROR: "ARCA_ERROR",
  ARCA_UNAUTHORIZED: "ARCA_UNAUTHORIZED",
  ARCA_CIRCUIT_OPEN: "ARCA_CIRCUIT_OPEN",
  ARCA_CONCURRENCY_LIMIT: "ARCA_CONCURRENCY_LIMIT",
  INSUFFICIENT_FUNDS: "INSUFFICIENT_FUNDS",
});

const arcaPolicy = readArcaPolicy();
console.info("[ARCA policy]", JSON.stringify(arcaPolicy));
export const validateWithArca = createArcaValidator({
  post: (...args) => axios.post(...args),
  arcaUri: config.arcaUri,
  policy: arcaPolicy,
  emitAttempt: emitArcaMetrics,
  emitRetry: emitArcaRetryMetrics,
  emitOperation: emitArcaOperationMetrics,
  emitProtection: emitArcaProtectionMetrics,
  emitTransition: emitArcaCircuitTransition,
});

export async function setRate({ baseCurrency, counterCurrency, rate }) {
  await state.setRate(baseCurrency, counterCurrency, rate);
}

export async function exchange(exchangeRequest) {
  const {
    baseCurrency,
    counterCurrency,
    baseAccountId: clientBaseAccountId,
    counterAccountId: clientCounterAccountId,
    baseAmount,
    expectedRate,
    dni,
  } = exchangeRequest;

  const exchangeRate = await state.getRate(baseCurrency, counterCurrency);
  const baseAccountId = await state.getAccountIdByCurrency(baseCurrency);
  const counterAccountId = await state.getAccountIdByCurrency(counterCurrency);

  const exchangeResult = {
    id: nanoid(),
    ts: new Date(),
    ok: false,
    request: exchangeRequest,
    exchangeRate,
    counterAmount: 0.0,
    obs: null,
    error: null,
    arcaOk: false,
    arcaAuthCode: null,
    dni: String(dni),
  };

  // 1. Validación de cumplimiento fiscal ante ARCA
  const arcaResult = await validateWithArca(dni);
  // Tambien queda en el log existente, con metadatos de cada intento sin duplicar fondos.
  exchangeResult.arcaPolicy = arcaResult.policy;
  exchangeResult.arcaAttempts = arcaResult.attempts;
  exchangeResult.arcaRecovered = arcaResult.recovered;
  exchangeResult.arcaAttemptResults = arcaResult.attemptResults;
  exchangeResult.arcaFirstAttemptRetryable = arcaResult.firstAttemptRetryable;
  exchangeResult.arcaStopReason = arcaResult.stopReason;
  exchangeResult.arcaDurationMs = arcaResult.durationMs;
  exchangeResult.arcaQueued = arcaResult.queued;
  exchangeResult.arcaQueueWaitMs = arcaResult.queueWaitMs;
  exchangeResult.arcaBackoffMs = arcaResult.backoffMs;
  exchangeResult.arcaHttpTimeMs = arcaResult.httpTimeMs;
  exchangeResult.arcaCircuitState = arcaResult.circuitState;

  if (['circuit_open', 'concurrency_rejected'].includes(arcaResult.status)) {
    exchangeResult.error = arcaResult.status === 'circuit_open'
      ? EXCHANGE_ERROR_CODES.ARCA_CIRCUIT_OPEN : EXCHANGE_ERROR_CODES.ARCA_CONCURRENCY_LIMIT;
    exchangeResult.obs = arcaResult.obs;
    exchangeResult.retryAfterSeconds = arcaResult.retryAfterSeconds;
    await state.appendLog(exchangeResult);
    return exchangeResult;
  }

  if (!arcaResult.ok) {
    // Falla de red, timeout o error interno de ARCA (500)
    exchangeResult.error = EXCHANGE_ERROR_CODES.ARCA_ERROR;
    exchangeResult.obs = arcaResult.obs;
    await state.appendLog(exchangeResult);
    return exchangeResult;
  }

  if (!arcaResult.approved) {
    // ARCA respondió 200 pero rechazó al contribuyente por restricciones fiscales
    exchangeResult.error = EXCHANGE_ERROR_CODES.ARCA_UNAUTHORIZED;
    exchangeResult.obs = arcaResult.obs;
    exchangeResult.arcaOk = false;
    await state.appendLog(exchangeResult);
    return exchangeResult;
  }

  // Aprobado por ARCA
  exchangeResult.arcaOk = true;
  exchangeResult.arcaAuthCode = arcaResult.authCode;

  // 2. Control de slippage contractual (expectedRate)
  if (expectedRate !== exchangeRate) {
    exchangeResult.error = EXCHANGE_ERROR_CODES.RATE_CHANGED;
    exchangeResult.obs = "The expected exchange rate is no longer available";
    await state.appendLog(exchangeResult);
    return exchangeResult;
  }

  const counterAmount = baseAmount * exchangeRate;

  // 3. Reserva atómica en Redis (Script Lua) y transferencias bancarias
  if (await state.reserveFunds(counterAccountId, counterAmount)) {
    if (await transfer(clientBaseAccountId, baseAccountId, baseAmount)) {
      if (await transfer(counterAccountId, clientCounterAccountId, counterAmount)) {
        // Todo OK: acreditar cuenta base propia
        await state.addFunds(baseAccountId, baseAmount);
        exchangeResult.ok = true;
        exchangeResult.counterAmount = counterAmount;
      } else {
        // Rollback: compensar reserva y devolver fondos al cliente
        await state.addFunds(counterAccountId, counterAmount);
        await transfer(baseAccountId, clientBaseAccountId, baseAmount);
        exchangeResult.obs = "Could not transfer to clients' account";
      }
    } else {
      // Rollback de la reserva
      await state.addFunds(counterAccountId, counterAmount);
      exchangeResult.obs = "Could not withdraw from clients' account";
    }
  } else {
    exchangeResult.error = EXCHANGE_ERROR_CODES.INSUFFICIENT_FUNDS;
    exchangeResult.obs = "Not enough funds on counter currency account";
  }

  // 4. Persistir log en Redis y emitir métricas de negocio
  await state.appendLog(exchangeResult);
  if (exchangeResult.ok) {
    emitExchangeMetrics(exchangeResult);
  }

  return exchangeResult;
}

async function transfer(fromAccountId, toAccountId, amount) {
  const min = 200;
  const max = 400;
  return new Promise((resolve) =>
    setTimeout(() => resolve(true), Math.random() * (max - min + 1) + min)
  );
}
