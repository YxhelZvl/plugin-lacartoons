/// <reference path="./kino.d.ts" />

// Plugin de Kino para LACartoons (https://www.lacartoons.com).
// Series animadas clásicas en español latino, con sus episodios en
// OK.ru, CubeEmbed y Dhtpre.

const BASE = "https://www.lacartoons.com";
const CUBE_BASE = "https://cubeembed.rpmvid.com";

// El sitio muestra 16 series por página; la fila principal de Inicio junta
// las primeras cuatro (hasta 60 ítems, el máximo de una fila).
const CATALOG_PAGES = 4;
const ROW_SIZE = 60;

// home() y section() leen varias páginas a la vez, pero kino.fetch permite
// como máximo 6 peticiones en vuelo: el grupo las respeta.
const MAX_IN_FLIGHT = 6;

// Por petición (el mismo valor por defecto de kino.fetch). LACartoons a
// veces tarda ~8 s en una página de serie; menos que esto corta respuestas
// válidas.
const REQUEST_TIMEOUT_MS = 15000;

// Tarjetas ya parseadas, con vencimiento, para que Inicio, la sección y
// Categorías abran al instante en la segunda visita (256 KB en total).
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_PREFIX = "cartas:";

// Las categorías del sitio son fijas: un formulario por canal original.
const CATEGORIES = [
  { id: "1", title: "Nickelodeon", url: BASE + "/?Categoria_id=1" },
  { id: "2", title: "Cartoon Network", url: BASE + "/?Categoria_id=2" },
  { id: "3", title: "Fox Kids", url: BASE + "/?Categoria_id=3" },
  { id: "4", title: "Hanna Barbera", url: BASE + "/?Categoria_id=4" },
  { id: "5", title: "Disney", url: BASE + "/?Categoria_id=5" },
  { id: "6", title: "Warner Channel", url: BASE + "/?Categoria_id=6" },
  { id: "7", title: "Marvel", url: BASE + "/?Categoria_id=7" },
  { id: "8", title: "Otros", url: BASE + "/?Categoria_id=8" },
];

// El reproductor de CubeEmbed pide esta cabecera; el sitio no la necesita.
const UA =
  "Mozilla/5.0 (X11; Linux x86_64; rv:157.0) Gecko/20100101 Firefox/157.0";

// En Kino 0.9.43 kino.log lanza "Cannot convert java type 'l7.s'" (bug de
// Kino, ya corregido): el log se escribe igual, solo falla el retorno.
function log(...args) {
  try {
    kino.log(...args);
  } catch (_) {}
}

// ---------- textos ----------

// Textos que arma el código: en el idioma de la app (kino.lang puede ser
// "en-US" desde Kino 0.9.54; antes siempre era "es-CO").
function T() {
  const lang = typeof kino.lang === "string" ? kino.lang : "es-CO";
  if (lang.indexOf("en") === 0) {
    return {
      seriesRow: "Classic cartoons",
      tabHome: "Home",
      tabCats: "Categories",
      heroText:
        "Classic animated series in Latin American Spanish, grouped by their original channel.",
    };
  }
  return {
    seriesRow: "Series clásicas",
    tabHome: "Inicio",
    tabCats: "Categorías",
    heroText:
      "Series animadas clásicas en español latino, organizadas por su canal original.",
  };
}

