/**
 * Resout, une fois pour toutes, les caracteristiques physiques de chaque spot :
 *   - granulometrie       -> SoilGrids (ISRIC), 250 m
 *   - lithologie          -> BRGM, carte lithologique simplifiee au 1/1 000 000
 *   - altitude/pente/expo -> MNT IGN RGE ALTI via la Geoplateforme
 *
 * Ces donnees ne changent pas : on les fige dans data/spots.enriched.json,
 * le front n'appelle plus ensuite que la meteo.
 *
 *   node scripts/enrich-spots.mjs
 */

import { readFile, writeFile } from 'node:fs/promises';
import { parametresHydro, decrireSol } from '../src/js/soil.js';

const ENTREE = new URL('../data/spots.json', import.meta.url);
const SORTIE = new URL('../data/spots.enriched.json', import.meta.url);

/** Demi-pas du stencil de calcul de pente, en metres. */
const PAS_MNT = 150;
/** SoilGrids plafonne a ~5 requetes/minute : on espace franchement. */
const PAUSE_SOILGRIDS_MS = 12000;
/** Attente apres un refus pour depassement de quota. */
const PAUSE_QUOTA_MS = 65000;
/** Pause entre les points d'une couronne de repli (cas rare). */
const PAUSE_COURONNE_MS = 6000;

/* ------------------------------------------------------------------ */

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchAvecReprises(url, essais = 4) {
  let derniereErreur;
  for (let tentative = 1; tentative <= essais; tentative++) {
    try {
      const reponse = await fetch(url, { signal: AbortSignal.timeout(45000) });
      if (!reponse.ok) {
        const err = new Error(`HTTP ${reponse.status}`);
        err.statut = reponse.status;
        throw err;
      }
      return reponse;
    } catch (err) {
      derniereErreur = err;
      if (tentative === essais) break;
      // Un 429 veut dire quota epuise : inutile de reessayer vite,
      // il faut laisser la fenetre de comptage se vider.
      const attente = err.statut === 429 ? PAUSE_QUOTA_MS : 3000 * 2 ** (tentative - 1);
      console.log(`      ...reprise dans ${Math.round(attente / 1000)} s (${err.message})`);
      await pause(attente);
    }
  }
  throw derniereErreur;
}

/* ---------------------------- SoilGrids --------------------------- */

/**
 * SoilGrids masque les pixels batis et les plans d'eau : il repond alors 200
 * avec des valeurs nulles. Quand le point tombe dans un de ces trous, on
 * echantillonne une couronne autour et on moyenne ce qui revient.
 */
async function granulometrie(lat, lon) {
  const direct = await granulometrieBrute(lat, lon);
  if (Number.isFinite(direct.argile)) return { ...direct, echantillon: 'point' };

  for (const rayon of [600, 1200]) {
    const releves = [];
    for (const [pLat, pLon] of couronne(lat, lon, rayon, 4)) {
      await pause(PAUSE_COURONNE_MS);
      const releve = await granulometrieBrute(pLat, pLon).catch(() => null);
      if (releve && Number.isFinite(releve.argile)) releves.push(releve);
    }
    if (releves.length) {
      const moyenne = (cle) => {
        const valeurs = releves.map((r) => r[cle]).filter(Number.isFinite);
        return valeurs.length ? valeurs.reduce((a, b) => a + b, 0) / valeurs.length : null;
      };
      return {
        argile: moyenne('argile'),
        limon: moyenne('limon'),
        sable: moyenne('sable'),
        densite: moyenne('densite'),
        echantillon: `couronne ${rayon} m (${releves.length}/4 points)`,
      };
    }
  }

  return { argile: null, limon: null, sable: null, densite: null, echantillon: null };
}

/** n points regulierement repartis sur un cercle de rayon donne (metres). */
function couronne(lat, lon, rayon, n) {
  const dLat = rayon / 111320;
  const dLon = rayon / (111320 * Math.cos((lat * Math.PI) / 180));
  return Array.from({ length: n }, (_, i) => {
    const angle = (2 * Math.PI * i) / n;
    return [lat + dLat * Math.cos(angle), lon + dLon * Math.sin(angle)];
  });
}

