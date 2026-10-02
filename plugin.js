/// <reference path="./kino.d.ts" />

// Kino plugin for LACartoons.
// Supports OK.ru, CubeEmbed y Dhtpre.

const BASE = "https://www.lacartoons.com";
const CUBE_BASE = "https://cubeembed.rpmvid.com";

const PAGE_SIZE = 50;
const HOME_SIZE = 20;

// Categorías que home() carga, en paralelo: home() entero tiene 20 s en Kino.
const HOME_CATEGORIES = 4;

// Por petición (el mismo valor por defecto de kino.fetch). LACartoons a veces
// tarda ~8 s en una página de serie; menos que esto corta respuestas válidas.
const REQUEST_TIMEOUT_MS = 15000;

// En Kino 0.9.43 kino.log lanza "Cannot convert java type 'l7.s'" (bug de Kino, ya
// corregido para la próxima versión): el log se escribe igual, solo falla el retorno.
function log(...args) {
  try {
    kino.log(...args);
  } catch (_) {}
}

function absolute(url) {
  return new URL(url, BASE).toString();
}

function decodeHtml(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripTags(text) {
  return decodeHtml(String(text || "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function slug(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "serie";
}

function seriesId(url, title) {
  const m = /\/serie\/([^/?#]+)/i.exec(url);
  return "lc-" + (m ? slug(m[1]) : slug(title));
}

async function get(url, timeoutMs = REQUEST_TIMEOUT_MS) {
  const r = await kino.fetch(url, { timeoutMs });

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

    throw kino.error(
      "unavailable",
      "LACartoons respondió " + r.status
    );
  }

  return r.text();
}

function parseSeriesCards(html) {
  const out = [];
  const seen = new Set();

  const re =
    /a\s+href="(\/serie[^\"]+)"[\s\S]*?src="([^\"]+)"[\s\S]*?nombre-serie">([\s\S]*?)<\/p>[\s\S]*?class="marcador marcador-ano">([\s\S]*?)<\/span>/gi;

  let m;

  while ((m = re.exec(html)) !== null && out.length < 100) {
    const url = absolute(decodeHtml(m[1]));
    const title = stripTags(m[3]);
    const year = stripTags(m[4]);
    const id = seriesId(url, title);

    if (seen.has(id) || !title) {
      continue;
    }

    seen.add(id);

    out.push({
      id,
      ref: url,
      title,
      kind: "series",
      year: year || undefined,
      poster: absolute(decodeHtml(m[2])),
    });
  }

  return out;
}

function parseCategoryLinks(html) {
  const out = [];

  const re =
    /<button[^>]*type="submit"[^>]*>\s*([^<]+?)\s*<\/button>[\s\S]*?value="([^"]+)"/gi;

  let m;

  while ((m = re.exec(html)) !== null && out.length < 20) {
    const title = stripTags(m[1]);
    const id = String(m[2]).trim();

    if (title && id) {
      out.push({
        id: "cat-" + slug(id),
        title,
        url:
          BASE +
          "/?Categoria_id=" +
          encodeURIComponent(id),
      });
    }
  }

  return out;
}

function pageUrl(page) {
  return page <= 1
    ? BASE + "/"
    : BASE + "/?page=" + page;
}

function pageFromCursor(cursor) {
  const n = cursor ? Number(cursor) : 1;

  return Number.isInteger(n) &&
    n >= 1 &&
    n <= 100
    ? n
    : 1;
}

export async function search(query) {
  await null;

  const q = String(query && query.q || "").trim();

  if (!q) {
    return [];
  }

  const url =
    BASE +
    "/?utf8=%E2%9C%93&Titulo=" +
    encodeURIComponent(q) +
    "&button=";

  const html = await get(url);

  return parseSeriesCards(html).slice(0, 100);
}

export async function home() {
  const html = await get(BASE + "/");

  const rows = [];
  const all = parseSeriesCards(html);

  if (all.length) {
    rows.push({
      id: "catalogo",
      title: "Series",
      ref: "catalogo",
      items: all.slice(0, HOME_SIZE),
    });
  }

  const categories = parseCategoryLinks(html)
    .slice(0, HOME_CATEGORIES);

  // En paralelo: una por una, varias categorías se comen los 20 s de home().
  const categoryRows = await Promise.all(
    categories.map(async (category) => {
      try {
        const categoryHtml = await get(category.url);

        const items = parseSeriesCards(categoryHtml)
          .slice(0, HOME_SIZE);

        return items.length
          ? {
              id: category.id,
              title: category.title,
              ref: category.url,
              items,
            }
          : null;
      } catch (e) {
        log(
          "No se pudo cargar la categoría",
          category.title,
          e && e.message ? e.message : e
        );
        return null;
      }
    })
  );

  for (const row of categoryRows) {
    if (row) {
      rows.push(row);
    }
  }

  return rows.slice(0, 20);
}

export async function browse(ref, cursor) {
  await null;

  const page = pageFromCursor(cursor);

  if (ref === "catalogo") {
    const html = await get(pageUrl(page));

    const items = parseSeriesCards(html)
      .slice(0, 100);

    return {
      items,
      next:
        items.length >= PAGE_SIZE
          ? String(page + 1)
          : undefined,
    };
  }

  if (
    typeof ref !== "string" ||
    !/^https:\/\//i.test(ref)
  ) {
    throw kino.error(
      "not_found",
      "La categoría ya no existe"
    );
  }

  const url =
    ref +
    (ref.includes("?") ? "&page=" : "?page=") +
    page;

  const html = await get(url);

  const items = parseSeriesCards(html)
    .slice(0, 100);

  return {
    items,
    next:
      items.length >= PAGE_SIZE
        ? String(page + 1)
        : undefined,
  };
}

function parseEpisodes(html, seriesUrl) {
  const episodes = [];
  const blocks = [];

  const blockRe =
    /(?:fa\s+fa-chevron-right[^>]*><\/span>\s*)?Temporada\s+(\d+)([\s\S]*?)(?=(?:fa\s+fa-chevron-right[^>]*><\/span>\s*)?Temporada\s+\d+|Series recomendadas|<\/body>|$)/gi;

  let b;

  while ((b = blockRe.exec(html)) !== null) {
    blocks.push({
      season: Number(b[1]),
      html: b[2],
    });
  }

  const addFromBlock = (season, blockHtml) => {
    const re =
      /href="([^"]*\/serie\/capitulo\/[^\"]+)"[\s\S]*?<span>([^<]*)<\/span>([\s\S]*?)<\/a>/gi;

    let m;

    while (
      (m = re.exec(blockHtml)) !== null &&
      episodes.length < 5000
    ) {
      const url = absolute(decodeHtml(m[1]));
      const cap = stripTags(m[2]);
      const body = stripTags(m[3]);

      const n = /Capitulo\s+(\d+)/i.exec(cap);
      const number = n ? Number(n[1]) : 0;

      if (!number) {
        continue;
      }

      let title =
        (
          season +
          "x" +
          number +
          " " +
          cap +
          " " +
          body
        )
          .replace(/--/g, "")
          .replace(/-/g, "")
          .trim();

      title = title.replace(
        new RegExp(
          "^" +
          season +
          "x" +
          number +
          "\\s+"
        ),
        ""
      );

      title = title.replace(
        new RegExp(
          "^Capitulo\\s+" +
          number +
          "\\s+",
          "i"
        ),
        ""
      ).trim();

      episodes.push({
        season,
        number,
        ref: url,
        title,
      });
    }
  };

  if (blocks.length) {
    for (const block of blocks) {
      addFromBlock(
        block.season,
        block.html
      );
    }
  } else {
    addFromBlock(1, html);
  }

  return {
    episodes,
    seriesUrl,
  };
}

export async function episodes(ref) {
  const html = await get(ref);

  const parsed = parseEpisodes(html, ref);

  if (!parsed.episodes.length) {
    throw kino.error(
      "not_found",
      "No se encontraron episodios"
    );
  }

  // El nombre de la serie está en el h2 "subtitulo-serie-seccion" (el h1 viene vacío).
  const titleMatch =
    /<h2[^>]*subtitulo-serie-seccion[^>]*>\s*([^<]+)/i.exec(html) ||
    /<h1[^>]*>\s*([^<]+?)\s*<\/h1>/i.exec(html);

  const title = titleMatch
    ? stripTags(titleMatch[1])
    : "LACartoons";

  // og:image primero: el primer <img> de la página puede ser el logo del sitio.
  const posterMatch =
    /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i.exec(html) ||
    /<img[^>]+src="([^"]+)"/i.exec(html);

  return {
    series: {
      title,
      poster: posterMatch
        ? absolute(
            decodeHtml(posterMatch[1])
          )
        : undefined,
    },

    episodes: parsed.episodes,
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
    .replace(/\\\"/g, '"');
}

function metadataFromEmbed(html) {
  const attr =
    /data-options\s*=\s*(["'])([\s\S]*?)\1/i.exec(html);

  if (attr) {
    try {
      const player = JSON.parse(
        decodeEntities(attr[2])
      );

      const raw =
        player &&
        player.flashvars &&
        player.flashvars.metadata;

      if (raw) {
        return typeof raw === "string"
          ? JSON.parse(
              decodeEntities(raw)
            )
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
      return JSON.parse(
        decodeEntities(marker[1])
      );
    } catch (_) {}
  }

  return null;
}

function firstPlayableVideo(metadata) {
  const videos =
    metadata &&
    Array.isArray(metadata.videos)
      ? metadata.videos
      : [];

  const ranked = videos
    .slice()
    .sort(
      (a, b) =>
        Number(b.width || 0) -
        Number(a.width || 0)
    );

  return (
    ranked.find(
      (v) =>
        typeof v.url === "string" &&
        /^https:\/\//i.test(v.url)
    ) || null
  );
}

async function resolveOkRu(embedUrl) {
  const embedHtml = await get(embedUrl);

  const metadata =
    metadataFromEmbed(embedHtml);

  if (!metadata) {
    throw kino.error(
      "unavailable",
      "OK.ru no entregó los datos del video"
    );
  }

  const hls =
    metadata.hlsMasterPlaylistUrl ||
    metadata.hlsMasterUrl;

  if (
    typeof hls === "string" &&
    /^https:\/\//i.test(hls)
  ) {
    return {
      url: hls,
      mime: "application/vnd.apple.mpegurl",
    };
  }

  const video =
    firstPlayableVideo(metadata);

  if (video) {
    return {
      url: video.url,
      mime: "video/mp4",
      durationMs:
        Number(
          metadata.movie &&
          metadata.movie.duration
        ) > 0
          ? Math.round(
              Number(
                metadata.movie.duration
              ) * 1000
            )
          : undefined,
    };
  }

  throw kino.error(
    "unavailable",
    "No se encontró una versión reproducible"
  );
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
          - streamingConfig: STRING JSON anidado con:
              { order: [...], adjust: { <Delivery>: { domain, params, disabled } } }

     4) Elegir la primera fuente disponible. Orden:
          a) cfNative  — mismo dominio que la API (whitelisted), fMP4 limpio
          b) source    — IP directa (Kino la rechaza por whitelist, pero por si acaso)
          c) resto por `streamingConfig.order`, con Tiktok al final

     5) Aplicar `adjust[Delivery]`:
          - añadir `params` como query params (?v=…)
          - si el path contiene "/hls/", reescribirlo como "/hlsmod/{domain}/"

     ExoPlayer (Media3) se encarga solo del resto.
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
//   1. `cfNative`   — mismo dominio que la API (whitelisted en Kino),
//                     con k/kx ya embebidos, HLS fMP4 limpio.
//   2. `source`     — IP directa. Kino NO acepta IPs en su whitelist
//                     de hosts, así que se descarta si es una IP.
//   3. Resto según `streamingConfig.order`, con Tiktok al final
//      porque su CDN sirve los segmentos como PNG falso + MPEG-TS.
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

  // `source` es una IP; Kino la rechaza en la whitelist.
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

  const order =
    (streamingConfig && streamingConfig.order) ||
    ["Tiktok", "Google", "Cloudflare", "In-House"];

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

  log("[CubeEmbed] Video ID:", id);
  log("[CubeEmbed] API:", apiUrl);

  const response = await kino.fetch(apiUrl, {
    timeoutMs: REQUEST_TIMEOUT_MS,

    headers: {
      Referer: CUBE_BASE + "/",
      Accept: "*/*",
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64; rv:157.0) " +
        "Gecko/20100101 Firefox/157.0",
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

  log("[CubeEmbed] Bytes cifrados:", hex.length / 2);

  const { key, iv } = cubeCrypto();

  // kino.crypto.decrypt recibe el cifrado en hex (inputEncoding)
  // y devuelve el texto ya en utf8: no hace falta Buffer.
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

  log("[CubeEmbed] Descifrado correctamente");

  if (data.title) {
    log("[CubeEmbed] Título:", data.title);
  }

  const streamingConfig = parseStreamingConfig(data);

  if (streamingConfig && streamingConfig.order) {
    log(
      "[CubeEmbed] order:",
      streamingConfig.order.join(",")
    );
  }

  const candidates = buildCubeCandidates(data, streamingConfig);

  if (!candidates.length) {
    throw kino.error(
      "unavailable",
      "CubeEmbed no devolvió una fuente reproducible"
    );
  }

  const selected = candidates[0];

  log(
    "[CubeEmbed] Fuente:",
    selected.name,
    selected.delivery ? "(" + selected.delivery + ")" : ""
  );

  // URL absoluta (algunas fuentes son relativas: "/hls/...").
  const rawUrl = /^https?:\/\//i.test(selected.url)
    ? selected.url
    : new URL(selected.url, CUBE_BASE).toString();

  log("[CubeEmbed] M3U8 (cruda):", rawUrl);

  const adjust = selected.delivery
    ? getAdjustFor(selected.delivery, streamingConfig)
    : null;

  if (adjust) {
    log(
      "[CubeEmbed] adjust:",
      "domain=" + (adjust.domain || "-"),
      "params=" + (adjust.params ? Object.keys(adjust.params).join(",") : "-")
    );
  }

  const finalUrl = applyCubeAdjust(rawUrl, adjust);

  log("[CubeEmbed] M3U8 (final):", finalUrl);

  return {
    url: finalUrl,
    mime: "application/vnd.apple.mpegurl",
    headers: {
      Referer: CUBE_BASE + "/",
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64; rv:157.0) " +
        "Gecko/20100101 Firefox/157.0",
    },
  };
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

  const chosen = links.hls4 || links.hls3 || links.hls2;

  if (!chosen) {
    throw kino.error(
      "unavailable",
      "El reproductor no tiene una fuente reproducible"
    );
  }

  const origin = new URL(embedUrl).origin;
  const url = new URL(chosen, origin).toString();

  log("[Dhtpre] M3U8:", url.split("?")[0]);

  return {
    url,
    mime: "application/vnd.apple.mpegurl",
    headers: {
      Referer: origin + "/",
    },
  };
}


/* =========================================================
   RESOLVE
   ========================================================= */

export async function resolve(ref) {
  await null;

  if (
    typeof ref !== "string" ||
    !ref
  ) {
    throw kino.error("not_found");
  }

  const episodeHtml = await get(ref);

  const iframe =
    /<iframe[^>]+src="([^"]+)"/i.exec(
      episodeHtml
    );

  if (!iframe) {
    throw kino.error(
      "not_found",
      "El episodio no tiene video disponible"
    );
  }

  const embedUrl = absolute(iframe[1]);

  let hostname;

  try {
    hostname = new URL(embedUrl)
      .hostname
      .toLowerCase();
  } catch (_) {
    throw kino.error(
      "unavailable",
      "La URL del reproductor no es válida"
    );
  }

  // CubeEmbed
  if (
    hostname === "cubeembed.rpmvid.com" ||
    hostname.endsWith(".cubeembed.rpmvid.com")
  ) {
    return resolveCubeEmbed(embedUrl);
  }

  // OK.ru / Odnoklassniki
  if (
    hostname === "ok.ru" ||
    hostname.endsWith(".ok.ru") ||
    hostname === "odnoklassniki.ru" ||
    hostname.endsWith(".odnoklassniki.ru")
  ) {
    return resolveOkRu(embedUrl);
  }

  // Dhtpre (JWPlayer con script empaquetado)
  if (
    hostname === "dhtpre.com" ||
    hostname.endsWith(".dhtpre.com")
  ) {
    return resolveDhtpre(embedUrl);
  }

  throw kino.error(
    "unavailable",
    "Proveedor de video no compatible: " + hostname
  );
}