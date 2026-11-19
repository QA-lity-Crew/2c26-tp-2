# Predicciones de rendimiento

## Caso 1 nodo (`exchange-saturation.yaml`)

1 VM `Standard_F1als_v7` (1 vCPU, 2 GiB, sin créditos de CPU), Redis administrado y ARCA con 0.5 vCPU, todo en `westus2`. El generador (Artillery) corre desde Argentina. Pool de conexiones y rampa de 100 a 1500 req/s en 300 s, más 60 s sostenidos a 1500 req/s (~330000 requests).

### Predicción

| Métrica | Valor |
|---|---|
| Req/s donde empieza a degradarse la latencia | 600-900 req/s |
| CPU de la VM | sube hasta ~100% de 1 vCPU y se aplana |
| Throughput | se aplana en 900-1300 req/s, aunque la carga siga subiendo |
| Mediana de respuestas 200 en la meseta de 1500 req/s | > 2 s |
| Errores del servicio (timeouts, ECONNRESET) | sí, en la meseta |
| 5xx de ARCA | 0 |
| CPU de ARCA en la meseta | 200-260 millicores (40-55%) |
| Primer componente en saturar | el proceso único de Node en la VM |

### Razonamiento

* **VM:** estimamos ~0,8 ms de CPU por request (a partir de mediciones en otra VM de la misma región). Con un solo vCPU, el núcleo se llena cerca de 1000-1300 req/s. El agente de Datadog y el kernel (red) comparten ese vCPU, por lo que el límite real puede estar antes. No sabemos si el núcleo de esta familia es más rápido o más lento, por eso los rangos son amplios.
* **Cómo se ve si satura Node:** la CPU se aplana cerca del 100% mientras la carga sigue subiendo, el throughput se estanca y la latencia y los errores crecen en la meseta.
* **Cómo distinguir VM de ARCA:** si la latencia sube con la CPU de la VM cerca del 100%, el límite es la VM. Si sube con la CPU de la VM por debajo, sospechamos de ARCA o del generador.
* **ARCA y Redis:** ARCA recibe solo lo que la VM logra atender, así que no esperamos que sature ni que devuelva 5xx. Redis tiene pocas operaciones por request y no esperamos que limite.
* **Límite del generador:** Artillery corre con un solo proceso en la computadora de quien lo ejecuta y no puede ofrecer mucho más de ~1330-1500 req/s sin errores de red. Esperamos que la VM sature antes. Si aparecen `EHOSTUNREACH` desde el inicio o la CPU del generador llega al 100%, la prueba no vale.
* **Saldo de la cuenta:** cada operación aprobada descuenta 1513 ARS de la cuenta 1. Antes de correr se repone el saldo (PUT `/accounts/1/balance`) para que no se agote durante la prueba.

## Caso 1 nodo, carga más alta (`exchange-saturation-3000.yaml`)

Mismo sistema y mismo flujo, con rampa de 100 a 3000 req/s en 360 s y 60 s sostenidos a 3000 req/s (~740000 requests). La prueba anterior (hasta 1500 req/s) no mostró saturación: 0 5xx, 20 errores de red sobre 332000 requests, mediana de 200 en 1153 ms y `system.cpu.user` máximo de ~61%. Esta prueba busca el límite de 1 nodo.

### Predicción

| Métrica | Valor |
|---|---|
| Throughput efectivo máximo | 1500-1900 req/s, aunque la carga ofrecida suba hasta 3000 |
| Primer componente en limitar | el generador (la computadora de quien corre Artillery o su red), no la VM |
| Errores `EHOSTUNREACH` / `ECONNRESET` | aparecen desde ~1500 req/s y crecen en la meseta |
| CPU de la VM (`system.cpu.user`) | máximo de 60-75% |
| Mediana de respuestas 200 | 1100-1500 ms, sin degradación marcada |
| 5xx de ARCA | 0 |

### Razonamiento

