#!/bin/bash
set -euo pipefail
DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"
../node/zip
ansible-playbook -i vmss_hosts --private-key ../key.pem -u azureuser vmss_deploy.yml "$@"
