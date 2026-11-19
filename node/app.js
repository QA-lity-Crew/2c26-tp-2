import express from 'express';

import {
  init as exchangeInit,
  getAccounts,
  setAccountBalance,
  getRates,
  setRate,
  getLog,
  exchange,
  EXCHANGE_ERROR_CODES,
  validateWithArca,
} from "./exchange.js";

await exchangeInit();

const app = express();
const port = 3000;

app.use(express.json());

app.get('/', (req, res) => {
    res.status(200).send('Server is up.');
});

// ACCOUNT endpoints

app.get("/accounts", async (req, res) => res.json(await getAccounts()));

app.put("/accounts/:id/balance", async (req, res) => {
  const { balance } = req.body;

  if (!req.params.id || balance === undefined || balance === null) {
    return res.status(400).json({ error: "Malformed request" });
  }

  await setAccountBalance(req.params.id, balance);
  res.json(await getAccounts());
});

// RATE endpoints

app.get("/rates", async (req, res) => res.json(await getRates()));

app.put("/rates", async (req, res) => {
  const { baseCurrency, counterCurrency, rate } = req.body;

  if (!baseCurrency || !counterCurrency || !rate) {
    return res.status(400).json({ error: "Malformed request" });
  }
    
  await setRate(req.body);
  res.json(await getRates());
});

// LOG endpoint

app.get("/log", async (req, res) => res.json(await getLog()));

// EXCHANGE endpoint

app.post("/exchange", async (req, res) => {
  const {
    baseCurrency,
    counterCurrency,
    baseAccountId,
    counterAccountId,
    baseAmount,
    expectedRate,
    dni,
  } = req.body;

  if (
    !baseCurrency ||
    !counterCurrency ||
    !baseAccountId ||
    !counterAccountId ||
    !baseAmount ||
    !Number.isFinite(expectedRate) ||
    expectedRate <= 0 ||
    !dni
  ) {
    return res.status(400).json({ error: "Malformed request" });
  }

  const exchangeRequest = { ...req.body };
  const exchangeResult = await exchange(exchangeRequest);

  if (exchangeResult.ok) {
    res.status(200).json(exchangeResult);
  } else if ([EXCHANGE_ERROR_CODES.ARCA_CIRCUIT_OPEN,
    EXCHANGE_ERROR_CODES.ARCA_CONCURRENCY_LIMIT].includes(exchangeResult.error)) {
    res.set('Retry-After', String(exchangeResult.retryAfterSeconds || 1));
    res.status(503).json(exchangeResult);
  } else if (exchangeResult.error === EXCHANGE_ERROR_CODES.RATE_CHANGED) {
    res.status(409).json(exchangeResult);
  } else if (exchangeResult.error === EXCHANGE_ERROR_CODES.ARCA_UNAUTHORIZED) {
    // Restricción fiscal del usuario devuelta por ARCA
    res.status(422).json(exchangeResult);
  } else if (exchangeResult.error === EXCHANGE_ERROR_CODES.ARCA_ERROR) {
    // Timeout, indisponibilidad o falla de red con ARCA
    res.status(502).json(exchangeResult);
  } else if (exchangeResult.error === EXCHANGE_ERROR_CODES.INSUFFICIENT_FUNDS) {
    res.status(400).json(exchangeResult);
  } else {
    res.status(500).json(exchangeResult);
  }
});

// ARCA diagnostic endpoint

app.get('/arca/:dni', async (req, res) => {
    // Comparte exactamente el mismo CB y cupos que POST /exchange.
    const result = await validateWithArca(String(req.params.dni));
    if (['circuit_open', 'concurrency_rejected'].includes(result.status)) {
      res.set('Retry-After', String(result.retryAfterSeconds || 1));
      return res.status(503).json({ error: result.status === 'circuit_open'
        ? EXCHANGE_ERROR_CODES.ARCA_CIRCUIT_OPEN : EXCHANGE_ERROR_CODES.ARCA_CONCURRENCY_LIMIT });
    }
    if (!result.ok) return res.status(502).json({ error: EXCHANGE_ERROR_CODES.ARCA_ERROR });
    return res.status(200).json({ ok: result.approved,
      ...(result.authCode ? { codigoAutorizacion: result.authCode } : {}) });
});

app.listen(port, () => {
  console.log(`Exchange API listening on port ${port}`);
});

export default app;

