/**
 * Acces a Open-Meteo.
 *
 * L'API accepte plusieurs coordonnees dans une seule requete : les 24 spots
 * sont donc recuperes en un unique appel HTTP.
 *
 * La fenetre demandee couvre :
 *   - JOURS_AMORCE jours passes, qui servent a amorcer le bilan hydrique
 *     (sans eux on ignorerait dans quel etat le reservoir demarre),
 *   - les JOURS_PASSES derniers jours et les JOURS_FUTURS a venir, affiches.
 *
 * L'API est libre d'acces en usage non commercial et gere le CORS :
 * le navigateur l'appelle directement, aucun backend n'est necessaire.
 */

const BASE = 'https://api.open-meteo.com/v1/forecast';

/** Jours d'historique demandes, amorce du reservoir comprise. */
export const JOURS_AMORCE = 60;
/** Jours passes affiches, avant aujourd'hui. */
export const JOURS_PASSES = 7;
/** Jours de prevision affiches, apres aujourd'hui. */
export const JOURS_FUTURS = 7;
/**
 * forecast_days compte aujourd'hui : pour obtenir JOURS_FUTURS jours reellement
 * a venir, il en faut un de plus. La frise couvre donc 7 + 1 + 7 = 15 jours.
 */
const FORECAST_DAYS = JOURS_FUTURS + 1;

const VARIABLES_JOUR = [
  'rain_sum',
  'snowfall_sum',
  'precipitation_sum',
  'et0_fao_evapotranspiration',
  'temperature_2m_max',
  'temperature_2m_min',
  'temperature_2m_mean',
  'weather_code',
];

const DUREE_CACHE_MS = 3 * 60 * 60 * 1000; // 3 h : les modeles ne tournent que quelques fois par jour
const CLE_CACHE = 'meteoboue.meteo.v2';

/**
 * Meteo de tous les spots en une requete.
 * @returns {Map<string, object>} series journalieres, indexees par id de spot
 */
export async function meteoTousSpots(spots) {
  const enCache = lireCache(spots);
  if (enCache) return enCache;

  const url = new URL(BASE);
  url.searchParams.set('latitude', spots.map((s) => s.lat).join(','));
  url.searchParams.set('longitude', spots.map((s) => s.lon).join(','));
  url.searchParams.set('past_days', String(JOURS_AMORCE));
  url.searchParams.set('forecast_days', String(FORECAST_DAYS));
  url.searchParams.set('daily', VARIABLES_JOUR.join(','));
  url.searchParams.set('timezone', 'Europe/Paris');

  const reponse = await fetch(url, { signal: AbortSignal.timeout(45000) });
  if (!reponse.ok) throw new Error(`Open-Meteo a repondu ${reponse.status}`);

  const json = await reponse.json();
  // L'API renvoie un objet pour un point unique, un tableau au-dela.
  const lieux = Array.isArray(json) ? json : [json];
  if (lieux.length !== spots.length) {
    throw new Error(`Open-Meteo a renvoye ${lieux.length} lieux pour ${spots.length} spots`);
  }

  const parSpot = new Map();
  spots.forEach((spot, i) => {
    parSpot.set(spot.id, { daily: lieux[i].daily, altitudeModele: lieux[i].elevation });
  });

  ecrireCache(spots, parSpot);
  return parSpot;
}

/**
 * Humidite de sol simulee par le modele meteo, pour un spot donne.
 *
 * Chargee a la demande : ces series horaires sont volumineuses et ne servent
 * que dans le detail d'un spot.
 *
 * Attention a l'interpretation : elle vient d'un modele de surface sur une
 * grille de plusieurs kilometres, avec sa propre hypothese de texture. Elle
 * decrit bien la DYNAMIQUE (quand le sol se charge, quand il ressuie) mais pas
 * le sol local. On l'affiche comme signal de controle en regard de notre bilan.
 */
export async function humiditeModele({ lat, lon }) {
  const url = new URL(BASE);
  url.searchParams.set('latitude', lat);
  url.searchParams.set('longitude', lon);
  url.searchParams.set('past_days', String(JOURS_PASSES));
  url.searchParams.set('forecast_days', String(FORECAST_DAYS));
  url.searchParams.set('hourly', 'soil_moisture_0_to_1cm,soil_moisture_3_to_9cm');
  url.searchParams.set('timezone', 'Europe/Paris');

  const reponse = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!reponse.ok) throw new Error(`Open-Meteo a repondu ${reponse.status}`);
  const json = await reponse.json();
  return agregerParJour(json.hourly);
}

function agregerParJour(hourly) {
  if (!hourly?.time) return null;
  const parJour = new Map();

  for (let i = 0; i < hourly.time.length; i++) {
    const jour = hourly.time[i].slice(0, 10);
    const valeurs = [hourly.soil_moisture_0_to_1cm?.[i], hourly.soil_moisture_3_to_9cm?.[i]].filter(
      Number.isFinite
    );
    if (!valeurs.length) continue;
    if (!parJour.has(jour)) parJour.set(jour, []);
    parJour.get(jour).push(valeurs.reduce((a, b) => a + b, 0) / valeurs.length);
  }

  const resultat = {};
  for (const [jour, valeurs] of parJour) {
    resultat[jour] = valeurs.reduce((a, b) => a + b, 0) / valeurs.length;
  }
  return resultat;
}

/* ------------------------------ Cache ----------------------------- */
/* Evite de recharger a chaque rafraichissement de la page.            */

function signature(spots) {
  return spots.map((s) => s.id).join('|');
}

function lireCache(spots) {
  try {
    const brut = localStorage.getItem(CLE_CACHE);
    if (!brut) return null;
    const { horodatage, signature: sig, entrees } = JSON.parse(brut);
    if (sig !== signature(spots)) return null;
    if (Date.now() - horodatage > DUREE_CACHE_MS) return null;
    return new Map(entrees);
  } catch {
    return null;
  }
}

function ecrireCache(spots, parSpot) {
  try {
    localStorage.setItem(
      CLE_CACHE,
      JSON.stringify({
        horodatage: Date.now(),
        signature: signature(spots),
        entrees: [...parSpot],
      })
    );
  } catch {
    // Quota depasse ou stockage indisponible : le cache est optionnel.
  }
}
