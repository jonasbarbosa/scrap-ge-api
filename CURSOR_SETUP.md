# Cursor Setup — Scrap‑GE‑API (Backend do Pitaco2026)

Este projeto é o **backend** do Pitaco2026. Ele faz scraping de dados do Globo Esporte
e sincroniza no banco Appwrite compartilhado com o frontend.

**SEMPRE leia o `CURSOR_SETUP.md` do frontend (`~/Documents/GitHub/pitaco2026/CURSOR_SETUP.md`)
antes de trabalhar aqui — os dois projetos são acoplados.**

## Relação com o Frontend

| Projeto | Repositório | Diretório Local |
|---|---|---|
| **Scrap‑GE‑API** (este) | `jonasbarbosa/scrap-ge-api` | `~/Documents/GitHub/scrap-ge-js-test` |
| **Pitaco2026** (frontend) | `jonasbarbosa/pitaco2026` | `~/Documents/GitHub/pitaco2026` |

Este backend escreve na coleção `partidas` do banco `pitaco2026`. O frontend **consome**
tudo de lá (partidas, figurinhas, bolões, etc). Mudanças neste backend impactam
diretamente o frontend.

## Banco: Appwrite

- Endpoint: `https://appwrite.letsgo.ctqs.com.br/v1`
- Project ID: `6a197f990028a8d7e383`
- Database: `pitaco2026`
- Collection principal: `partidas`

## Deploy: Coolify

- App UUID: `gggo0kow0owggcww08kcg4cg`
- Branch de produção: `main`
- Fluxo: commit → merge main → push → `coolify_deploy`

## MCPs

Config no `.cursor/mcp.json`:
- `appwrite-api` — CRUD no banco
- `coolify` — Deploy

## Comandos

```bash
cd ~/Documents/GitHub/scrap-ge-js-test
node src/server.js           # Inicia servidor (port 3000)
```