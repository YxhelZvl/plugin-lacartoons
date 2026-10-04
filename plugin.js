const URL_DATOS = 'https://raw.githubusercontent.com/YxhelZvl/kino-datasource/refs/heads/main/harry_potter.json';

// 🪄 1. Desencriptar la URL ofuscada
async function desencriptarUrl(urlOfuscada) {
    console.log("[HP-PLUGIN] 🔓 Iniciando desencriptación de URL...");
    if (!urlOfuscada.startsWith('YxhelZvl::')) {
        console.log("[HP-PLUGIN] ⚠️ URL no tiene el prefijo esperado, se devuelve tal cual.");
        return urlOfuscada;
    }

    const payload = urlOfuscada.substring(10); // Quita "YxhelZvl::"
    const ivBase64 = payload.substring(0, 16);
    const datosConTag = payload.substring(16);
    console.log("[HP-PLUGIN] 🧩 IV Base64 extraído:", ivBase64);

    console.log("[HP-PLUGIN] 🔑 Solicitando clave secreta a kino.secret...");
    const clave = await kino.secret('hpKey');
    console.log("[HP-PLUGIN] ✅ Clave recibida (longitud):", clave ? clave.length : "null");

    // CONVERSIÓN SEGURA PARA QUICKJS (sin Buffer):
    const ivRaw = atob(ivBase64);
    let ivHex = '';
    for (let i = 0; i < ivRaw.length; i++) {
        const hex = ivRaw.charCodeAt(i).toString(16);
        ivHex += hex.length === 2 ? hex : '0' + hex;
    }
    console.log("[HP-PLUGIN] 🔢 IV convertido a Hex:", ivHex);

    try {
        console.log("[HP-PLUGIN] 🛡️ Ejecutando kino.crypto.decrypt...");
        const urlReal = await kino.crypto.decrypt('aes-256-gcm', {
            key: clave,
            keyEncoding: 'hex',
            iv: ivHex,
            ivEncoding: 'hex',
            data: datosConTag
        });
        console.log("[HP-PLUGIN] 🎉 ¡Desencriptación exitosa!");
        return urlReal;
    } catch (e) {
        console.error("[HP-PLUGIN] ❌ Fallo al desencriptar:", e.message);
        return urlOfuscada;
    }
}