async function granulometrieBrute(lat, lon) {
  const url = new URL('https://rest.isric.org/soilgrids/v2.0/properties/query');
  url.searchParams.set('lon', lon);
  url.searchParams.set('lat', lat);
  for (const prop of ['clay', 'silt', 'sand', 'bdod']) url.searchParams.append('property', prop);
  for (const prof of ['0-5cm', '5-15cm']) url.searchParams.append('depth', prof);
  url.searchParams.set('value', 'mean');

  const json = await (await fetchAvecReprises(url)).json();
  const couches = json?.properties?.layers ?? [];

  const lire = (nom) => {
    const couche = couches.find((c) => c.name === nom);
    if (!couche) return null;
    const facteur = couche.unit_measure?.d_factor ?? 1;
    const valeurs = couche.depths
      .map((d) => d.values?.mean)
      .filter((v) => Number.isFinite(v))
      .map((v) => v / facteur);
    if (!valeurs.length) return null;
    return valeurs.reduce((a, b) => a + b, 0) / valeurs.length;
  };

  return {
    argile: lire('clay'),
    limon: lire('silt'),
    sable: lire('sand'),
    densite: lire('bdod'),
  };
}

/* ------------------------------ BRGM ------------------------------ */

const RE_DESCR = /DESCR\s*=\s*'([^']*)'/;
const RE_TYPE = /TYPE\s*=\s*'([^']*)'/;

