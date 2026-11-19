# Predicciones de la táctica 1: log acotado en Redis

Las predicciones de 1 y 2 nodos están en `perf/predicciones.md` (rama `feat/pruebas-carga-f1`). Este archivo cubre solo la táctica 1 y se commitea antes de medirla.

## Problema que ataca

En el intento 1 del caso de 2 nodos (`exchange-saturation-3000.yaml`), a los ~390 s aparecieron 96.554 respuestas 500, todas por `OOM command not allowed when used memory > 'maxmemory'` de Redis (`evidencia/2-nodos/intento-1/redis-oom.txt`). En ese momento la lista `{app}:log` tenía 1.078.289 entradas y Redis usaba 859.001.312 bytes (819 MB), con política `noeviction`.

`appendLog` agrega una entrada por cada exchange que llega a ARCA (aprobado o rechazado) y nunca borra. Con ~600.000 requests completadas por corrida, una sola corrida agrega ~600.000 entradas (~480 MB). Dos corridas seguidas alcanzan para llenar Redis, aunque se arranque con la lista vacía. No es un efecto de no haber limpiado Redis entre pruebas: en producción la lista también crece con cada operación y nunca se vacía.

## Táctica

`appendLog` ejecuta `RPUSH` + `LTRIM` en un `MULTI`, y conserva solo las últimas `LOG_MAX_ENTRIES` entradas (50.000 por defecto).

## Escenario

2 nodos (`instances = 2`, `Standard_F1als_v7`), mismo Redis, mismo ARCA y misma región que el caso escalado. Se despliega la rama con la táctica y se corre `exchange-saturation-3000.yaml` **dos veces seguidas, sin vaciar `{app}:log` antes ni entre corridas** (~1.200.000 requests completadas en total, más que las 1.078.289 entradas que llenaron Redis en el intento 1). Antes de cada corrida se repone el saldo de la cuenta 1, como en las pruebas anteriores.

Después de cada corrida se toma `LLEN {app}:log` y `INFO memory` con una consulta de solo lectura desde una VM, igual que en `redis-oom.txt`.

## Predicción

| Métrica | Sin táctica (intento 1) | Predicción con táctica |
|---|---|---|
| Respuestas 500 por OOM de Redis | 96.554 | 0, en las dos corridas |
| `LLEN {app}:log` al terminar cada corrida | 1.078.289 | exactamente 50.000 |
| `used_memory` de Redis al terminar cada corrida | 819 MB | menos de 100 MB |
| Throughput efectivo | ~1950 req/s | 1700-2100 req/s, sin cambios |
| Mediana de respuestas 200 | 1153 ms | 1100-1250 ms, sin cambios |
| p95 de respuestas 200 | 1353 ms | 1300-1450 ms, sin cambios |
| Proporción de respuestas 200 | ~49% | 47-51%, sin cambios |
| Errores `EHOSTUNREACH` | 18,5% | 15-25%, sin cambios (es el generador) |

## Razonamiento

* **Memoria:** 859.001.312 bytes / 1.078.289 entradas da ~797 bytes por entrada, contando el overhead de Redis (es una cota superior). Con 50.000 entradas el log ocupa ~40 MB. Las cuentas y las cotizaciones son unas pocas claves. Por eso esperamos menos de 100 MB en total, lejos de los 819 MB donde empezó a rechazar escrituras.
* **Errores 500:** el único origen de los 500 en el intento 1 fue el OOM (48.049 + 48.505 = 96.554, igual al total de 500). Si Redis no se llena, no debería haber 500.
* **Latencia y throughput:** `RPUSH` y `LTRIM` viajan juntos en el mismo `MULTI`, en un solo round trip, igual que el `RPUSH` de antes. Recortar una entrada por la cabeza de la lista es O(1). No esperamos cambios en latencia ni en throughput, y el límite sigue siendo el generador.
* **Respuestas 5xx de ARCA:** el código desplegado en el caso escalado respondía 422 tanto si ARCA rechazaba el DNI como si fallaba. Esta rama incluye el manejo de errores de ARCA (PR #1): un rechazo responde 422 y una falla de ARCA responde 502. Por eso puede aparecer una proporción de 502 que antes se contaba como 422. Esos 502 no se cuentan como falla de la táctica. Predecimos que 422 + 502 sumen 49-53%, lo mismo que sumaban los 422 antes.
* **Riesgo:** si la lista ya tiene muchas entradas cuando se despliega la táctica, el primer `LTRIM` borra todo el excedente de una vez (O(N) sobre lo que borra) y puede bloquear Redis unos cientos de milisegundos. Lo esperamos como un pico aislado al inicio de la primera corrida, no como degradación sostenida.
* **Cómo se refuta:** si aparecen 500 por OOM, si `LLEN` supera 50.000 o si `used_memory` sigue creciendo entre la primera y la segunda corrida, la táctica no funciona.