* **VM:** `system.cpu.user` creció linealmente hasta ~61% a 1500 req/s, lo que da ~0,4 ms de CPU por request. Si sigue lineal, el 100% de CPU de usuario estaría cerca de 2500 req/s (menos con el kernel y el agente). Es una extrapolación y no una medición.
* **Generador:** en pruebas previas con otra VM, el throughput efectivo desde esta computadora se estancó cerca de 1500 req/s aunque se ofrecieran más, con errores `EHOSTUNREACH` que salían del lado del generador. Por eso esperamos que el generador limite antes que la VM.
* **Cómo distinguir:** si el throughput efectivo se aplana en ~1500-1900 req/s con la CPU de la VM por debajo del 80% y con errores de red, el límite es el generador. Si el throughput se aplana con la CPU de la VM cerca del 100% y la latencia crece, el límite es la VM.
* **Saldo de la cuenta:** se repone el saldo (PUT `/accounts/1/balance` con 1000000000) antes de correr. Con ~370000 operaciones aprobadas se descuentan ~560 millones de ARS.

## Caso 2 nodos (`exchange-saturation-3000.yaml`)

Mismo escenario que la prueba de 1 nodo con carga más alta (rampa de 100 a 3000 req/s en 360 s y 60 s sostenidos a 3000 req/s), con `instances = 2` en el VMSS. Mismo Terraform, región y tamaño de VM (`Standard_F1als_v7`); solo cambia la cantidad de instancias. En 1 nodo el servicio atendió ~1900 req/s con 0 5xx y 0 timeouts, con la CPU de la VM en ~68% de usuario (~84% en total) y el 20% de las requests falló con `EHOSTUNREACH`.

### Predicción

| Métrica | Valor |
|---|---|
| Throughput efectivo máximo | 1700-2100 req/s, parecido a 1 nodo (no escala al doble) |
| Primer componente en limitar | el generador (la computadora de quien corre Artillery o su red), igual que en 1 nodo |
| Errores `EHOSTUNREACH` | aparecen desde ~1500-1900 req/s ofrecidos, ~15-25% de las requests, parecido a 1 nodo |
| CPU de cada VM (`system.cpu.user`, máximo por minuto) | 30-42% |
| CPU total de cada VM (`vmstat`, `us` + `sy`) | 38-52% |
| Diferencia de CPU entre las dos VM | menos de 10 puntos |
| Mediana de respuestas 200 | 1100-1300 ms, sin degradación |
| p95 de respuestas 200 | 1,3-1,5 s |
| 5xx de ARCA / timeouts del servicio | 0 |
| CPU de ARCA | 350-450 millicores (70-90% de los 500) |

### Razonamiento

* **Reparto:** el load balancer distribuye las requests entre las dos VM, así que cada una atiende la mitad. Con ~1900 req/s efectivos son ~950 req/s por nodo, la mitad de la carga que llevó la VM de 1 nodo a ~68% de CPU de usuario, es decir ~34-40% por nodo.
* **Escalado:** la capacidad de las VM se duplica (~2200 req/s estimados para 1 nodo, ~4400 para 2), pero desde una sola computadora el generador no pasa de ~1900 req/s, así que el throughput casi no cambia. Lo que sí cambia es el margen de cada VM: la CPU por nodo baja a la mitad.
* **Generador:** los errores `EHOSTUNREACH` en 1 nodo no dependieron de la VM (sin timeouts, sin 5xx, latencia plana, VM con 10-15% de CPU idle). Por eso esperamos el mismo techo y la misma proporción de errores.
* **ARCA y Redis:** son únicos y compartidos, no escalan con los nodos. ARCA recibe la misma carga efectiva que en 1 nodo (~1900 req/s). Con ~0,22 millicores por req/s (medido en otra VM a ~1500 req/s) esperamos 350-450 millicores, cerca del límite de 500, y es el candidato a limitar si se pudiera ofrecer más carga. Si su latencia empezara a subir o aparecieran 5xx, el límite pasaría a ser ARCA y esta predicción falla.
* **Medición:** la CPU de cada VM se toma de Datadog con `rollup(max, 60)` y también con `vmstat` desde cada nodo, porque la serie de Datadog con promedio muestra un patrón irregular que no pudimos explicar.
* **Saldo de la cuenta:** se repone el saldo (PUT `/accounts/1/balance` con 1000000000) antes de correr.