async function lithologie(lat, lon) {
  const delta = 0.01;
  const url = new URL('http://geoservices.brgm.fr/geologie');
  const params = {
    SERVICE: 'WMS',
    VERSION: '1.3.0',
    REQUEST: 'GetFeatureInfo',
    LAYERS: 'LITHO_1M_SIMPLIFIEE',
    QUERY_LAYERS: 'LITHO_1M_SIMPLIFIEE',
    CRS: 'EPSG:4326',
    // En WMS 1.3.0 avec EPSG:4326, la bbox est ordonnee lat,lon.
    BBOX: `${lat - delta},${lon - delta},${lat + delta},${lon + delta}`,
    WIDTH: '101',
    HEIGHT: '101',
    I: '50',
    J: '50',
    // Le service BRGM ne supporte pas application/json sur cette couche.
    INFO_FORMAT: 'text/plain',
    FORMAT: 'image/png',
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const texte = await (await fetchAvecReprises(url)).text();
  return {
    descr: texte.match(RE_DESCR)?.[1] ?? null,
    type: texte.match(RE_TYPE)?.[1] ?? null,
  };
}

/* ------------------------- Altitude / pente ----------------------- */

async function relief(lat, lon) {
  const dLat = PAS_MNT / 111320;
  const dLon = PAS_MNT / (111320 * Math.cos((lat * Math.PI) / 180));

  // Ordre : centre, nord, sud, est, ouest
  const points = [
    [lon, lat],
    [lon, lat + dLat],
    [lon, lat - dLat],
    [lon + dLon, lat],
    [lon - dLon, lat],
  ];

  const url = new URL('https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json');
  url.searchParams.set('lon', points.map((p) => p[0].toFixed(6)).join('|'));
  url.searchParams.set('lat', points.map((p) => p[1].toFixed(6)).join('|'));
  url.searchParams.set('resource', 'ign_rge_alti_wld');
  url.searchParams.set('zonly', 'false');

  const json = await (await fetchAvecReprises(url)).json();
  const z = (json.elevations ?? []).map((e) => e.z);
  if (z.length !== 5 || z.some((v) => !Number.isFinite(v) || v < -100)) {
    return { altitude: Number.isFinite(z[0]) ? Math.round(z[0]) : null, pentePct: null, exposition: null };
  }

  const [centre, nord, sud, est, ouest] = z;
  const dzdx = (est - ouest) / (2 * PAS_MNT); // x vers l'est
  const dzdy = (nord - sud) / (2 * PAS_MNT); // y vers le nord

  const pentePct = Math.sqrt(dzdx ** 2 + dzdy ** 2) * 100;

  // Exposition = azimut de la ligne de plus grande pente descendante,
  // compte depuis le nord dans le sens horaire.
  let exposition = null;
  if (pentePct > 0.5) {
    exposition = (Math.atan2(-dzdx, -dzdy) * 180) / Math.PI;
    if (exposition < 0) exposition += 360;
  }

  return {
    altitude: Math.round(centre),
    pentePct: Math.round(pentePct * 10) / 10,
    exposition: exposition === null ? null : Math.round(exposition),
  };
}

/* ------------------------------ Main ------------------------------ */

const { spots } = JSON.parse(await readFile(ENTREE, 'utf8'));
const resultats = [];
const echecs = [];

console.log(`Enrichissement de ${spots.length} spots...\n`);

for (const [index, spot] of spots.entries()) {
  const etiquette = `[${String(index + 1).padStart(2)}/${spots.length}] ${spot.nom}`;
  try {
    // Relief et lithologie n'ont pas de quota : on les lance en parallele.
    const [sol, litho, terrain] = await Promise.all([
      granulometrie(spot.lat, spot.lon),
      lithologie(spot.lat, spot.lon),
      relief(spot.lat, spot.lon),
    ]);

    if (![sol.argile, sol.limon, sol.sable].every(Number.isFinite)) {
      throw new Error('granulometrie SoilGrids indisponible');
    }

    const hydro = parametresHydro({
      argile: sol.argile,
      limon: sol.limon,
      sable: sol.sable,
      densite: sol.densite ?? 1.3,
      litho,
      pentePct: terrain.pentePct ?? 0,
      exposition: terrain.exposition,
    });

    const enrichi = {
      ...spot,
      altitude: terrain.altitude,
      pentePct: terrain.pentePct,
      exposition: terrain.exposition,
      sol: {
        argile: arrondi(sol.argile, 1),
        limon: arrondi(sol.limon, 1),
        sable: arrondi(sol.sable, 1),
        densite: arrondi(sol.densite, 2),
        echantillon: sol.echantillon,
      },
      lithologie: litho,
      hydro: {
        thetaWp: arrondi(hydro.thetaWp, 4),
        thetaFc: arrondi(hydro.thetaFc, 4),
        thetaSat: arrondi(hydro.thetaSat, 4),
        stockWp: arrondi(hydro.stockWp, 2),
        stockFc: arrondi(hydro.stockFc, 2),
        stockSat: arrondi(hydro.stockSat, 2),
        drainage: arrondi(hydro.drainage, 4),
        ruissellementBase: arrondi(hydro.ruissellementBase, 4),
        kcExposition: arrondi(hydro.kcExposition, 4),
        texture: hydro.texture,
        litho: hydro.litho,
      },
      resume: decrireSol(hydro),
    };

    resultats.push(enrichi);
    console.log(
      `${etiquette}\n` +
        `      ${terrain.altitude} m | pente ${terrain.pentePct}% | expo ${terrain.exposition ?? '-'}deg\n` +
        `      argile ${enrichi.sol.argile}% limon ${enrichi.sol.limon}% sable ${enrichi.sol.sable}% | ${litho.descr ?? 'lithologie inconnue'}\n` +
        `      -> ${enrichi.resume} (drainage ${hydro.drainage.toFixed(2)})\n`
    );
  } catch (err) {
    echecs.push({ spot: spot.nom, erreur: err.message });
    console.error(`${etiquette}\n      ECHEC : ${err.message}\n`);
  }

  if (index < spots.length - 1) await pause(PAUSE_SOILGRIDS_MS);
}

await writeFile(
  SORTIE,
  JSON.stringify({ genere: new Date().toISOString(), spots: resultats }, null, 2),
  'utf8'
);

console.log(`\n${resultats.length}/${spots.length} spots enrichis -> data/spots.enriched.json`);
if (echecs.length) {
  console.log(`${echecs.length} echec(s) :`);
  for (const e of echecs) console.log(`  - ${e.spot} : ${e.erreur}`);
  process.exitCode = 1;
}

function arrondi(v, d) {
  if (!Number.isFinite(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