function decodeHtml(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripTags(text) {
  return decodeHtml(String(text || "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

// QuickJS (el motor de Kino) no trae String.prototype.normalize (requiere
// ICU, que Node sí tiene): los acentos se quitan con esta tabla.
const ACCENTS = "áàäâéèëêíìïîóòöôúùüûñçÁÀÄÂÉÈËÊÍÌÏÎÓÒÖÔÚÙÜÛÑÇ";
const SIN_TILDES = "aaaaeeeeiiiioooouuuuncAAAAEEEEIIIIOOOOUUUUNC";

function sinTildes(text) {
  let out = "";
  for (const ch of String(text || "")) {
    const i = ACCENTS.indexOf(ch);
    out += i >= 0 ? SIN_TILDES[i] : ch;
  }
  return out;
}

function slug(value) {
  return (
    sinTildes(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 100) || "serie"
  );
}

function seriesId(url, title) {
  const m = /\/serie\/([^/?#]+)/i.exec(url);
  return "lc-" + (m ? slug(m[1]) : slug(title));
}

// ---------- direcciones ----------

function absolute(url) {
  return new URL(url, BASE).toString();
}

function pageUrl(page) {
  return page <= 1 ? BASE + "/" : BASE + "/?page=" + page;
}

function withPage(url, page) {
  try {
    const u = new URL(url);
    if (page <= 1) {
      u.searchParams.delete("page");
    } else {
      u.searchParams.set("page", String(page));
    }
    return u.toString();
  } catch (_) {
    return url;
  }
}

function pageFromUrl(url) {
  try {
    const p = Number(new URL(url).searchParams.get("page"));
    return Number.isInteger(p) && p >= 1 ? p : 1;
  } catch (_) {
    return 1;
  }
}

function pageFromCursor(cursor) {
  const n = cursor ? Number(cursor) : 1;
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : 1;
}

// El sitio marca la página siguiente con rel="next" en su navegación: es
// la única forma firme de saber si hay más páginas (cada página trae 16
// series, no 50).
function nextPageFrom(html, current) {
  const m =
    /<a[^>]+rel="next"[^>]+href="([^"]+)"/i.exec(html) ||
    /<a[^>]+href="([^"]+)"[^>]+rel="next"/i.exec(html);
  if (!m) {
    return null;
  }
  try {
    const p = Number(new URL(decodeHtml(m[1]), BASE).searchParams.get("page"));
    if (Number.isInteger(p) && p > current && p <= 1000) {
      return p;
    }
  } catch (_) {}
  return null;
}

// ---------- red ----------

async function get(url, headers) {
  let r;
  try {
    r = await kino.fetch(url, { timeoutMs: REQUEST_TIMEOUT_MS, headers });
  } catch (e) {
    // kino.fetch lanza con e.code: timeout, network, too_large,
    // host_not_allowed o invalid_request.
    if (e && (e.code === "timeout" || e.code === "network")) {
      throw kino.error("unavailable", "La conexión no completó (" + e.code + ")");
    }
    if (e && e.code === "host_not_allowed") {
      throw kino.error("unavailable", "Un servidor intermedio no está permitido");
    }
    throw kino.error("unavailable", "No se pudo leer la página");
  }
  if (!r.ok) {
    if (r.status === 404) {
      throw kino.error("not_found", "La página ya no existe");
    }
    if (r.status === 429) {
      throw kino.error("rate_limited");
    }
    if (r.status === 451) {
      throw kino.error("geo_blocked");
    }
    throw kino.error("unavailable", "LACartoons respondió " + r.status);
  }
  return r.text();
}

// Hasta MAX_IN_FLIGHT tareas a la vez: kino.fetch no permite más peticiones
// en vuelo, y home() carga el catálogo y las ocho categorías.
async function pool(tasks, limit) {
  const results = new Array(tasks.length).fill(null);
  let cursor = 0;
  const worker = async () => {
    while (cursor < tasks.length) {
      const i = cursor++;
      try {
        results[i] = await tasks[i]();
      } catch (e) {
        log("No se pudo cargar una página:", e && e.code ? e.code : e);
        results[i] = null;
      }
    }
  };
  const count = Math.max(
    1,
    Math.min(limit === undefined ? MAX_IN_FLIGHT : limit, tasks.length)
  );
  const workers = [];
  for (let i = 0; i < count; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

// ---------- caché de tarjetas ----------

// Lee (o llena) la caché de una página de series: las tarjetas ya parseadas
// y su página siguiente, por dirección.
async function cachedPage(url) {
  const key = CACHE_PREFIX + url;
  try {
    const raw = kino.storage.get(key);
    if (raw) {
      const entry = JSON.parse(raw);
      if (
        entry &&
        entry.ts > Date.now() - CACHE_TTL_MS &&
        Array.isArray(entry.items)
      ) {
        return {
          items: entry.items,
          next: typeof entry.next === "string" ? entry.next : null,
        };
      }
    }
  } catch (_) {}
  const html = await get(url);
  const items = parseSeriesCards(html);
  const next = nextPageFrom(html, pageFromUrl(url));
  try {
    kino.storage.set(
      key,
      JSON.stringify({ ts: Date.now(), items, next }),
      { ttlMs: CACHE_TTL_MS }
    );
  } catch (_) {} // almacenamiento lleno: simplemente no se cachea
  return { items, next };
}

// ---------- parseo de tarjetas ----------

function parseSeriesCards(html) {
  const out = [];
  const seen = new Set();
  // Cada tarjeta es un <a … href="/serie/…">…</a>; partir por esos enlaces
  // es más firme que una sola expresión sobre toda la página.
  const parts = String(html || "").split('href="/serie/');
  for (let i = 1; i < parts.length && out.length < 100; i++) {
    const part = parts[i];
    const q = part.indexOf('"');
    const url = absolute("/serie/" + (q >= 0 ? part.slice(0, q) : part));
    const close = part.indexOf("</a>");
    const card = (close >= 0 ? part.slice(0, close) : part).slice(0, 4000);
    const img = /<img[^>]+src="([^"]+)"/i.exec(card);
    const name = /nombre-serie">\s*([\s\S]*?)<\/p>/i.exec(card);
    const year = /marcador-ano">\s*([\s\S]*?)<\/span>/i.exec(card);
    const rating = /class="valoracion">\s*(\d+)/i.exec(card);
    const title = name ? stripTags(name[1]) : "";
    if (!title) {
      continue;
    }
    const id = seriesId(url, title);
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push({
      id,
      ref: url,
      title,
      kind: "series",
      year: year ? stripTags(year[1]) : undefined,
      poster: img ? absolute(decodeHtml(img[1])) : undefined,
      rating: rating ? Math.min(10, Number(rating[1])) : undefined,
      badges: ["Latino"],
    });
  }
  return out;
}

// ---------- parseo de la página de serie ----------

function parseSeriesInfo(html) {
  const info = { title: "LACartoons" };
  const h2 = /<h2[^>]*subtitulo-serie-seccion[^>]*>([\s\S]*?)<\/h2>/i.exec(
    html
  );
  if (h2) {
    const cut = h2[1].indexOf("<");
    const title = stripTags(cut >= 0 ? h2[1].slice(0, cut) : h2[1]);
    if (title) {
      info.title = title;
    }
    const span = /<span[^>]*>\s*([\s\S]*?)\s*<\/span>/i.exec(h2[1]);
    if (span) {
      const channel = stripTags(span[1]);
      // El canal es el texto del marcador; un año suelto no es un canal.
      if (channel && !/^\d{4}$/.test(channel)) {
        info.category = channel;
      }
    }
  }
  const poster =
    /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i.exec(html) ||
    /<img[^>]+src="([^"]+)"/i.exec(html);
  if (poster) {
    info.poster = absolute(decodeHtml(poster[1]));
  }
  const year = /Año:\s*<span[^>]*>\s*(\d{4})/i.exec(html);
  if (year) {
    info.year = year[1];
  }
  const rating = /Valoración:\s*<span[^>]*>\s*(\d+)/i.exec(html);
  if (rating) {
    info.rating = Math.min(10, Number(rating[1]));
  }
  const overview = /Reseña:\s*(?:<br>\s*)?<span>([\s\S]*?)<\/span>/i.exec(
    html
  );
  if (overview) {
    const text = stripTags(overview[1]);
    if (text) {
      info.overview = text;
    }
  }
  return info;
}

