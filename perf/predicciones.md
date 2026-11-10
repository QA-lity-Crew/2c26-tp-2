# Predicciones de rendimiento

## Caso 1 nodo

Escenario `perf/exchange-ramp.yaml` (hasta 30 req/s, ~3000 requests). 1 VM `Standard_B2ats_v2`, Redis administrado y ARCA con 0.5 vCPU, todo en `westus2`. El generador corre desde Argentina.

### Predicción

| Métrica | Valor |
|---|---|
| Mediana de respuestas 200 | 1000-1200 ms |
| p95 de respuestas 200 | 1.4-1.7 s |
| Mediana de respuestas 422 | 300-500 ms |
| 422 (ARCA rechaza el DNI) | 25-30% |
| 5xx (falla de ARCA) | 5-8% |
| Timeouts | 0 |
| CPU de la VM | < 30% |

### Razonamiento

* **Red y ARCA:** un `curl` a `/` tarda ~370 ms (conexión nueva), y a `/:dni`, que pasa por ARCA, ~600-850 ms. Con conexiones reutilizadas la red es ~190 ms, y ARCA agrega ~250-400 ms.
* **Respuestas 200:** pasan por `transfer()` dos veces (200-400 ms cada una, como en el TP1), así que a la red y a ARCA (~250-400 ms) se les suman ~600 ms.
* **Respuestas 422:** terminan en ARCA y no llegan a `transfer()`, por eso son más rápidas.
* **Errores:** salen de probar ~30 DNIs al azar contra `/:dni`: ~70% aprobó, ~23% rechazó y ~7% falló.
* **Cuello de botella:** a 30 req/s hay ~30 requests en vuelo y Node espera casi todo el tiempo (en el TP1 aguantó ~500 req/s con 1 CPU), así que no esperamos que sature. Si algo se degrada, será ARCA por su límite de CPU.
