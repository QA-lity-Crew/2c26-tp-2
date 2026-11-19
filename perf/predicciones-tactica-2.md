# Prediccion de Tactica 2 Proteccion de ARCA

## Objetivo y evidencia de partida


Mejorar recuperacion ante fallos transitorios y contener recursos cuando ARCA falla de manera persistente o demora. El objetivo es disponibilidad y robustez; los rechazos locales no se cuentan como intercambios completados.


Las corridas previas de retencion de Redis contienen unos 25% de HTTP 502 entre las respuestas recibidas: 149.549/600.364 y 150.880/603.107, en `feat/pruebas-carga-f1` @ `e0d038bfd01071f962f73ce76a9cc8ee7a51c7e3`. El CPU maximo observado de ARCA fue aproximadamente 81% en la carga alta. Estos datos justifican estudiar recuperacion y proteccion, pero no prueban que los errores sean transitorios ni que ARCA haya saturado.


## Una estrategia con tres mecanismos coordinados


1. Retry: hasta tres intentos para HTTP 500/502/503/504 de ARCA; esperas 100-150 y 200-300 ms, timeout por intento hasta 2.000 ms y presupuesto de validacion de 2.500 ms. No se reintenta el intercambio completo, un rechazo fiscal, un timeout ni un fallo de red.
2. Circuit breaker local: ventana de los ultimos 20 resultados finales relevantes, despues de retries. Abre si al menos 80% son fallos tecnicos finales. Cuenta 5xx, HTTP 429, red y timeout; no cuenta 4xx ajenos a disponibilidad. Una respuesta fiscal valida, incluso rechazo, es un resultado sano. Se usa 80% en lugar de 50% para ser conservadores frente a la fraccion de errores ya observada; el umbral inicial debe contrastarse.
3. Limite de concurrencia: hasta 150 validaciones activas por proceso Node. Un cupo abarca la validacion completa, incluyendo sus backoffs, y se libera antes de las transferencias bancarias. No se agrega cola de espera: el excedente responde 503. Hoy hay un proceso por VM, por lo que equivale a 150 por instancia y hasta 300 entre las dos. No es un limite de solicitudes por segundo ni un cupo global compartido.


CB abierto: 5.000 ms sin admitir nuevas llamadas. Las llamadas ya en vuelo pueden terminar; los retries pendientes vuelven a comprobar el circuito antes de llamar. Luego se permite un unico sondeo por instancia, sin retries. Una aprobacion o rechazo fiscal valido cierra; un fallo tecnico vuelve a abrir otros 5 segundos. El estado se reinicia al reiniciar el proceso.


La API responde 503 con `ARCA_CIRCUIT_OPEN` o `ARCA_CONCURRENCY_LIMIT` y Retry-After orientativo. Un rechazo de admision hace cero llamadas a ARCA; una validacion que se interrumpe porque el CB se abre durante su backoff puede haber hecho un intento previo. Ninguno reserva fondos y ambos se registran en el log. Un fallo remoto final sigue siendo 502. Medir solo la caida de 502 seria incorrecto: sumar los 503 y contar operaciones exitosas.


## Entorno y casos comparables


Franco ejecutara las corridas de Azure desde su maquina y conexion habitual en CABA, con las mismas dos VM Standard_F1als_v7 en westus2, mismo Redis y ARCA. Base: retencion de 50.000 entradas. Ambas corridas usan el mismo codigo e instrumentacion nuevos; cambia solo `arca_protection=off` frente a `arca_protection=on`. No se cambia Terraform ni el simulador de ARCA.


Escenario: `perf/exchange-arca-retry.yaml`, 30 segundos a 100 solicitudes/s y 180 segundos a 500 solicitudes/s, unas 93.000 solicitudes ofrecidas. USD a ARS, importe 1, tasa 1513, DNI aleatorio uniforme 1.000.000-99.999.999, pool 2.000 y timeout del generador 10 s. Se repone el saldo ARS a mil millones antes de cada corrida y no se limpia el log.


## Predicciones de carga nominal antes de medir


| Metrica | Control completo desactivado | Estrategia completa activa |
| --- | --- | --- |
| 502 sobre respuestas, si se mantiene el patron previo | 20-30% | Menos de 10% si hay fallos recuperables |
| 502 + 503 sobre respuestas | 20-30% | Menos de 10% bajo igual supuesto y sin rechazo significativo del limite |
| 200 sobre respuestas | 45-55% | 60-70% bajo igual supuesto |
| Intentos por operacion, contando los rechazos de cero intentos | 1,00 | 1,20-1,45 en carga nominal |
| 503 locales en carga nominal | 0 | Menos de 1% |
| Aperturas del CB con errores independientes recuperables | 0 | Esperamos 0; si se abre, analizar el patron observado |
| Validaciones activas por proceso | Sin cota nueva | Nunca mas de 150 por el control de admision |
| p95 de intercambios 200 | Menos de 1.600 ms | Menos de 2.000 ms; puede subir |
| CPU de ARCA a 500 solicitudes/s | Menos de 60% | Menos de 60%, posiblemente mayor por los retries |
| Errores de red del generador | Menos de 1% | Menos de 1% |
| 500 por OOM de Redis | 0 | 0 |


Con q=0,25 de fallo independiente por intento, tres intentos dan q^3=1,5625% de fallo final y 1+q+q^2=1,3125 intentos por validacion admitida. Es una hipotesis, no una propiedad conocida del simulador. Si el fallo depende del DNI, se correlaciona o hay sobrecarga, puede no cumplirse y el CB puede perjudicar otras operaciones al abrir; ese resultado tambien debe informarse.