// ---------- parseo de episodios ----------

function parseEpisodes(html) {
  const episodes = [];
  const blocks = [];
  const blockRe =
    /Temporada\s+(\d+)([\s\S]*?)(?=Temporada\s+\d+|Series recomendadas|<\/body>|$)/gi;
  let b;
  while ((b = blockRe.exec(html)) !== null) {
    blocks.push({ season: Number(b[1]), html: b[2] });
  }
  const addFromBlock = (season, blockHtml) => {
    const re =
      /href="([^"]*\/serie\/capitulo\/[^"]+)"[\s\S]*?<span>\s*Capitulo\s+(\d+)\s*(?:[-–—]\s*)?<\/span>\s*([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(blockHtml)) !== null && episodes.length < 5000) {
      const number = Number(m[2]);
      if (!number) {
        continue;
      }
      const title = stripTags(m[3]);
      episodes.push({
        season,
        number,
        ref: absolute(decodeHtml(m[1])),
        title: title || undefined,
      });
    }
  };
  if (blocks.length) {
    for (const block of blocks) {
      addFromBlock(block.season, block.html);
    }
  } else {
    addFromBlock(1, html);
  }
  return episodes;
}

// Kino 0.9.53 rellena los ids y el fondo de la serie con la llave de TMDB
// que ya tiene Kino (kino.tmdb, sin llave en el código). Detrás de la
// comprobación, porque un Kino más viejo no la tiene.
async function fillTmdb(series) {
  if (
    typeof kino.tmdb !== "function" ||
    !series.title ||
    series.title === "LACartoons"
  ) {
    return;
  }
  try {
    const answer = await kino.tmdb("/search/tv", {
      query: series.title,
      language: "es",
      include_adult: false,
    });
    const result = answer && answer.results ? answer.results[0] : null;
    if (!result || !result.id) {
      return;
    }
    series.ids = { tmdb: result.id };
    if (!series.backdrop && result.backdrop_path) {
      series.backdrop =
        "https://image.tmdb.org/t/p/w1280" + result.backdrop_path;
    }
    if (!series.overview && result.overview) {
      series.overview = result.overview;
    }
    const ids = await kino.tmdb("/tv/" + result.id + "/external_ids", {});
    const imdb = ids ? ids.imdb_id : null;
    if (typeof imdb === "string" && /^tt\d{5,10}$/.test(imdb)) {
      series.ids.imdb = imdb;
    }
  } catch (e) {
    // no_tmdb_key: nadie tiene una llave; la serie se muestra sin ids.
    if (!(e && e.code === "no_tmdb_key")) {
      log("kino.tmdb falló:", e && e.code ? e.code : e);
    }
  }
}

// ---------- capacidades ----------

export async function search(query) {
  await null;
  const q = String((query && query.q) || "").trim();
  if (!q) {
    return [];
  }
  const html = await get(BASE + "/?Titulo=" + encodeURIComponent(q));
  let items = parseSeriesCards(html);
  // Ordena por lo que la persona escribió (y por sus otros títulos
  // conocidos), cuando su Kino tiene kino.rank.
  if (
    items.length > 1 &&
    typeof kino.rank === "object" &&
    kino.rank !== null &&
    typeof kino.rank.sortBySimilarity === "function"
  ) {
    const forms = [q];
    if (query && typeof query.originalTitle === "string" && query.originalTitle) {
      forms.push(query.originalTitle);
    }
    if (query && Array.isArray(query.altTitles)) {
      for (const t of query.altTitles) {
        if (typeof t === "string" && t) {
          forms.push(t);
        }
      }
    }
    items = kino.rank.sortBySimilarity(items, forms);
  }
  return items.slice(0, 100);
}

