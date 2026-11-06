# redis.tf
#
# Storage del servicio: Azure Managed Redis (PaaS) y archivo de configuración
# con los datos de conexión, generado al crear la infraestructura.
# No fue validado con `terraform validate` por quien lo redactó: correlo antes de aplicar.

# El nombre del recurso debe ser único en Azure (forma parte del hostname).
resource "random_string" "redis_name" {
  length  = 10
  lower   = true
  upper   = false
  special = false
  numeric = false
}

resource "azurerm_managed_redis" "tp2_redis" {
  name                = "tp2redis${random_string.redis_name.result}"
  resource_group_name = azurerm_resource_group.tp2_resource_group.name
  location            = azurerm_resource_group.tp2_resource_group.location

  # Tamaño más chico de la familia Balanced (B0).
  sku_name = "Balanced_B0"

  # Opcional: sin alta disponibilidad el costo baja a la mitad (solo dev/test).
  # Si lo activás, documentalo en el informe como trade-off.
  # high_availability_enabled = false

  default_database {
    access_keys_authentication_enabled = true
    client_protocol                    = "Encrypted" # solo TLS, puerto 10000
    # "EnterpriseCluster" expone un único endpoint: sirve para el cliente ioredis
    # estándar (no cluster-aware) y para MULTI/Lua sobre claves distintas.
    clustering_policy = "EnterpriseCluster"
    # Es el storage principal (cuentas, tasas, log): no debe descartar claves.
    eviction_policy = "NoEviction"
  }
}

# Archivo de configuración que lee node/state.js. Se genera al crear la infraestructura
# y viaja en el zip que despliega ansible/deploy.sh.
# CONTIENE LA CLAVE DE ACCESO: agregá node/redis.json al .gitignore y no lo commitees.
resource "local_sensitive_file" "redis_config" {
  filename        = "${path.module}/node/redis.json"
  file_permission = "0644"
  content = jsonencode({
    host     = azurerm_managed_redis.tp2_redis.hostname
    port     = azurerm_managed_redis.tp2_redis.default_database[0].port
    password = azurerm_managed_redis.tp2_redis.default_database[0].primary_access_key
  })
}
