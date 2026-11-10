variable "azure_sid" {
  sensitive = true
}

variable "datadog_key" {
  sensitive = true
}

variable "dockerhub_username" {
  sensitive = true
}

variable "dockerhub_token" {
  sensitive = true
}

variable "region" {
  default = "chilecentral"
}

variable "ssh_key_group_name" {
  default = "keys"
}

variable "ssh_key_name" {
  default = "ssh_key"
}

variable "os_publisher" {
  default = "Canonical"
}

variable "os_offer" {
  default = "ubuntu-24_04-lts"
}

variable "os_sku" {
  default = "server"
}

variable "os_version" {
  default = "latest"
}

variable "machine_sku" {
  default = "Standard_B2ats_v2"
}