const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 5;
const MAX_BODY_BYTES = 24 * 1024;
const rateBucket = new Map();

const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: jsonHeaders,
  });
}

function clean(value, limit = 500) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function escapeHtml(value) {
  return clean(value, 1200)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizePhone(value) {
  const raw = clean(value, 80);
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 10) digits = `7${digits}`;
  if (digits.length === 11 && digits.startsWith('8')) digits = `7${digits.slice(1)}`;
  if (digits.length < 10 || digits.length > 15) {
    return null;
  }

  if (digits.length === 11 && digits.startsWith('7')) {
    return `+7 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9, 11)}`;
  }

  return `+${digits}`;
}

function field(data, name, limit = 500) {
  const value = data[name];
  if (Array.isArray(value)) return clean(value[0], limit);
  return clean(value, limit);
}

function rateLimited(ip) {
  const now = Date.now();
  const key = ip || 'unknown';
  const fresh = (rateBucket.get(key) || []).filter((ts) => now - ts < RATE_WINDOW_MS);
  fresh.push(now);
  rateBucket.set(key, fresh);

  if (rateBucket.size > 1000) {
    for (const [bucketKey, timestamps] of rateBucket.entries()) {
      if (!timestamps.some((ts) => now - ts < RATE_WINDOW_MS)) rateBucket.delete(bucketKey);
    }
  }

  return fresh.length > RATE_MAX;
}

async function parseBody(request) {
  const contentType = request.headers.get('content-type') || '';
  const length = Number(request.headers.get('content-length') || '0');
  if (length > MAX_BODY_BYTES) throw new Error('body-too-large');

  if (contentType.includes('application/json')) {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) throw new Error('body-too-large');
    return JSON.parse(text || '{}');
  }

  if (contentType.includes('form')) {
    const form = await request.formData();
    return Object.fromEntries(form.entries());
  }

  throw new Error('bad-content-type');
}

function sameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return true;

  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

function buildMessage(data, request) {
  const phone = normalizePhone(field(data, 'phone'));
  if (!phone) {
    return { error: 'Укажите корректный номер телефона' };
  }

  const name = field(data, 'name', 120);
  if (!name) {
    return { error: 'Укажите имя' };
  }

  const requestUrl = new URL(request.url);
  const pageUrl = field(data, 'url', 800) || request.headers.get('referer') || `https://${requestUrl.host}/`;
  const pageTitle = field(data, 'pageTitle', 220);
  const source = field(data, 'source', 160);
  const details = field(data, 'details', 1200);
  const company = field(data, 'company', 220);
  const service = field(data, 'service', 240);
  const serviceUrl = field(data, 'serviceUrl', 400);
  const cluster = field(data, 'cluster', 220);
  const referrer = field(data, 'referrer', 800);
  const userAgent = clean(request.headers.get('user-agent') || '', 220);

  const quiz = ['q1', 'q2', 'q3', 'q4']
    .map((key) => [key, field(data, key, 240)])
    .filter(([, value]) => value);

  const lines = [
    '🇰🇿 <b>Казахстан: заявка с сайта kz.gsg-rt.ru</b>',
    '',
    `<b>Страница</b>: ${escapeHtml(pageTitle || 'без заголовка')}`,
    `<b>URL</b>: ${escapeHtml(pageUrl)}`,
    source ? `<b>Форма</b>: ${escapeHtml(source)}` : '',
    '',
    `<b>Имя</b>: ${escapeHtml(name)}`,
    `<b>Телефон</b>: ${escapeHtml(phone)}`,
    company ? `<b>Компания</b>: ${escapeHtml(company)}` : '',
    service ? `<b>Услуга</b>: ${escapeHtml(service)}` : '',
    serviceUrl ? `<b>URL услуги</b>: ${escapeHtml(serviceUrl)}` : '',
    cluster ? `<b>Раздел</b>: ${escapeHtml(cluster)}` : '',
    details ? `<b>Запрос</b>: ${escapeHtml(details)}` : '',
  ].filter(Boolean);

  if (quiz.length) {
    lines.push('', '<b>Ответы подбора</b>:');
    for (const [key, value] of quiz) {
      lines.push(`${escapeHtml(key)}: ${escapeHtml(value)}`);
    }
  }

  lines.push(
    '',
    `<b>Referrer</b>: ${escapeHtml(referrer || 'прямой заход')}`,
    `<b>IP</b>: ${escapeHtml(request.headers.get('cf-connecting-ip') || '')}`,
    `<b>UA</b>: ${escapeHtml(userAgent)}`
  );

  return { text: lines.join('\n') };
}

async function sendTelegram(env, text) {
  const token = env.KZ_TELEGRAM_BOT_TOKEN || env.GSG_TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN;
  const chatId = env.KZ_TELEGRAM_CHAT_ID || env.GSG_TELEGRAM_CHAT_ID || env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    throw new Error('telegram-not-configured');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`telegram-${response.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
    },
  });
}

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) {
    return json({ ok: false, error: 'forbidden' }, 403);
  }

  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '';
  if (rateLimited(ip)) {
    return json({ ok: false, error: 'too-many-requests' }, 429);
  }

  let data;
  try {
    data = await parseBody(request);
  } catch {
    return json({ ok: false, error: 'bad-request' }, 400);
  }

  if (field(data, 'website') || field(data, 'url2') || field(data, 'email_confirm')) {
    return json({ ok: true });
  }

  const message = buildMessage(data, request);
  if (message.error) {
    return json({ ok: false, error: message.error }, 422);
  }

  try {
    await sendTelegram(env, message.text);
  } catch (error) {
    console.error('lead delivery failed', error && error.message ? error.message : error);
    return json({ ok: false, error: 'delivery-failed' }, 502);
  }

  return json({ ok: true });
}
