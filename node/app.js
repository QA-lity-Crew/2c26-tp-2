import express from 'express';
import axios from 'axios';
import config from './config.js';

import {
  init as exchangeInit,
  getAccounts,
  setAccountBalance,
  getRates,
  setRate,
  getLog,
  exchange,
  EXCHANGE_ERROR_CODES,
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
    try {
        const response = await axios.post(
          `${config.arcaUri}/validar`,
          { dni: String(req.params.dni) },
          { timeout: 2000 }
        );
        res.status(response.status).json(response.data);
    } catch (e) {
        console.error("Exception consuming ARCA service directly:", e.message);
        res.status(502).json({ error: "ARCA service unavailable", message: e.message });
    }
});

app.listen(port, () => {
  console.log(`Exchange API listening on port ${port}`);
});

export default app;