export async function home() {
  const tasks = [];
  for (let p = 1; p <= CATALOG_PAGES; p++) {
    tasks.push(() => cachedPage(pageUrl(p)));
  }
  for (const c of CATEGORIES) {
    tasks.push(() => cachedPage(c.url));
  }
  const pages = await pool(tasks);
  const rows = [];
  const main = [];
  for (let p = 0; p < CATALOG_PAGES; p++) {
    const items = pages[p] && pages[p].items;
    if (items) {
      for (const item of items) {
        main.push(item);
      }
    }
  }
  if (main.length) {
    rows.push({
      id: "catalogo",
      title: T().seriesRow,
      ref: "catalogo",
      genre: "series",
      items: main.slice(0, ROW_SIZE),
    });
  }
  for (let i = CATALOG_PAGES; i < tasks.length; i++) {
    const c = CATEGORIES[i - CATALOG_PAGES];
    const items = pages[i] && pages[i].items;
    if (items && items.length) {
      rows.push({
        id: "cat-" + c.id,
        title: c.title,
        ref: c.url,
        genre: "series",
        items: items.slice(0, ROW_SIZE),
      });
    }
  }
  return rows.slice(0, 20);
}

export async function browse(ref, cursor) {
  await null;
  const page = pageFromCursor(cursor);
  if (ref === "catalogo") {
    return await browsePage(pageUrl(page), page);
  }
  if (typeof ref !== "string" || !/^https:\/\//i.test(ref)) {
    throw kino.error("not_found", "La página ya no existe");
  }
  return await browsePage(ref, page);
}

async function browsePage(url, page) {
  const html = await get(withPage(url, page));
  const items = parseSeriesCards(html);
  const next = nextPageFrom(html, page);
  return {
    items: items.slice(0, 100),
    next: next ? String(next) : undefined,
  };
}

export async function episodes(ref) {
  const html = await get(ref);
  const info = parseSeriesInfo(html);
  const list = parseEpisodes(html);
  if (!list.length) {
    throw kino.error("not_found", "No se encontraron episodios", {
      userMessage: "LACartoons no listó episodios para esta serie.",
    });
  }
  const series = {
    title: info.title,
    poster: info.poster,
    overview: info.overview,
    year: info.year,
    rating: info.rating,
    genres: info.category ? [info.category] : undefined,
  };
  await fillTmdb(series);
  return { series, episodes: list };
}

// Azulejos de Categorías (apiVersion 6): cada uno abre browse(ref, null).
export async function categories() {
  await null;
  return CATEGORIES.map((c) => ({
    id: "cat-" + c.id,
    title: c.title,
    ref: c.url,
  }));
}

// Sección propia (apiVersion 6): Inicio y Categorías, con un hero.
export async function section(arg) {
  const tab = arg && typeof arg.tab === "string" && arg.tab ? arg.tab : "inicio";
  const tabs = [
    { id: "inicio", label: T().tabHome },
    { id: "categorias", label: T().tabCats },
  ];
  if (tab === "categorias") {
    const tasks = CATEGORIES.map((c) => () => cachedPage(c.url));
    const pages = await pool(tasks);
    const rows = [];
    for (let i = 0; i < CATEGORIES.length; i++) {
      const items = pages[i] && pages[i].items;
      if (items && items.length) {
        rows.push({
          id: "cat-" + CATEGORIES[i].id,
          title: CATEGORIES[i].title,
          ref: CATEGORIES[i].url,
          genre: "series",
          items: items.slice(0, ROW_SIZE),
        });
      }
    }
    return { tab, tabs, rows };
  }
  const rows = await home();
  return {
    tab: "inicio",
    tabs,
    hero: { title: "LACartoons", text: T().heroText },
    rows,
  };
}

/* =========================================================
   OK.RU
   ========================================================= */

