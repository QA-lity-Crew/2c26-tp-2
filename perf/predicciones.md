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
