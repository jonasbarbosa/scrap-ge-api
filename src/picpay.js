// ── PicPay Payment Link API ───────────────────────────────────────────────────
// Docs: https://developers-business.picpay.com/payment-link/docs/introduction
// Auth: OAuth2 client_credentials (token expira em 5 min — renovação automática)

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const IS_SANDBOX = process.env.PICPAY_SANDBOX === 'true';

const BASE_URL = IS_SANDBOX
  ? 'https://api.ms.qa.limbo.work'
  : 'https://ecommerce-api.svc.picpay.com';

const API_PATH = IS_SANDBOX ? '/sandbox/v1' : '/v1';

// ── Token Cache (5 min TTL, renova 30s antes) ─────────────────────────────────

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 30_000) {
    return cachedToken;
  }

  const clientId = process.env.PICPAY_CLIENT_ID || '';
  const clientSecret = process.env.PICPAY_CLIENT_SECRET || '';

  if (!clientId || !clientSecret) {
    throw new Error('PICPAY_CLIENT_ID e PICPAY_CLIENT_SECRET são obrigatórios');
  }

  const resp = await fetch(`${BASE_URL}/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`PicPay Auth ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  cachedToken = data.access_token;
  tokenExpiresAt = now + data.expires_in * 1000;
  console.log(`[picpay] Token renovado — expira em ${data.expires_in}s`);
  return cachedToken;
}

// ── Mapeamento paymentLinkId → {bolaoId, usuarioId, referenceId} ──────────────
// Persiste em data/picpay_pending.json para sobreviver a restarts

const PENDING_FILE = join(__dirname, '..', 'data', 'picpay_pending.json');

function loadPendingMap() {
  try {
    if (existsSync(PENDING_FILE)) {
      return JSON.parse(readFileSync(PENDING_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

function savePendingMap(map) {
  try {
    writeFileSync(PENDING_FILE, JSON.stringify(map, null, 2));
  } catch (err) {
    console.error('[picpay] Erro ao salvar pending map:', err.message);
  }
}

let pendingMap = loadPendingMap();

export function registrarPendente(paymentLinkId, { bolaoId, usuarioId, referenceId }) {
  pendingMap[paymentLinkId] = { bolaoId, usuarioId, referenceId, criadoEm: new Date().toISOString() };
  savePendingMap(pendingMap);
}

export function buscarPendente(paymentLinkId) {
  return pendingMap[paymentLinkId] || null;
}

export function removerPendente(paymentLinkId) {
  delete pendingMap[paymentLinkId];
  savePendingMap(pendingMap);
}

// ── Criar Link de Pagamento ───────────────────────────────────────────────────

/**
 * Cria um Link de Pagamento PicPay com PIX.
 * @param {object} params
 * @param {string} params.referenceId   - ID único da transação (ex: bolao_XXX_user_YYY_timestamp)
 * @param {number} params.valor         - Valor em reais (ex: 10.00)
 * @param {string} params.bolaoNome     - Nome do bolão (aparece na tela de pagamento)
 * @returns {Promise<{ paymentLinkId, paymentUrl, qrcode, txid, expiresAt, referenceId }>}
 */
export async function criarCobrancaPicPay({ referenceId, valor, bolaoNome }) {
  const token = await getAccessToken();
  const valorCentavos = Math.round(valor * 100);

  const expirationDate = new Date(Date.now() + 30 * 60 * 1000)
    .toISOString()
    .split('T')[0]; // YYYY-MM-DD

  const resp = await fetch(`${BASE_URL}${API_PATH}/paymentlink/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      charge: {
        name: `Pote de Ouro — ${bolaoNome}`.slice(0, 60),
        description: `Inscrição no bolão Pitaco2026`,
        order_number: referenceId,
        redirect_url: process.env.FRONTEND_URL || 'https://pitaco2026.ctqs.com.br',
        payment: {
          methods: ['BRCODE'],
          brcode_arrangements: ['PIX'],
        },
        amounts: {
          product: valorCentavos,
        },
      },
      options: {
        allow_create_pix_key: true,
        expired_at: expirationDate,
      },
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`PicPay Create Link ${resp.status}: ${err}`);
  }

  const data = await resp.json();

  // Extrai paymentLinkId da URL do link (último segmento)
  const paymentLinkId = data.link?.split('/').pop();

  if (!paymentLinkId) {
    throw new Error('PicPay não retornou paymentLinkId válido');
  }

  return {
    referenceId,
    paymentLinkId,
    paymentUrl: data.link,
    qrcode: data.brcode,       // Código PIX Copia e Cola (EMV)
    txid: data.txid,
    expiresAt: data.expirationDate,
    valorCentavos,
  };
}

// ── Consultar Status do Pagamento ─────────────────────────────────────────────

/**
 * Verifica se um link de pagamento já foi pago consultando as transações.
 * @param {string} paymentLinkId
 * @returns {Promise<{ status: 'paid'|'pending'|'cancelled', transactionId?: string }>}
 */
export async function consultarStatusPicPay(paymentLinkId) {
  const token = await getAccessToken();

  const resp = await fetch(`${BASE_URL}${API_PATH}/paymentlink/${paymentLinkId}/transactions`, {
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
  });

  if (!resp.ok) {
    if (resp.status === 404) return { status: 'pending', transactionId: null };
    throw new Error(`PicPay Transactions ${resp.status}: ${await resp.text()}`);
  }

  const data = await resp.json();
  const transactions = data.transactions || [];

  const paidTx = transactions.find(t => t.status === 'PAYED');
  const cancelledTx = transactions.find(t => ['CANCELLED', 'DENIED'].includes(t.status));

  if (paidTx) {
    return { status: 'paid', transactionId: paidTx.transactionId, amount: paidTx.amount };
  }
  if (cancelledTx) {
    return { status: 'cancelled', transactionId: cancelledTx.transactionId };
  }
  return { status: 'pending', transactionId: null };
}

// ── Inativar Link de Pagamento ────────────────────────────────────────────────

/**
 * Inativa um link de pagamento (ex: quando expirado ou usuário cancelou).
 * @param {string} paymentLinkId
 */
export async function inativarLinkPicPay(paymentLinkId) {
  const token = await getAccessToken();

  const resp = await fetch(`${BASE_URL}${API_PATH}/paymentlink/${paymentLinkId}/inactive`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
  });

  return resp.ok;
}