function decodeEntities(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#x2F;/gi, "/")
    .replace(/\\u0026/g, "&")
    .replace(/\\"/g, '"');
}

function metadataFromEmbed(html) {
  const attr = /data-options\s*=\s*(["'])([\s\S]*?)\1/i.exec(html);

  if (attr) {
    try {
      const player = JSON.parse(decodeEntities(attr[2]));

      const raw =
        player &&
        player.flashvars &&
        player.flashvars.metadata;

      if (raw) {
        return typeof raw === "string"
          ? JSON.parse(decodeEntities(raw))
          : raw;
      }
    } catch (_) {}
  }

  const marker =
    /[&\"]?metadata[&\"]?\s*[:=]\s*["']((?:\\.|[^"'])+)["']/i.exec(
      html
    );

  if (marker) {
    try {
      return JSON.parse(decodeEntities(marker[1]));
    } catch (_) {}
  }

  return null;
}

function firstHttps(value) {
  return typeof value === "string" && /^https:\/\//i.test(value)
    ? value
    : null;
}

function durationMsFrom(metadata) {
  const d = metadata && metadata.movie ? Number(metadata.movie.duration) : NaN;
  return d > 0 ? Math.round(d * 1000) : 0;
}

// El token de OK.ru lleva su vencimiento ("expires", en milisegundos):
// Kino espera ese plazo antes de resolver otra vez. Sin él, 1 hora.
function expiresInFrom(url, fallback) {
  try {
    const e = Number(new URL(url).searchParams.get("expires"));
    if (Number.isFinite(e) && e > Date.now()) {
      return Math.max(60, Math.round((e - Date.now()) / 1000));
    }
  } catch (_) {}
  return fallback;
}

// Las calidades de OK.ru vienen en el "name" de cada copia, ordenadas aquí
// de mayor a menor.
const CALIDADES = [
  ["4k", "4K", 7],
  ["fullhd", "Full HD", 6],
  ["hd", "HD", 5],
  ["sd", "SD", 4],
  ["low", "Baja", 3],
  ["lowest", "Más baja", 2],
  ["mobile", "Móvil", 1],
];

function copiasPorCalidad(videos) {
  if (!Array.isArray(videos)) {
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const v of videos) {
    if (!v || typeof v.url !== "string" || !/^https:\/\//i.test(v.url)) {
      continue;
    }
    if (seen.has(v.url)) {
      continue;
    }
    seen.add(v.url);
    const name = String(v.name || "").trim().toLowerCase();
    let label = "Copia";
    let rank = 0;
    for (const [key, text, value] of CALIDADES) {
      if (name === key) {
        label = text;
        rank = value;
        break;
      }
    }
    out.push({ url: v.url, label, rank });
  }
  out.sort((a, b) => b.rank - a.rank);
  return out;
}

async function resolveOkRu(embedUrl) {
  const html = await get(embedUrl);
  const metadata = metadataFromEmbed(html);

  if (!metadata) {
    throw kino.error("unavailable", "OK.ru no entregó los datos del video", {
      userMessage: "El servidor no respondió como esperaba. Intenta con otra copia.",
    });
  }

  const durationMs = durationMsFrom(metadata);

  // El maestro HLS (adaptativo) es la mejor copia; las fijas quedan como
  // alternativas etiquetadas por su calidad. Kino 0.9.54 mueve solo a una
  // copia más ligera cuando el nombre lleva la resolución.
  const hls =
    firstHttps(metadata.hlsManifestUrl) ||
    firstHttps(metadata.hlsMasterPlaylistUrl) ||
    firstHttps(metadata.hlsMasterUrl);

  if (hls) {
    const stream = {
      url: hls,
      mime: "application/vnd.apple.mpegurl",
      label: "OK.ru",
      expiresInSeconds: expiresInFrom(hls, 3600),
    };
    if (durationMs) {
      stream.durationMs = durationMs;
    }
    const copies = copiasPorCalidad(metadata.videos);
    if (copies.length) {
      stream.alternatives = copies.map((c) => ({
        url: c.url,
        label: "OK.ru · " + c.label,
      }));
    }
    return stream;
  }

  const copies = copiasPorCalidad(metadata.videos);

  if (!copies.length) {
    throw kino.error("unavailable", "OK.ru no tiene una versión reproducible");
  }

  const main = copies[0];
  const stream = {
    url: main.url,
    label: "OK.ru · " + main.label,
    expiresInSeconds: expiresInFrom(main.url, 3600),
  };
  if (durationMs) {
    stream.durationMs = durationMs;
  }
  if (copies.length > 1) {
    stream.alternatives = copies.slice(1).map((c) => ({
      url: c.url,
      label: "OK.ru · " + c.label,
    }));
  }
  return stream;
}

/* =========================================================
   CUBEEMBED
   =========================================================
   Réplica de la lógica del player oficial:

     1) GET  {CUBE_BASE}/api/v1/video?id=<hash>&w=1366&h=768&r=
        → respuesta en hex (AES-128-CBC cifrado)

     2) Descifrar con la misma KEY/IV que usa el player.

     3) El JSON contiene, entre otras:
           - hlsVideoTiktok, hlsVideoGoogle, cf, cfNative, inhouse, source
           - streamingConfig: STRING JSON anidado con
             { order: [...], adjust: { <Delivery>: { domain, params, disabled } } }

     4) Elegir la primera fuente disponible. Orden:
           a) cfNative  — mismo dominio que la API, HLS fMP4 limpio
           b) source    — IP directa (Kino no la acepta, se descarta)
           c) resto por `streamingConfig.order`, con Tiktok al final
              cuando la respuesta no trae su propio orden

     5) Aplicar `adjust[Delivery]`:
           - añadir `params` como query params (?v=…)
           - si el path contiene "/hls/", reescribirlo como "/hlsmod/{domain}/"

   La primera fuente es la copia principal; las demás se ofrecen como
   copias etiquetadas (el menú Servidor de Kino), cada una con su ajuste.
   ExoPlayer (Media3) se encarga del resto.
   ========================================================= */

// Construye KEY e IV sin dejarlos escritos directamente
// como texto plano dentro del código.
function cubeCrypto() {
  const iv = [
      49, 50, 51, 52,
      53, 54, 55, 56,
      57, 48, 111, 105,
      117, 121, 116, 114,
    ]
    .map((x) => String.fromCharCode(x))
    .join("");

  return {
    key: kino.secret("cubeKey"),
    iv
  };
}

function cubeVideoId(embedUrl) {
  const hash =
    String(embedUrl).split("#")[1] || "";

  return hash
    .split(/[/?#&]/)[0]
    .trim();
}

// `streamingConfig` viene como STRING JSON anidado dentro del JSON principal.
function parseStreamingConfig(data) {
  const raw = data && data.streamingConfig;

  if (!raw) return null;

  if (typeof raw === "object") return raw;

  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  return null;
}

// Devuelve el objeto `adjust[Delivery]` si existe y no está `disabled`.
function getAdjustFor(delivery, streamingConfig) {
  if (!delivery || !streamingConfig || !streamingConfig.adjust) {
    return null;
  }

  const wanted = String(delivery).toLowerCase();
  const adjust = streamingConfig.adjust;

  for (const key of Object.keys(adjust)) {
    if (key.toLowerCase() === wanted) {
      const adj = adjust[key];
      if (adj && adj.disabled) return null;
      return adj || null;
    }
  }

  return null;
}

// Construye la lista de candidatos. Orden de preferencia:
//
//   1. `cfNative`   — mismo dominio que la API, HLS fMP4 limpio.
//   2. `source`     — IP directa; Kino no la acepta, se descarta.
//   3. Resto según `streamingConfig.order`; sin orden propio, Cloudflare
//      primero y Tiktok al final (su CDN sirve los segmentos como PNG
//      falso + MPEG-TS).
function buildCubeCandidates(data, streamingConfig) {
  const out = [];
  const added = new Set();

  const push = (c) => {
    if (!c || added.has(c.name)) return;
    if (typeof c.url !== "string" || !c.url.trim()) return;
    added.add(c.name);
    out.push(c);
  };

  // --- 1. Fuentes limpias primero ---
  push({
    name: "cfNative",
    delivery: "Cloudflare",
    url: data.cfNative,
  });

  // `source` es una IP; Kino no la acepta.
  // Solo lo añadimos si algún día es un dominio con nombre.
  if (
    typeof data.source === "string" &&
    !/^https?:\/\/\d+\.\d+\.\d+\.\d+/i.test(data.source)
  ) {
    push({
      name: "source",
      delivery: null,
      url: data.source,
    });
  }

  // --- 2. Resto por order ---
  const byDelivery = {
    Tiktok: [
      {
        name: "hlsVideoTiktok",
        delivery: "Tiktok",
        url: data.hlsVideoTiktok,
      },
    ],
    Google: [
      {
        name: "hlsVideoGoogle",
        delivery: "Google",
        url: data.hlsVideoGoogle,
      },
    ],
    Cloudflare: [
      {
        name: "cfNative",
        delivery: "Cloudflare",
        url: data.cfNative,
      },
      {
        name: "cf",
        delivery: "Cloudflare",
        url: data.cf,
      },
    ],
    "In-House": [
      {
        name: "inhouse",
        delivery: "In-House",
        url: data.inhouse,
      },
    ],
  };

  // El orden propio de la respuesta manda; sin él, Cloudflare primero y
  // Tiktok al final.
  const order =
    (streamingConfig && streamingConfig.order) ||
    ["Cloudflare", "Google", "In-House", "Tiktok"];

  for (const delivery of order) {
    if (streamingConfig && streamingConfig.adjust) {
      const wanted = String(delivery).toLowerCase();
      let disabled = false;
      for (const key of Object.keys(streamingConfig.adjust)) {
        if (key.toLowerCase() === wanted) {
          disabled = !!streamingConfig.adjust[key].disabled;
          break;
        }
      }
      if (disabled) continue;
    }

    for (const c of byDelivery[delivery] || []) {
      push(c);
    }
  }

  return out;
}

// Replica la función `ao()` del player:
//   1. añade `adjust.params` como query params
//   2. si hay `adjust.domain` y el path contiene "/hls/",
//      lo reescribe como "/hlsmod/{domain}/"
function applyCubeAdjust(rawUrl, adjust) {
  if (!rawUrl) return rawUrl;

  let u;
  try {
    u = new URL(rawUrl, CUBE_BASE);
  } catch (_) {
    return rawUrl;
  }

  if (
    adjust &&
    adjust.params &&
    typeof adjust.params === "object"
  ) {
    for (const k of Object.keys(adjust.params)) {
      u.searchParams.set(k, adjust.params[k]);
    }
  }

  if (
    adjust &&
    adjust.domain &&
    u.pathname.indexOf("/hls/") !== -1
  ) {
    u.pathname = u.pathname.replace(
      "/hls/",
      "/hlsmod/" + adjust.domain + "/"
    );
  }

  return u.toString();
}

// Nombre de cada copia en el menú Servidor.
function etiquetaCube(nombre) {
  switch (nombre) {
    case "cfNative": return "CubeEmbed · Cloudflare";
    case "cf": return "CubeEmbed · Cloudflare 2";
    case "source": return "CubeEmbed · Directo";
    case "inhouse": return "CubeEmbed · Propio";
    case "hlsVideoGoogle": return "CubeEmbed · Google";
    case "hlsVideoTiktok": return "CubeEmbed · TikTok";
    default: return "CubeEmbed";
  }
}

async function resolveCubeEmbed(embedUrl) {
  const id = cubeVideoId(embedUrl);

  if (!id) {
    throw kino.error(
      "not_found",
      "CubeEmbed no tiene ID de video"
    );
  }

  const apiUrl =
    CUBE_BASE +
    "/api/v1/video?id=" +
    encodeURIComponent(id) +
    "&w=1366&h=768&r=";

  const response = await kino.fetch(apiUrl, {
    timeoutMs: REQUEST_TIMEOUT_MS,

    headers: {
      Referer: CUBE_BASE + "/",
      Accept: "*/*",
      "User-Agent": UA,
    },
  });

  if (!response.ok) {
    throw kino.error(
      "unavailable",
      "CubeEmbed respondió " + response.status
    );
  }

  const hex = String(await response.text()).trim();

  if (
    !/^[0-9a-f]+$/i.test(hex) ||
    hex.length % 2 !== 0
  ) {
    throw kino.error(
      "unavailable",
      "CubeEmbed devolvió datos cifrados inválidos"
    );
  }

  // AES trabaja en bloques de 16 bytes = 32 caracteres hex.
  if (hex.length % 32 !== 0) {
    throw kino.error(
      "unavailable",
      "Los datos de CubeEmbed no tienen un tamaño AES válido"
    );
  }

  const { key, iv } = cubeCrypto();

  // kino.crypto.decrypt recibe el cifrado en hex (inputEncoding)
  // y devuelve el texto ya en utf8.
  let jsonText;

  try {
    jsonText = kino.crypto.decrypt(
      "aes-128-cbc",
      {
        key,
        iv,
        data: hex,
        inputEncoding: "hex",
      }
    );
  } catch (e) {
    log(
      "[CubeEmbed] Error de descifrado:",
      e && e.message ? e.message : e
    );

    throw kino.error(
      "unavailable",
      "No se pudo descifrar la respuesta de CubeEmbed"
    );
  }

  let data;

  try {
    data = JSON.parse(jsonText);
  } catch (e) {
    throw kino.error(
      "unavailable",
      "CubeEmbed devolvió JSON inválido"
    );
  }

  const streamingConfig = parseStreamingConfig(data);
  const candidates = buildCubeCandidates(data, streamingConfig);

  if (!candidates.length) {
    throw kino.error(
      "unavailable",
      "CubeEmbed no devolvió una fuente reproducible"
    );
  }

  // Cada candidato es una copia del mismo video: la primera es la
  // principal y el resto se ofrecen etiquetadas, cada una con su ajuste.
  const headers = {
    Referer: CUBE_BASE + "/",
    "User-Agent": UA,
  };
  const copies = [];

  for (const c of candidates) {
    const rawUrl = /^https?:\/\//i.test(c.url)
      ? c.url
      : new URL(c.url, CUBE_BASE).toString();
    const adjust = c.delivery
      ? getAdjustFor(c.delivery, streamingConfig)
      : null;
    copies.push({
      url: applyCubeAdjust(rawUrl, adjust),
      label: etiquetaCube(c.name),
    });
  }

  const main = copies[0];
  const stream = {
    url: main.url,
    mime: "application/vnd.apple.mpegurl",
    label: main.label,
    expiresInSeconds: 3600,
    headers,
  };

  if (copies.length > 1) {
    stream.alternatives = copies.slice(1, 9).map((c) => ({
      url: c.url,
      mime: "application/vnd.apple.mpegurl",
      headers,
      label: c.label,
    }));
  }

  log(
    "[CubeEmbed] Copia principal:",
    main.label,
    "| alternativas:",
    copies.length - 1
  );

  return stream;
}

/* =========================================================
   DHTPRE (reproductor JWPlayer con script "packer")
   ========================================================= */

// Desempaqueta un script eval(function(p,a,c,k,e,d){...}) sin usar eval:
// reemplaza cada palabra codificada por su valor del diccionario.
function unpackPacker(script) {
  const m =
    /\}\('([\s\S]*)',\s*(\d+),\s*(\d+),\s*'([\s\S]*?)'\.split\('\|'\)/.exec(
      script
    );

  if (!m) {
    return null;
  }

  const payload = m[1];
  const radix = Number(m[2]);
  let count = Number(m[3]);
  const words = m[4].split("|");

  const encode = (n) =>
    (n < radix ? "" : encode(Math.floor(n / radix))) +
    ((n = n % radix) > 35
      ? String.fromCharCode(n + 29)
      : n.toString(36));

  const dict = {};

  while (count--) {
    const key = encode(count);
    dict[key] = words[count] || key;
  }

  return payload.replace(/\b\w+\b/g, (w) =>
    Object.prototype.hasOwnProperty.call(dict, w) ? dict[w] : w
  );
}

async function resolveDhtpre(embedUrl) {
  const r = await kino.fetch(embedUrl, {
    timeoutMs: REQUEST_TIMEOUT_MS,
    headers: {
      Referer: BASE + "/",
      "User-Agent": "Mozilla/5.0",
    },
  });

  if (!r.ok) {
    throw kino.error(
      "unavailable",
      "El reproductor respondió " + r.status
    );
  }

  const html = await r.text();

  const packed =
    /eval\(function\(p,a,c,k,e,d\)[\s\S]*?\.split\('\|'\)[^)]*\)\)/.exec(
      html
    );

  const code = packed ? unpackPacker(packed[0]) : html;

  if (!code) {
    throw kino.error(
      "unavailable",
      "No se pudo leer el reproductor"
    );
  }

  // El reproductor usa links.hls4 || links.hls3 || links.hls2, en ese orden.
  const links = {};
  const re = /"(hls\d+)"\s*:\s*"([^"]+)"/g;
  let m;

  while ((m = re.exec(code)) !== null) {
    links[m[1]] = m[2];
  }

  // Cada nivel es una copia del mismo video, etiquetada por su calidad.
  const niveles = [
    { key: "hls4", label: "Dhtpre · Alta" },
    { key: "hls3", label: "Dhtpre · Media" },
    { key: "hls2", label: "Dhtpre · Baja" },
  ].filter((n) => typeof links[n.key] === "string" && links[n.key]);

  if (!niveles.length) {
    throw kino.error(
      "unavailable",
      "El reproductor no tiene una fuente reproducible"
    );
  }

  const origin = new URL(embedUrl).origin;
  const main = niveles[0];
  const headers = { Referer: origin + "/" };
  const stream = {
    url: new URL(links[main.key], origin).toString(),
    mime: "application/vnd.apple.mpegurl",
    label: main.label,
    headers,
  };

  if (niveles.length > 1) {
    stream.alternatives = niveles.slice(1).map((n) => ({
      url: new URL(links[n.key], origin).toString(),
      mime: "application/vnd.apple.mpegurl",
      headers,
      label: n.label,
    }));
  }

  return stream;
}

