# Clarim da Verdade — Plataforma de Jornalismo Digital

> **"A imprensa é o cão de guarda da democracia."**  
> Arquitectura enterprise-grade para um jornal digital independente.

---

## 🗂️ Estrutura do Projecto

```
clarim-da-verdade/
├── scripts/
│   └── bootstrap.sh              # Setup completo via terminal
├── services/
│   ├── auth-service/             # Autenticação JWT/OAuth2
│   ├── user-service/             # Gestão de utilizadores
│   ├── content-service/          # CMS — artigos, media
│   ├── payment-service/          # Assinaturas e transacções
│   ├── notification-service/     # Email, Push, SMS
│   └── analytics-service/        # Métricas e relatórios
├── frontend/                     # Next.js — SSR/SSG
├── infrastructure/
│   ├── docker/                   # Docker Compose local
│   ├── kubernetes/               # Manifests K8s
│   └── terraform/                # Infrastructure as Code
├── observability/
│   ├── prometheus/               # Scraping de métricas
│   ├── grafana/                  # Dashboards
│   └── loki/                     # Agregação de logs
├── security/                     # Políticas e configurações WAF
└── ci-cd/                        # GitHub Actions pipelines
```

---

## 🚀 Início Rápido (Terminal)

### Pré-requisitos
```bash
# Verificar pré-requisitos
docker --version        # >= 24.0
docker compose version  # >= 2.0
node --version          # >= 20.0
kubectl version         # >= 1.28 (para deploy)
terraform --version     # >= 1.6 (para IaC)
```

### Setup completo
```bash
# 1. Clonar e entrar no projecto
git clone https://github.com/clarim/clarim-da-verdade.git
cd clarim-da-verdade

# 2. Tornar o script executável
chmod +x scripts/bootstrap.sh

# 3. Configurar ambiente (cria .env, instala dependências)
bash scripts/bootstrap.sh setup

# 4. Editar variáveis sensíveis
nano .env   # Alterar todos os campos CHANGE_ME

# 5. Iniciar infraestrutura local
bash scripts/bootstrap.sh infra

# 6. Executar migrações
bash scripts/bootstrap.sh migrate

# 7. Iniciar todos os serviços
docker compose -f infrastructure/docker/docker-compose.yml up
```

### Acessos locais
| Serviço         | URL                         |
|-----------------|-----------------------------|
| **Frontend**    | http://localhost:3000       |
| **API Gateway** | http://localhost:8080       |
| **Auth**        | http://localhost:4001       |
| **Content**     | http://localhost:4003       |
| **Grafana**     | http://localhost:3001       |
| **Prometheus**  | http://localhost:9090       |
| **Jaeger**      | http://localhost:16686      |

---

## 🏛️ Arquitectura

```
Internet
   │
   ▼
Cloudflare (CDN + WAF + DDoS Protection)
   │
   ▼
Load Balancer (HTTPS/443 → TLS termination)
   │
   ▼
Traefik (API Gateway)
   ├── Rate limiting por IP e rota
   ├── Autenticação via middleware JWT
   ├── Circuit breaker
   └── Métricas Prometheus
         │
         ├──▶ Auth Service    (Port 4001) — JWT, OAuth2, Sessions
         ├──▶ User Service    (Port 4002) — Perfis, Preferências
         ├──▶ Content Service (Port 4003) — Artigos, Media, CMS
         ├──▶ Payment Service (Port 4004) — Stripe, Assinaturas
         ├──▶ Notification    (Port 4005) — Email/Push/SMS
         └──▶ Analytics       (Port 4006) — Eventos, Métricas
              │
              ├── PostgreSQL (dados relacionais)
              ├── MongoDB    (conteúdo e CMS)
              ├── Redis      (cache + sessões)
              └── Kafka      (eventos assíncronos)
```

---

## 🔐 Segurança Implementada