// 🌐 Resolvedor de Yandex Disk
async function resolverYandex(url) {
    console.log("[HP-PLUGIN] 🌐 Iniciando resolución de Yandex Disk para:", url);
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
        url = "https://" + url;
    }

    console.log("[HP-PLUGIN] 📥 Paso 1: Obteniendo HTML de la página pública...");
    const r = await kino.fetch(url, {
        headers: {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:157.0) Gecko/20100101 Firefox/157.0"
        },
        timeoutMs: 15000
    });
    if (!r.ok) throw new Error("No se pudo acceder a la página de Yandex (Status: " + r.status + ")");
    console.log("[HP-PLUGIN] ✅ HTML obtenido correctamente.");

    const html = await r.text();

    console.log("[HP-PLUGIN] 🔍 Paso 2: Extrayendo bloque store-prefetch...");
    const match = html.match(/<script[^>]*id=["']store-prefetch["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!match) throw new Error("No se encontró store-prefetch en la página de Yandex");
    console.log("[HP-PLUGIN] ✅ store-prefetch encontrado y parseado.");

    const store = JSON.parse(match[1]);

    console.log("[HP-PLUGIN] 📂 Paso 3: Localizando recurso principal...");
    const rootId = store.rootResourceId;
    const resources = store.resources || {};
    let resource = resources[rootId];

    if (!resource) {
        for (const key in resources) {
            if (resources[key] && resources[key].type === "file") {
                resource = resources[key];
                break;
            }
        }
    }
    if (!resource) throw new Error("No se encontró ningún recurso de tipo file");
    console.log("[HP-PLUGIN] ✅ Recurso encontrado.");

    console.log("[HP-PLUGIN] 📝 Paso 4: Extrayendo datos (hash, sk)...");
    const fileHash = resource.hash || resource.path;
    if (!fileHash) throw new Error("El recurso no contiene hash/path");

    const environment = store.environment || {};
    const sk = environment.externalSk || environment.sk || environment.authSk;
    if (!sk) throw new Error("No se encontró el parámetro sk");
    console.log("[HP-PLUGIN] ✅ Datos extraídos. Hash:", fileHash.substring(0, 10) + "...");

    console.log("[HP-PLUGIN] 📤 Paso 5: Solicitando URL de descarga a la API de Yandex...");
    const payload = { hash: fileHash, sk: sk };
    const postRes = await kino.fetch("https://disk.yandex.ru/public/api/download-url", {
        method: "POST",
        headers: {
            "Content-Type": "text/plain",
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0 (Linux; Android 5.0.2; SM-G920F Build/LRX22G; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/46.0.2490.76 Mobile Safari/537.36"
        },
        body: JSON.stringify(payload),
        timeoutMs: 15000
    });

    if (!postRes.ok) throw new Error("Error en la petición a la API de Yandex (Status: " + postRes.status + ")");
    const postData = await postRes.json();

    if (postData.error) throw new Error(`Yandex devolvió un error: ${JSON.stringify(postData)}`);

    const downloadUrl = postData.data?.url;
    if (!downloadUrl) throw new Error("No se encontró data.url en la respuesta de Yandex");
    console.log("[HP-PLUGIN] ✅ URL de descarga temporal obtenida.");

    console.log("[HP-PLUGIN] 🔄 Paso 6: Resolviendo redirección final (método HEAD)...");
    const redirectRes = await kino.fetch(downloadUrl, {
        method: "HEAD",
        timeoutMs: 15000
    });

    if (!redirectRes.ok) {
        throw new Error(`Error al seguir la redirección: ${redirectRes.status}`);
    }

    const finalUrl = redirectRes.url.trim();
    console.log("[HP-PLUGIN] 🎯 ¡Redirección resuelta! URL final obtenida.");
    return finalUrl;
}

// 🏠 3. Pantalla de Inicio
export async function home() {
    console.log("[HP-PLUGIN] 🏠 Llamada a función: home()");
    const r = await kino.fetch(URL_DATOS);
    if (!r.ok) throw kino.error('unavailable', 'No se pudo cargar la lista de películas.');

    const datos = await r.json();
    console.log("[HP-PLUGIN] ✅ JSON de datos cargado. Total películas:", datos.peliculas.length);

    return [{
        id: 'hp-saga-completa',
        title: 'Saga Completa de Harry Potter',
        items: datos.peliculas.map(p => ({
            id: p.id,
            title: p.titulo,
            subtitle: `${p.anio} • ${p.calidad} • ${p.tamano}`,
            // ⚠️ IMPORTANTE: Si en tu JSON el campo se llama "poster" o "img", cámbialo aquí.
            // Debe coincidir exactamente con el nombre en tu archivo harry_potter.json
            poster: p.imagen,
            ref: p.id,
            kind: 'movie',
            quality: p.calidad,
            year: p.anio,
            originalTitle: p.alternativoT
        }))
    }];
}

// 🔍 4. Búsqueda
export async function search(query) {
    console.log("[HP-PLUGIN] 🔍 Llamada a función: search() con query:", query.q);
    const r = await kino.fetch(URL_DATOS);
    if (!r.ok) throw kino.error('unavailable', 'No se pudo buscar.');

    const datos = await r.json();
    const busqueda = (query.q || "").toLowerCase();

    const resultados = datos.peliculas
        .filter(p =>
            p.titulo.toLowerCase().includes(busqueda) ||
            p.alternativoT.toLowerCase().includes(busqueda) ||
            p.anio.toString().includes(busqueda)

        )
        .map(p => ({
            id: p.id,
            title: p.titulo,
            subtitle: `${p.anio} • ${p.calidad} • ${p.tamano}`,
            poster: p.imagen,
            ref: p.id,
            kind: 'movie',
            quality: p.calidad,
            year: p.anio,
            originalTitle: p.alternativoT
        }));

    console.log("[HP-PLUGIN] ✅ Búsqueda completada. Resultados encontrados:", resultados.length);
    return { items: resultados };
}

// ▶️ 5. Reproducir
export async function resolve(ref) {
    console.log("[HP-PLUGIN] ▶️ Llamada a función: resolve() con ref:", ref);
    const r = await kino.fetch(URL_DATOS);
    if (!r.ok) throw kino.error('unavailable', 'No se pudo obtener el video.');

    const datos = await r.json();
    const pelicula = datos.peliculas.find(p => p.id === ref);
    if (!pelicula) throw kino.error('not_found', 'Película no encontrada.');
    console.log("[HP-PLUGIN] ✅ Película encontrada:", pelicula.titulo);

    // 1. Desencriptamos la URL
    console.log("[HP-PLUGIN] 🔐 Iniciando proceso de desencriptación...");
    let urlReal = await desencriptarUrl(pelicula.url);

    // 2. Si es una URL de Yandex Disk, la resolvemos a su enlace directo
    if (urlReal.includes("yadi.sk") || urlReal.includes("disk.yandex")) {
        console.log("[HP-PLUGIN] 🔄 Detectado Yandex Disk. Iniciando resolución...");
        urlReal = await resolverYandex(urlReal);
        console.log("[HP-PLUGIN] ✅ URL directa de Yandex obtenida exitosamente.");
    } else {
        console.log("[HP-PLUGIN] ℹ️ URL no es de Yandex, se usa directamente.");
    }

    // 3. Entregamos la URL directa a Kino
    console.log("[HP-PLUGIN] 🚀 Devolviendo stream a Kino. URL final lista.");
    console.log(`[HP-PLUGIN] 🚀 Devolviendo streaming url: ${urlReal}`);
    return {
        url: urlReal
    };
}