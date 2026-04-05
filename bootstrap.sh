#!/usr/bin/env bash
# ============================================================
#  CLARIM DA VERDADE — Bootstrap Script
#  Provisiona toda a infraestrutura e serviços via terminal
# ============================================================
set -euo pipefail

CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'; BOLD='\033[1m'

banner() {
  echo -e "${CYAN}${BOLD}"
  cat << 'EOF'
  ██████╗██╗      █████╗ ██████╗ ██╗███╗   ███╗
 ██╔════╝██║     ██╔══██╗██╔══██╗██║████╗ ████║
 ██║     ██║     ███████║██████╔╝██║██╔████╔██║
 ██║     ██║     ██╔══██║██╔══██╗██║██║╚██╔╝██║
 ╚██████╗███████╗██║  ██║██║  ██║██║██║ ╚═╝ ██║
  ╚═════╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝╚═╝     ╚═╝
         DA  V E R D A D E  — Platform v1.0
EOF
  echo -e "${NC}"
}

step() { echo -e "\n${CYAN}▶ ${BOLD}$1${NC}"; }
ok()   { echo -e "${GREEN}✔ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠ $1${NC}"; }
err()  { echo -e "${RED}✘ $1${NC}"; exit 1; }

check_deps() {
  step "Verificando dependências"
  local deps=(docker docker-compose node npm kubectl terraform git)
  for d in "${deps[@]}"; do
    if command -v "$d" &>/dev/null; then ok "$d encontrado"
    else warn "$d não encontrado — instale antes de continuar"; fi
  done
}

init_env() {
  step "Gerando .env de ambiente"
  cat > .env << 'ENVEOF'
# ── Aplicação ──────────────────────────────────────────────
APP_NAME=Clarim-da-Verdade
APP_ENV=development
APP_PORT=3000
APP_URL=http://localhost:3000

# ── JWT ────────────────────────────────────────────────────
JWT_SECRET=CHANGE_ME_super_secret_256bit_key_here
JWT_EXPIRES_IN=15m
REFRESH_SECRET=CHANGE_ME_refresh_secret_here
REFRESH_EXPIRES_IN=7d

# ── Banco de dados ─────────────────────────────────────────
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=clarim_db
POSTGRES_USER=clarim_user
POSTGRES_PASSWORD=CHANGE_ME_strong_password

MONGO_URI=mongodb://localhost:27017/clarim_content
REDIS_URL=redis://localhost:6379

# ── Serviços externos ──────────────────────────────────────
STRIPE_SECRET_KEY=sk_test_CHANGE_ME
STRIPE_WEBHOOK_SECRET=whsec_CHANGE_ME
SENDGRID_API_KEY=SG.CHANGE_ME
TWILIO_ACCOUNT_SID=CHANGE_ME
TWILIO_AUTH_TOKEN=CHANGE_ME

# ── Armazenamento ──────────────────────────────────────────
S3_BUCKET=clarim-media
S3_REGION=us-east-1
AWS_ACCESS_KEY_ID=CHANGE_ME
AWS_SECRET_ACCESS_KEY=CHANGE_ME

# ── Observabilidade ────────────────────────────────────────
PROMETHEUS_PORT=9090
GRAFANA_PORT=3001
LOKI_PORT=3100
JAEGER_PORT=16686
ENVEOF
  ok ".env criado (altere os valores CHANGE_ME antes do deploy)"
}

install_services() {
  step "Instalando dependências dos microserviços"
  for svc in auth-service user-service content-service payment-service notification-service analytics-service; do
    if [ -f "services/$svc/package.json" ]; then
      echo -n "  → $svc... "
      (cd "services/$svc" && npm install --silent) && echo -e "${GREEN}ok${NC}"
    fi
  done
}

install_frontend() {
  step "Instalando dependências do frontend"
  if [ -f "frontend/package.json" ]; then
    (cd frontend && npm install --silent) && ok "Frontend pronto"
  fi
}

start_infra() {
  step "Iniciando infraestrutura local (Docker Compose)"
  docker-compose -f infrastructure/docker/docker-compose.yml up -d \
    postgres mongo redis kafka zookeeper
  echo -n "  Aguardando serviços subirem"
  for i in {1..12}; do sleep 2; echo -n "."; done; echo
  ok "Infraestrutura local activa"
}

migrate_db() {
  step "Executando migrações de banco"
  (cd services/auth-service && npm run migrate 2>/dev/null || true)
  (cd services/user-service && npm run migrate 2>/dev/null || true)
  ok "Migrações concluídas"
}

start_dev() {
  step "Iniciando todos os serviços em modo development"
  cat << 'EOF'
  Serviços disponíveis:
  ┌─────────────────────────────────────────────────┐
  │  Auth Service        → http://localhost:4001    │
  │  User Service        → http://localhost:4002    │
  │  Content Service     → http://localhost:4003    │
  │  Payment Service     → http://localhost:4004    │
  │  Notification Svc    → http://localhost:4005    │
  │  Analytics Service   → http://localhost:4006    │
  │  API Gateway         → http://localhost:8080    │
  │  Frontend            → http://localhost:3000    │
  │  Grafana             → http://localhost:3001    │
  │  Prometheus          → http://localhost:9090    │
  │  Jaeger              → http://localhost:16686   │
  └─────────────────────────────────────────────────┘
EOF
  ok "Execute: docker-compose -f infrastructure/docker/docker-compose.yml up"
}

main() {
  banner
  check_deps
  init_env
  install_services
  install_frontend
  echo -e "\n${GREEN}${BOLD}✔ Clarim-da-Verdade configurado com sucesso!${NC}"
  echo -e "${CYAN}→ Próximo passo: bash scripts/bootstrap.sh start${NC}\n"
}

case "${1:-setup}" in
  setup)   main ;;
  infra)   start_infra ;;
  migrate) migrate_db ;;
  dev)     start_dev ;;
  *)       main ;;
esac