| Camada               | Medida                                             |
|----------------------|----------------------------------------------------|
| **Transporte**       | TLS 1.3 obrigatório, HSTS, certificados Let's Encrypt |
| **Autenticação**     | JWT (15min) + Refresh Tokens rotativos (7d)        |
| **Passwords**        | bcrypt com 12 rounds de salt                       |
| **Rate Limiting**    | Por IP, por utilizador, por rota                   |
| **Input Validation** | Zod schemas em todas as rotas                      |
| **SQL Injection**    | Queries parametrizadas (prepared statements)       |
| **XSS**             | sanitize-html no conteúdo, CSP headers             |
| **CSRF**             | SameSite cookies + tokens                          |
| **Containers**       | Non-root user, read-only filesystem, no capabilities |
| **Kubernetes**       | NetworkPolicies zero-trust, PodSecurityContext     |
| **Secrets**          | Kubernetes Secrets + HashiCorp Vault               |
| **Auditoria**        | Logs estruturados de todas as acções sensíveis     |
| **Dependências**     | Trivy + OWASP Dependency Check no CI               |

---

## 📊 Observabilidade

### Métricas (Prometheus + Grafana)
- Latência por rota e serviço (p50, p95, p99)
- Taxa de erros (4xx, 5xx)
- Logins por minuto e tentativas falhadas
- Artigos publicados e visualizações
- Uso de CPU/memória por pod

### Logs (Loki + Grafana)
- Logs estruturados em JSON
- Correlação por `requestId` entre serviços
- Retenção de 30 dias

### Tracing (Jaeger + OpenTelemetry)
- Traces distribuídos por todos os serviços
- Identificação de gargalos de performance

---

## 🧪 Testes

```bash
# Unit tests (por serviço)
cd services/auth-service && npm test

# Todos os serviços
for svc in services/*/; do (cd "$svc" && npm test); done

# E2E (Playwright)
cd e2e && npx playwright test

# Coverage
npm test -- --coverage
```

---

## ☸️ Deploy Kubernetes

```bash
# Aplicar namespace e configurações base
kubectl apply -f infrastructure/kubernetes/base/

# Deploy de todos os serviços
kubectl apply -f infrastructure/kubernetes/base/deployments.yaml

# Verificar estado
kubectl get pods -n clarim
kubectl get hpa -n clarim

# Ver logs de um serviço
kubectl logs -f deployment/auth-service -n clarim

# Escalar manualmente
kubectl scale deployment content-service --replicas=5 -n clarim
```

---

## 🔄 CI/CD

O pipeline GitHub Actions executa automaticamente:

1. **Security Scan** — Trivy + OWASP (bloqueia se CVSS ≥ 7)
2. **Lint + Testes** — ESLint, TypeScript, Jest (paralelo por serviço)
3. **Build** — Docker multi-stage, imagem mínima (~50MB)
4. **Scan da imagem** — Trivy na imagem construída
5. **Deploy Staging** — no push para `develop`
6. **E2E Tests** — Playwright
7. **Deploy Production** — Canary (20%) → monitorização 5min → 100%
8. **Rollback automático** — se erro rate > 1%

---

## 📰 API — Exemplos

```bash
# Registar utilizador
curl -X POST http://localhost:4001/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"editor@clarim.co.ao","password":"Senha@Forte1","name":"Editor","role":"journalist"}'

# Login
curl -X POST http://localhost:4001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"editor@clarim.co.ao","password":"Senha@Forte1"}'

# Listar artigos (público)
curl http://localhost:4003/api/content/articles?page=1&limit=10

# Criar artigo (autenticado)
curl -X POST http://localhost:4003/api/content/articles \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"title":"Novo Artigo","content":"<p>Conteúdo...</p>","status":"draft"}'

# Buscar artigo por slug
curl http://localhost:4003/api/content/articles/novo-artigo
```

---

## 📄 Licença

Copyright © 2024–2025 Clarim da Verdade. Todos os direitos reservados.  
Código fonte disponível sob licença MIT para fins de auditoria.

---

*Desenvolvido com rigor técnico e responsabilidade jornalística.*
