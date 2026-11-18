import { nanoid } from "nanoid";
import * as state from "./state.js";
import axios from 'axios';
import config from './config.js';
import { emitExchangeMetrics, emitArcaMetrics } from "./metrics.js";

export const init = state.init;
export const getAccounts = state.getAccounts;
export const getRates = state.getRates;
export const getLog = state.getLog;
export const setAccountBalance = state.setAccountBalance;

export const EXCHANGE_ERROR_CODES = Object.freeze({
  RATE_CHANGED: "RATE_CHANGED",
  ARCA_ERROR: "ARCA_ERROR",
  ARCA_UNAUTHORIZED: "ARCA_UNAUTHORIZED",
  INSUFFICIENT_FUNDS: "INSUFFICIENT_FUNDS",
});

// Timeout estricto para proteger la API ante degradación de ARCA (2000 ms)
const ARCA_TIMEOUT_MS = 2000;

export async function setRate({ baseCurrency, counterCurrency, rate }) {
  await state.setRate(baseCurrency, counterCurrency, rate);
}

/**
 * Valida un DNI contra el servicio externo ARCA.
 * Maneja timeouts, respuestas no-200 y emite telemetría StatsD.
 */
async function validateWithArca(dni) {
  const startTime = Date.now();
  let durationMs = 0;

  try {
    const response = await axios.post(
      `${config.arcaUri}/validar`,
      { dni: String(dni) },
      { timeout: ARCA_TIMEOUT_MS }
    );
    durationMs = Date.now() - startTime;

    if (response.status === 200 && response.data) {
      // Soporta booleano nativo o string "true"
      const isApproved = response.data.ok === true || response.data.ok === "true";
      const authCode = response.data.codigoAutorizacion || null;

      emitArcaMetrics({
        durationMs,
        status: isApproved ? "approved" : "rejected",
      });

      return {
        ok: true,
        approved: isApproved,
        authCode,
        obs: isApproved ? null : "ARCA did not authorize the transaction (fiscal restrictions)",
      };
    }

    emitArcaMetrics({ durationMs, status: "error" });
    return {
      ok: false,
      approved: false,
      authCode: null,
      obs: `Unexpected status ${response.status} from ARCA`,
    };
  } catch (error) {
    durationMs = Date.now() - startTime;
    const isTimeout = error.code === "ECONNABORTED" || error.message?.includes("timeout");
    const statusTag = isTimeout ? "timeout" : "error";

    emitArcaMetrics({ durationMs, status: statusTag });

    console.error(`[ARCA] Error validating DNI ${dni} (${statusTag}):`, error.message);
    return {
      ok: false,
      approved: false,
      authCode: null,
      obs: isTimeout ? "ARCA validation timed out" : "Exception communicating with ARCA service",
    };
  }
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
