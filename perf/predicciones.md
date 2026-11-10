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

## Caso 1 nodo, carga alta (`exchange-stress.yaml`)

Mismo sistema y mismo flujo, pero con rampa de 10 a 150 req/s en 120 s y 60 s sostenidos a 150 req/s (~14000 requests). La prueba anterior (30 req/s) no mostró degradación, así que esta busca el punto de quiebre.

### Predicción

| Métrica | Valor |
|---|---|
| Req/s donde empieza a degradarse la latencia | 80-120 req/s |
| Mediana de respuestas 200 a 150 req/s | > 2 s |
| Timeouts / errores de red | sí, en la meseta de 150 req/s |
| 422 | ~50%, sube si ARCA empieza a fallar |
| Primer componente en saturar | ARCA |

### Razonamiento

* **ARCA:** corre con 0.5 vCPU. Con 30 req/s su latencia no cambió respecto de 5 req/s, pero ahora recibirá unas 5 veces más llamadas.
* **VM:** Node usa un solo proceso, así que solo aprovecha un núcleo de los dos. Y la `B2ats_v2` es burstable (baseline de 20% por vCPU), por lo que si la prueba es larga puede agotar créditos. Lo esperamos como segundo candidato.
* **Redis:** esperamos que no sea el límite, porque son pocas operaciones por request.

## Caso 1 nodo, búsqueda del punto de quiebre (`exchange-breakpoint.yaml`)

Mismo flujo, con rampa de 20 a 450 req/s en 180 s y 60 s sostenidos a 450 req/s (~70000 requests). La prueba a 150 req/s no mostró degradación (mediana de 200 en 1153 ms, 0 fallas, CPU máxima de 11,8%), así que esta busca el límite de 1 nodo.

### Predicción

| Métrica | Valor |
|---|---|
| Req/s donde empieza a degradarse la latencia | 350-450 req/s |
| CPU de la VM en la meseta | 30-40% (promedio de los dos núcleos) |
| Errores (timeouts, ECONNRESET) | aparecen en la meseta de 450 req/s |
| Primer componente en saturar | ARCA |

### Razonamiento

* **VM:** la CPU creció de forma lineal, 11,8% a 150 req/s. Extrapolando, a 450 req/s serían ~35% de promedio, o ~70% de un núcleo, que es lo que usa Node con un solo proceso. Queda cerca del límite, pero sin saturar.
* **ARCA:** corre con 0.5 vCPU. A 450 req/s recibe unas 450 llamadas por segundo, 3 veces más que en la prueba anterior, y es el componente con menos margen.
* **Si ARCA satura:** debería verse como más latencia y más errores en las llamadas a `/validar`, que terminan como 422, mientras la CPU de la VM sigue por debajo del 50%.
* **Límite del generador:** Artillery corre con un solo proceso en la computadora de quien lo ejecuta. Si la CPU de esa máquina se satura, el límite es del generador y la prueba no es válida.

## Caso 1 nodo, saturación (`exchange-saturation.yaml`)

Mismo flujo, con pool de conexiones y rampa de 100 a 1500 req/s en 300 s, más 60 s sostenidos a 1500 req/s (~330000 requests). La prueba a 450 req/s no mostró degradación (0 errores, mediana de 200 en 1153 ms) y la CPU de la VM llegó a 27,5%. Esta busca el límite de 1 nodo.

### Predicción

| Métrica | Valor |
|---|---|
| Req/s donde empieza a degradarse la latencia | 700-1000 req/s |
| CPU de la VM | sube hasta ~50% (promedio de los dos núcleos) y se aplana |
| Throughput | se aplana en ~800-1000 req/s, aunque la carga siga subiendo |
| Primer componente en saturar | el proceso único de Node en la VM |

### Razonamiento

* **VM:** la CPU promedio creció a ~0,06% por cada req/s (27,5% a 450 req/s). Node usa un solo proceso, es decir un solo núcleo de los dos, así que ese núcleo llega al 100% (50% de promedio) cerca de los ~800-1000 req/s (la CPU `user` no cuenta el tiempo del kernel por la red, así que el límite real puede estar un poco antes).
* **Cómo se ve si satura Node:** la CPU promedio se aplana en ~50% mientras la carga sigue subiendo, y la latencia empieza a crecer.
* **Alternativa:** la `B2ats_v2` es burstable, con baseline de 20% por vCPU. Si se agotan los créditos, la CPU se aplanaría en ~20% de promedio, y no en ~50%.
* **ARCA:** no mostró señales de saturación hasta 450 req/s (latencia sin cambios). La esperamos como segundo candidato.
* **Límite del generador:** con 1500 req/s Artillery puede saturar la computadora de quien lo corre. Si su CPU llega al 100% o aparecen errores de red desde el inicio, la prueba no vale.
* **Cómo distinguir VM de ARCA:** si la latencia sube y la CPU de la VM se aplana en ~50%, el límite es Node. Si la latencia sube pero la CPU de la VM queda por debajo del 50%, el límite es ARCA.
* **Saldo de la cuenta:** cada operación aprobada descuenta 1513 ARS de la cuenta 1. Antes de correr se repone el saldo (PUT `/accounts/1/balance`) para que no se agote durante la prueba.
