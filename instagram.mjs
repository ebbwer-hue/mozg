import { randomBytes } from 'node:crypto';

const scopes = ['instagram_business_basic', 'instagram_business_manage_insights'];
const metricNames = ['views', 'reach', 'likes', 'comments', 'saved', 'shares'];
const fail = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });

// Local personal-app integration. Tokens never leave this process or reach an AI provider.
export function createInstagram({ env = process.env, request = (...args) => fetch(...args), now = () => Date.now() } = {}) {
  const connections = new Map();
  const pending = new Map();
  const generations = new Map();
  const version = env.INSTAGRAM_API_VERSION || 'v27.0';
  let redirect;
  try { redirect = new URL(env.INSTAGRAM_REDIRECT_URI); } catch { }
  const ready = Boolean(/^\d+$/.test(env.INSTAGRAM_APP_ID || '') && env.INSTAGRAM_APP_SECRET && redirect?.protocol === 'https:' && !redirect.username && !redirect.password && !redirect.search && !redirect.hash && redirect.pathname === '/auth/instagram/callback' && /^v\d+\.\d+$/.test(version));
  const publicHost = ready ? redirect.host : null;
  function clean() {
    for (const [state, value] of pending) if (value.expires <= now()) pending.delete(state);
    for (const [id, value] of connections) if (value.expires <= now() || (value.lastSeen && now() - value.lastSeen > 2 * 60 * 60 * 1000)) connections.delete(id);
  }
  function getSession(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw fail('Обнови страницу и попробуй подключение снова.');
    return id;
  }
  function current(id) { clean(); const c = connections.get(getSession(id)); if (c) c.lastSeen = now(); return c; }
  async function api(url, options = {}) {
    let response, data;
    try {
      response = await request(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(25000) });
      data = await response.json();
    } catch { throw fail('Не удалось связаться с Instagram. Проверь интернет и попробуй снова.', 502); }
    if (!response.ok || data.error) {
      const code = data.error?.code;
      if (code === 190 || response.status === 401) throw fail('Доступ Instagram истёк или отозван. Подключи аккаунт заново.', 401, { auth: true });
      if ([4,17,32,613].includes(code) || response.status === 429) {
        const seconds = Number(response.headers.get('retry-after'));
        throw fail('Instagram ограничил частоту запросов. Попробуй позже.', 429, { retrySeconds: Number.isFinite(seconds) && seconds > 0 ? Math.max(300,Math.min(seconds,3600)) : 300 });
      }
      if ([10,200].includes(code) || response.status === 403) throw fail('Instagram не разрешил читать статистику. Проверь тип аккаунта и выданные права.', 403);
      throw fail('Instagram не вернул запрошенные данные. Проверь настройку приложения и доступ к статистике.', 502, { unavailable: true });
    }
    return data;
  }
  async function graph(connection, endpoint, parameters = {}) {
    const url = new URL(`https://graph.instagram.com/${version}/${endpoint}`);
    for (const [key,value] of Object.entries(parameters)) url.searchParams.set(key,String(value));
    return api(url.toString(), { headers: { Authorization: `Bearer ${connection.accessToken}` } });
  }
  function status(id) {
    const connection = current(id);
    const inFlight = [...pending.values()].some(p => p.session === id);
    return { configured: ready, connected: Boolean(connection?.accessToken), pending: inFlight, account: connection?.account || null, snapshot: connection?.snapshot || null, error: connection?.error || null, nextRefreshAt: connection?.snapshot ? new Date(Date.parse(connection.snapshot.fetchedAt) + 5 * 60 * 1000).toISOString() : null, retryAt: connection?.retryAt ? new Date(connection.retryAt).toISOString() : null };
  }
  function start(id) {
    getSession(id); clean();
    if (!ready) throw fail('Подключение Instagram ещё не настроено владельцем приложения.', 503);
    if (pending.size >= 100) throw fail('Слишком много попыток входа. Попробуй позже.', 429);
    for (const [key,value] of pending) if (value.session === id) pending.delete(key);
    const state = randomBytes(32).toString('hex');
    pending.set(state, { session: id, generation: generations.get(id) || 0, expires: now() + 10 * 60 * 1000 });
    const url = new URL('https://www.instagram.com/oauth/authorize');
    url.search = new URLSearchParams({ client_id: env.INSTAGRAM_APP_ID, redirect_uri: redirect.toString(), response_type: 'code', scope: scopes.join(','), state }).toString();
    return { url: url.toString() };
  }
  async function callback(parameters) {
    clean(); const state = parameters.get('state'); const attempt = pending.get(state);
    if (!attempt) throw fail('Попытка входа истекла или не найдена. Вернись в помощника и подключи Instagram заново.');
    pending.delete(state); // State is single-use, including declined or failed attempts.
    const setError = error => { if ((generations.get(attempt.session) || 0) !== attempt.generation) return; const old = connections.get(attempt.session); if (old) old.error = error; else connections.set(attempt.session, { error, expires: now() + 10 * 60 * 1000 }); };
    try {
      if (parameters.has('error')) throw fail('Вход отменён. Доступ Instagram не выдан.');
      const code = parameters.get('code');
      if (!code || code.length > 4096) throw fail('Instagram не передал код входа. Начни подключение заново.');
      const form = new URLSearchParams({ client_id: env.INSTAGRAM_APP_ID, client_secret: env.INSTAGRAM_APP_SECRET, grant_type: 'authorization_code', redirect_uri: redirect.toString(), code });
      const tokenResponse = await api('https://api.instagram.com/oauth/access_token', { method: 'POST', body: form });
      const tokenData = tokenResponse.data ? (tokenResponse.data.length === 1 && !tokenResponse.access_token ? tokenResponse.data[0] : null) : tokenResponse;
      if (!tokenData?.access_token || !/^\d+$/.test(String(tokenData.user_id))) throw fail('Instagram вернул неполный результат входа.',502);
      const granted = typeof tokenData.permissions === 'string' ? tokenData.permissions.split(',').map(p => p.trim()) : Array.isArray(tokenData.permissions) ? tokenData.permissions : null;
      if (granted && scopes.some(scope => !granted.includes(scope))) throw fail('Не выданы права на статистику. Подключи аккаунт заново и разреши чтение статистики.',403);
      const longURL = new URL('https://graph.instagram.com/access_token');
      longURL.search = new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: env.INSTAGRAM_APP_SECRET, access_token: tokenData.access_token }).toString();
      const long = await api(longURL.toString());
      if (!long.access_token || !Number.isFinite(long.expires_in) || long.expires_in <= 0) throw fail('Не удалось сохранить разрешение Instagram.',502);
      const connection = { accessToken: long.access_token, userId: String(tokenData.user_id), expires: now() + long.expires_in * 1000, lastSeen: now(), snapshot: null, error: null, syncing: null };
      const account = await graph(connection,'me',{ fields: 'user_id,username,followers_count,media_count' });
      connection.account = { id: connection.userId, username: String(account.username || ''), followers: typeof account.followers_count === 'number' ? account.followers_count : null, mediaCount: typeof account.media_count === 'number' ? account.media_count : null };
      if ((generations.get(attempt.session) || 0) !== attempt.generation) throw fail('Подключение отменено.');
      connections.set(attempt.session,connection);
      return { ok: true };
    } catch (error) { setError(error.status ? error.message : 'Не удалось подключить Instagram. Попробуй снова.'); throw error; }
  }
  async function sync(id) {
    const connection = current(id);
    if (!connection?.accessToken) throw fail('Сначала подключи Instagram.',401);
    if (connection.retryAt > now()) throw fail('Instagram ограничил запросы. Повторное обновление станет доступно позже.',429);
    if (connection.syncing) return connection.syncing;
    if (connection.snapshot && now() - Date.parse(connection.snapshot.fetchedAt) < 5 * 60 * 1000) return connection.snapshot;
    connection.syncing = (async () => {
      const previous = connection.snapshot;
      const profile = await graph(connection,'me',{ fields: 'user_id,username,followers_count,media_count' });
      const account = { id: connection.userId, username: String(profile.username || connection.account.username), followers: typeof profile.followers_count === 'number' ? profile.followers_count : null, mediaCount: typeof profile.media_count === 'number' ? profile.media_count : null };
      // A bounded sample of latest posts; totals are lifetime metrics for this sample.
      const media = await graph(connection, `${connection.userId}/media`, { fields: 'id,caption,media_type,media_product_type,timestamp,permalink', limit: 12 });
      const posts = [];
      for (const item of (media.data || []).slice(0,12)) {
        if (!/^\d+$/.test(String(item.id))) continue;
        const post = { id: String(item.id), caption: String(item.caption || '').slice(0,350), timestamp: item.timestamp, type: item.media_product_type || item.media_type, metrics: Object.fromEntries(metricNames.map(name => [name,null])) };
        try {
          const insights = await graph(connection,`${item.id}/insights`,{ metric: metricNames.join(',') });
          for (const metric of insights.data || []) {
            const value = metric.total_value?.value ?? metric.values?.[0]?.value;
            if (metricNames.includes(metric.name) && typeof value === 'number' && Number.isFinite(value)) post.metrics[metric.name] = value;
          }
        } catch (error) {
          if (error.auth || error.status === 429) throw error;
          post.unavailable = error.status === 403 ? 'Недостаточно прав на статистику этой публикации.' : 'Статистика этой публикации недоступна.';
        }
        posts.push(post);
      }
      const totals = Object.fromEntries(metricNames.filter(name => name !== 'reach').map(name => { const values = posts.map(p => p.metrics[name]).filter(v => v !== null); return [name,{ value: values.length ? values.reduce((a,b) => a+b,0) : null, availablePosts: values.length }]; }));
      const top = [...posts].filter(p => p.metrics.views !== null).sort((a,b) => b.metrics.views - a.metrics.views).slice(0,3);
      const comparison = previous ? {
        since: previous.fetchedAt,
        followerChange: account.followers !== null && previous.account.followers !== null ? account.followers - previous.account.followers : null,
        note: 'Разница между двумя загрузками в этой сессии. По публикациям сравниваются только одинаковые ID; это не сравнение одинаковых периодов после публикации.',
        posts: posts.flatMap(post => {
          const old = previous.posts.find(p => p.id === post.id);
          return old ? [{ id: post.id, changes: Object.fromEntries(metricNames.map(name => [name, post.metrics[name] !== null && old.metrics[name] !== null ? post.metrics[name] - old.metrics[name] : null])) }] : [];
        })
      } : null;
      const snapshot = { fetchedAt: new Date(now()).toISOString(), account, comparison, sample: posts.length, hasMore: Boolean(media.paging?.next), note: 'Последние 12 публикаций (или меньше). Метрики за всё время жизни этих публикаций, не за период. Охват между публикациями не суммируется. null означает недоступно, а не ноль. Просмотры могут не включать продвижение и запаздывать.', totals, top, posts };
      // A disconnect racing an API response must not restore access.
      if (connections.get(id) !== connection) throw fail('Instagram отключён.');
      connection.account = account; connection.snapshot = snapshot; connection.error = null; connection.retryAt = 0; return snapshot;
    })();
    try { return await connection.syncing; }
    catch (error) { if (error.auth) { connection.accessToken = ''; connection.snapshot = null; } if (error.status === 429) connection.retryAt = now() + (error.retrySeconds || 300) * 1000; connection.error = error.message; throw error; }
    finally { connection.syncing = null; }
  }
  function disconnect(id) { getSession(id); generations.set(id,(generations.get(id) || 0) + 1); connections.delete(id); for (const [key,p] of pending) if (p.session === id) pending.delete(key); return { ok: true }; }
  return { ready, publicHost, status, start, callback, sync, disconnect };
}