El limite 150 se elige como punto inicial con margen, no como capacidad medida de ARCA. A 500 solicitudes/s y dos nodos, estimando unos 0,4 s de validacion media con retries y backoff, Little sugiere aproximadamente 100 validaciones concurrentes por nodo. Un limite de 150 deja margen para variacion y desequilibrio, pero impide crecimiento ilimitado durante demoras. El balanceador no garantiza reparto exacto y la duracion media puede cambiar: hay que medir admision y rechazos.


## Predicción Táctica 2 BIS: concurrencia con espera y ajuste del cupo

### Observaciones de la primera corrida

La primera corrida de T2 mostró que el límite de 150 validaciones simultáneas por instancia se alcanzaba en ambos nodos. Al agotarse los cupos, la implementación rechazaba inmediatamente las solicitudes adicionales, sin dejarlas esperando.

Se registraron 445.957 respuestas HTTP 503, equivalentes al 60,26% de las solicitudes. Los intercambios exitosos disminuyeron de 298.108 en la segunda corrida de T1 a 188.262 con T2. El Circuit Breaker permaneció cerrado según las capturas disponibles: los rechazos masivos se debieron al límite de concurrencia.

La mediana global de 194,4 ms estuvo influida por esos rechazos rápidos. El p95 de los intercambios exitosos fue de 1.465,9 ms, por lo que la menor latencia global no representó una mejora equivalente para las operaciones completadas.

Estos resultados motivan revisar tanto la política de admisión como la cantidad de cupos, conservando la evidencia y la predicción anteriores.

### Ajustes hechos

1. **Agregar espera:** cuando todos los cupos estén ocupados, las nuevas solicitudes esperarán en una cola FIFO local. Al liberarse un cupo, continuará la solicitud más antigua cuyo plazo siga vigente.
2. **Acotar la acumulación:** cada instancia admitirá hasta 1.000 solicitudes pendientes, con un máximo nominal de 1.000 ms de espera. Si la cola está llena o vence ese plazo, responderá 503.
3. **Aumentar la concurrencia a 200 validaciones por instancia:** con dos instancias y un proceso Node por instancia, serán hasta 400 validaciones activas entre ambas.
4. **Conservar retries y Circuit Breaker:** cada validación seguirá ocupando su cupo durante los intentos y backoffs. Si abre el CB, también se rechazarán las solicitudes pendientes en la cola, sin enviarlas a ARCA.

El presupuesto de validación de 2.500 ms comienza al obtener el cupo. Sumado a la espera, esta etapa podrá consumir hasta 3.500 ms nominales; ese tiempo no incluye las transferencias posteriores ni otras tareas de `/exchange`.

### Fundamento del nuevo cupo

En la primera corrida, ARCA mostraba alrededor de 288 millicores de los 500 asignados, aproximadamente un 58% de CPU, mientras ambas instancias alcanzaban su límite de concurrencia.

Esto sugiere margen para ensayar un aumento moderado, aunque la CPU por sí sola no demuestra capacidad disponible. Pasar de 150 a 200 cupos representa un incremento del 33%. Si el consumo creciera proporcionalmente, ARCA podría aproximarse al 77% de CPU. Esta extrapolación es una hipótesis que deberá contrastarse con latencia y errores.

El valor 200 se propone como siguiente punto de prueba, no como una capacidad sostenible ya medida de ARCA.

### Predicciones antes de medir

| Métrica | Predicción |
|---|---|
| Validaciones activas | No superarán 200 por instancia; esperamos alcanzar el cupo durante la carga alta. |
| Cola | Esperamos observar solicitudes pendientes durante la rampa alta y la meseta, sin superar 1.000 por instancia. |
| Rechazos | Mientras haya lugar en la cola, encontrar los 200 cupos ocupados no provocará un rechazo inmediato. Bajo sobrecarga sostenida podrán aparecer 503 por cola llena o espera vencida. |
| Latencia | Esperamos que la mediana global aumente respecto de 194,4 ms si predominan las solicitudes que esperan. Con cola sostenida, estimamos un p95 de HTTP 200 de entre 2.000 y 3.000 ms en la meseta. |
| Intercambios exitosos | En un entorno comparable, esperamos superar los 188.262 HTTP 200 de la primera corrida de T2 por el aumento del cupo, siempre que ARCA sostenga la carga adicional. No se garantiza recuperar los aproximadamente 298.000 de T1. |
| Recursos | ARCA podría consumir más CPU al recibir más tráfico. La memoria de nuestra app también podría aumentar por las solicitudes pendientes. Esperamos ausencia de OOM y de HTTP 500, a verificar con métricas y logs. |
| Circuit Breaker | Esperamos que permanezca cerrado si los fallos finales siguen siendo bajos. Si no abre, esta corrida tampoco validará su recuperación ante una caída persistente. |

### Escenario y evaluación

Se reutilizará `exchange-saturation-3000.yaml`, con la misma carga programada que en las pruebas anteriores. Se registrarán el entorno real, los commits ejecutados y los horarios de medición.

Se compararán intercambios exitosos, throughput, p95 de HTTP 200, causas de los 503, espera en cola, recuperaciones, estado del CB y recursos de la app y ARCA.

Esta corrida modifica dos factores: agrega espera y aumenta el cupo de 150 a 200. Por ello no permitirá aislar el aporte individual de cada ajuste. Si además cambia el generador, la conexión o la infraestructura respecto de Franco, esas diferencias también limitarán la comparación.

Una cola puede absorber ráfagas, pero no aumenta por sí misma la capacidad sostenida del servicio. Si predominan los vencimientos y no aumentan las operaciones completadas, el resultado indicará principalmente un traslado del costo desde el rechazo inmediato hacia la espera.