/* =========================================================
   RESOLVE
   ========================================================= */

function etiquetaServidor(host) {
  if (
    host === "ok.ru" ||
    host.endsWith(".ok.ru") ||
    host === "odnoklassniki.ru" ||
    host.endsWith(".odnoklassniki.ru")
  ) {
    return "OK.ru";
  }
  if (
    host === "cubeembed.rpmvid.com" ||
    host.endsWith(".cubeembed.rpmvid.com")
  ) {
    return "CubeEmbed";
  }
  if (host === "dhtpre.com" || host.endsWith(".dhtpre.com")) {
    return "Dhtpre";
  }
  return "";
}

// Todos los reproductores del episodio, en el orden del sitio.
function listarServidores(html) {
  const out = [];
  const re = /<iframe[^>]+src="([^"]+)"[^>]*>/gi;
  let m;

  while ((m = re.exec(html)) !== null && out.length < 8) {
    let u;
    try {
      u = new URL(absolute(decodeHtml(m[1])));
    } catch (_) {
      continue;
    }
    const label = etiquetaServidor(u.hostname.toLowerCase());
    if (!label) {
      continue;
    }
    out.push({ url: u.toString(), host: u.hostname.toLowerCase(), label });
  }

  return out;
}

async function resolverServidor(server) {
  if (server.label === "OK.ru") {
    return resolveOkRu(server.url);
  }
  if (server.label === "CubeEmbed") {
    return resolveCubeEmbed(server.url);
  }
  if (server.label === "Dhtpre") {
    return resolveDhtpre(server.url);
  }
  throw kino.error("unavailable", "Proveedor de video no compatible");
}

export async function resolve(ref, options) {
  await null;

  if (typeof ref !== "string" || !ref) {
    throw kino.error("not_found", "Referencia vacía");
  }

  if (options && options.retry) {
    log(
      "Resolve reintentado:",
      options.retry.reason,
      "intento " + options.retry.attempt
    );
  }

  const html = await get(ref);
  const servers = listarServidores(html);

  if (!servers.length) {
    throw kino.error("not_found", "El episodio no tiene video", {
      userMessage: "Este episodio ya no tiene video disponible.",
    });
  }

  let ultimo = null;

  for (const server of servers) {
    try {
      return await resolverServidor(server);
    } catch (e) {
      ultimo = e;
      log(
        "El servidor falló (" + server.label + "):",
        e && e.code ? e.code : e
      );
    }
  }

  if (ultimo && ultimo.code) {
    throw ultimo;
  }

  throw kino.error("unavailable", "Ningún servidor respondió", {
    userMessage: "Ningún servidor pudo reproducir este episodio.",
  });
}
