# Predicción de Táctica 2: protección de ARCA

## Objetivo y evidencia de partida

Buscamos recuperar fallos transitorios y contener las validaciones pendientes hacia ARCA. El objetivo es robustez y disponibilidad, con el costo posible de rechazar operaciones al alcanzar el cupo. Un rechazo rápido no cuenta como intercambio completado ni demuestra por sí solo mayor disponibilidad de negocio.

La referencia son las dos corridas anteriores con retención de 50.000 entradas en Redis, disponibles en `feat/pruebas-carga-f1` @ `e0d038bfd01071f962f73ce76a9cc8ee7a51c7e3`:

| Métrica observada | Corrida 1 de T1 | Corrida 2 de T1 |
| --- | --- | --- |
| Solicitudes registradas | 740.006 | 740.006 |
| Respuestas recibidas | 600.364 | 603.107 |
| HTTP 200 | 297.787 | 298.108 |
| HTTP 422 | 153.028 | 154.119 |
| HTTP 502 | 149.549 | 150.880 |
| HTTP 500 / 503 | 0 / 0 | 0 / 0 |
| 502 sobre respuestas recibidas | 24,910% | 25,017% |
| Errores de red sobre solicitudes registradas | 18,870% | 18,500% |
| p95 de respuestas 200 | 1.353,1 ms | 1.353,1 ms |

Fuentes: `perf/results/tactica-1-2nodos-corrida-1.json` y `perf/results/tactica-1-2nodos-corrida-2.json`.

Los 502 evidencian fallos técnicos al consultar ARCA, pero el reporte no distingue errores HTTP remotos, timeouts y problemas de comunicación ni prueba que sean transitorios. Los 422 son rechazos fiscales válidos.

El máximo de CPU de ARCA de 403 millicores sobre 500 asignados (80,6%) proviene del caso escalado del 16/11, documentado en `evidencia/2-nodos/3000rps/arca-cpu-usage.txt`. No se atribuye a estas corridas de T1 del 18/11.

## Configuración que se va a medir

Se utiliza la estrategia completa durante toda la corrida: `arca_protection=on`, `arca_max_retries=2` y `arca_max_concurrent=150`.

1. **Retries:** hasta tres intentos para HTTP 500/502/503/504 de ARCA, con esperas de 100–150 y 200–300 ms. Timeout por intento de hasta 2.000 ms y presupuesto total de validación de 2.500 ms. Se respeta Retry-After si cabe en ese presupuesto. No se reintentan rechazos fiscales, errores de red, timeouts ni el intercambio completo.
2. **Circuit breaker:** ventana de 20 resultados finales relevantes, después de retries; abre con al menos 80% de fallos técnicos. Cuenta 5xx, 429, red y timeout. Una respuesta fiscal válida, incluso rechazo, es sana. Abre durante 5 segundos y luego admite un sondeo sin retries por instancia: respuesta fiscal válida cierra; fallo técnico reabre. Los retries pendientes vuelven a comprobar el circuito antes de llamar; las llamadas en vuelo pueden finalizar.
3. **Concurrencia:** hasta 150 validaciones activas por proceso, incluyendo backoffs. El cupo se libera antes de las transferencias. El excedente se rechaza sin cola nueva. Con un proceso Node por VM, equivale a 150 por instancia y hasta 300 entre las dos; no es un límite de solicitudes por segundo ni un cupo global.

Los rechazos locales devuelven 503 con `ARCA_CONCURRENCY_LIMIT` o `ARCA_CIRCUIT_OPEN`, no reservan fondos y se registran en el log. El ingreso rechazado hace cero llamadas a ARCA; un retry suspendido puede haber hecho intentos previos. El fallo remoto final sigue siendo 502 y el rechazo fiscal válido, 422.

## Escenario

2 nodos (`instances = 2`, `Standard_F1als_v7`), mismo Redis, mismo ARCA y misma región que el caso escalado. Se despliega la rama con la táctica y se corre `exchange-saturation-3000.yaml`. Antes de la corrida se repone el saldo de la cuenta 1, como en las pruebas anteriores.

## Predicciones antes de medir

La hipótesis principal es que el cupo de 150 resulte observable bajo carga alta: contenga validaciones pendientes y rechace parte del tráfico. No se supone que aumente el throughput exitoso ni que elimine los errores de ARCA.

| Métrica o comportamiento | Predicción para la única corrida con T2 |
| --- | --- |
| Validaciones activas por proceso | No superan 150; esperamos aproximarnos al cupo en la rampa alta. |
| Rechazos por concurrencia | Esperamos observarlos en la rampa alta y la meseta de 60 s. No se fija un porcentaje mínimo porque todavía no se midió la duración de validación bajo esta configuración. |
| p95 de respuestas 200 de la corrida completa | Menor de 2.000 ms; puede aumentar respecto de los 1.353,1 ms anteriores por los retries. |
| Aperturas del CB | Esperamos 0 si los fallos finales admitidos siguen cerca de 25% y no hay ráfagas concentradas. Puede abrir si fallan al menos 16 de los últimos 20 resultados relevantes. |
| HTTP 500 de arVault y reinicios por OOM | Esperamos 0. Si aparecen, investigar la causa con logs. |
| HTTP 502 y 503 | Los 502 pueden bajar por recuperación o menor tráfico a ARCA; los 503 pueden subir por el cupo. No se predice una reducción garantizada de 502+503. |
| Throughput de HTTP 200 | Puede disminuir si 150 resulta demasiado restrictivo. Más respuestas totales por rechazos rápidos no se contará como mayor negocio completado. |
| CPU y memoria | Esperamos contención de validaciones pendientes, pero no necesariamente menor CPU de la app: también procesa y registra los rechazos. El cupo no limita toda su memoria. Registrar CPU de ARCA considerando que los retries agregan trabajo. |
| Errores de red del generador | Pueden seguir siendo significativos, como el 18,5–18,9% previo. Se distinguen de los rechazos HTTP de la app. |

## Razonamiento

El cupo 150 fue elegido inicialmente para una carga menor, no medido como capacidad de ARCA. A 3.000 solicitudes/s y reparto ideal, cada VM recibiría 1.500/s: una validación media de 100 ms bastaría para ocupar 150 cupos. Si llegan unas 2.000/s entre ambas VM, harían falta unos 150 ms medios. La latencia completa de `/exchange` no equivale a la duración de validación de ARCA.

Con fallos independientes por intento de probabilidad q=0,25, tres intentos darían q³=1,5625% de fallo final y 1+q+q²=1,3125 intentos por validación admitida. Si el error persiste por DNI, es de red, no admite retry o se agrava por carga, ese beneficio no se cumple. El cálculo no predice directamente el porcentaje global de 502+503, que incluye rechazos locales.

El CB cuenta resultados finales admitidos, no los 503 del limitador ni cada error intermedio de una validación recuperada. Un 25% global de 502 no garantiza alcanzar su umbral local de 80% sobre 20 resultados.
