/**
 * Meteo Boue — assemblage de l'interface.
 *
 * Chaine complete :
 *   spots.enriched.json (sol fige) + Open-Meteo (meteo du jour)
 *     -> bilan hydrique quotidien
 *     -> etat de sol par jour, sur 7 jours passes et 7 jours a venir.
 */

import { bilanHydrique, delaiAvantSechage, cumulPluie } from './mud-model.js';
import { vitesseSechage } from './soil.js';
import { meteoTousSpots, humiditeModele, JOURS_PASSES, JOURS_FUTURS } from './weather.js';

const TOULOUSE = { lat: 43.6045, lon: 1.4442 };

const COULEURS_TEXTURE = { argile: '#9a3412', limon: '#ca8a04', sable: '#fcd34d' };

/** Etats consideres comme roulables, du plus au moins agreable. */
const ORDRE_ETATS = ['parfait', 'humide', 'sec', 'gele', 'neige', 'gras', 'degel', 'bourbier'];

const el = (id) => document.getElementById(id);

const etat = {
  spots: [],
  bilans: new Map(), // id -> jours[]
  indexAujourdhui: new Map(), // id -> index du jour courant dans jours[]
  selection: null,
  marqueurs: new Map(),
  carte: null,
};

/* ------------------------------------------------------------------ */
/* Demarrage                                                           */
/* ------------------------------------------------------------------ */

demarrer().catch((err) => {
  console.error(err);
  afficherErreur(`Impossible de charger les données : ${err.message}`);
  el('chargement').hidden = true;
});

async function demarrer() {
  const reponse = await fetch('./data/spots.enriched.json');
  if (!reponse.ok) {
    throw new Error(
      "spots.enriched.json est introuvable — lancez d'abord « node scripts/enrich-spots.mjs »"
    );
  }
  const { spots, genere } = await reponse.json();
  etat.spots = spots;

  initialiserCarte();
  remplirFiltreZones(spots);

  const meteo = await meteoTousSpots(spots);
  calculerBilans(spots, meteo);

  el('chargement').hidden = true;
  el('liste-spots').hidden = false;
  el('horodatage').textContent = `Sol : relevé ${formaterDateCourte(genere)} · météo à l’instant`;

  dessinerListe();
  dessinerMarqueurs();

  el('filtre-zone').addEventListener('change', dessinerListe);
  el('tri').addEventListener('change', dessinerListe);
  el('fermer-detail').addEventListener('click', fermerDetail);
  el('rafraichir').addEventListener('click', () => {
    localStorage.removeItem('meteoboue.meteo.v2');
    location.reload();
  });
}

function calculerBilans(spots, meteo) {
  const aujourdhui = dateDuJour();

  for (const spot of spots) {
    const donnees = meteo.get(spot.id);
    if (!donnees?.daily) continue;

    const jours = bilanHydrique(donnees.daily, spot.hydro);
    let index = donnees.daily.time.indexOf(aujourdhui);
    // Filet de securite si le fuseau de l'API et celui du navigateur divergent.
    if (index === -1) index = Math.max(0, jours.length - JOURS_FUTURS - 1);

    etat.bilans.set(spot.id, jours);
    etat.indexAujourdhui.set(spot.id, index);
  }
}

/* ------------------------------------------------------------------ */
/* Carte                                                               */
/* ------------------------------------------------------------------ */

function initialiserCarte() {
  etat.carte = new maplibregl.Map({
    container: 'carte',
    style: {
      version: 8,
      sources: {
        ign: {
          type: 'raster',
          tiles: [
            'https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile' +
              '&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&TILEMATRIXSET=PM' +
              '&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/png',
          ],
          tileSize: 256,
          attribution: '&copy; IGN-F/Géoportail — sol : BRGM, SoilGrids — météo : Open-Meteo',
        },
      },
      layers: [{ id: 'ign', type: 'raster', source: 'ign' }],
    },
    center: [1.55, 43.25],
    zoom: 7.7,
  });

  etat.carte.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  etat.carte.addControl(new maplibregl.ScaleControl({ maxWidth: 90, unit: 'metric' }));
}

function dessinerMarqueurs() {
  for (const spot of etat.spots) {
    const jour = jourCourant(spot.id);
    if (!jour) continue;

    const noeud = document.createElement('div');
    noeud.className = 'marqueur';
    noeud.style.background = jour.etat.couleur;
    noeud.title = `${spot.nom} — ${jour.etat.label}`;
    noeud.addEventListener('click', (e) => {
      e.stopPropagation();
      selectionner(spot.id, { recentrer: false });
    });

    new maplibregl.Marker({ element: noeud }).setLngLat([spot.lon, spot.lat]).addTo(etat.carte);
    etat.marqueurs.set(spot.id, noeud);
  }
}

/* ------------------------------------------------------------------ */
/* Liste                                                               */
/* ------------------------------------------------------------------ */

function remplirFiltreZones(spots) {
  const zones = [...new Set(spots.map((s) => s.zone))].sort();
  const select = el('filtre-zone');
  for (const zone of zones) {
    const option = document.createElement('option');
    option.value = zone;
    option.textContent = zone;
    select.append(option);
  }
}

function dessinerListe() {
  const zone = el('filtre-zone').value;
  const tri = el('tri').value;

  let liste = etat.spots.filter((s) => etat.bilans.has(s.id));
  if (zone) liste = liste.filter((s) => s.zone === zone);

  liste.sort((a, b) => {
    switch (tri) {
      case 'nom':
        return a.nom.localeCompare(b.nom, 'fr');
      case 'altitude':
        return (b.altitude ?? 0) - (a.altitude ?? 0);
      case 'distance':
        return distanceToulouse(a) - distanceToulouse(b);
      default: {
        const rangA = ORDRE_ETATS.indexOf(jourCourant(a.id).etat.cle);
        const rangB = ORDRE_ETATS.indexOf(jourCourant(b.id).etat.cle);
        if (rangA !== rangB) return rangA - rangB;
        return jourCourant(a.id).indice - jourCourant(b.id).indice;
      }
    }
  });

  const ul = el('liste-spots');
  ul.replaceChildren();

  for (const spot of liste) {
    const jour = jourCourant(spot.id);
    const li = document.createElement('li');
    li.className = 'spot' + (spot.id === etat.selection ? ' spot--actif' : '');
    li.dataset.id = spot.id;

    li.innerHTML = `
      <div class="spot__barre" style="background:${jour.etat.couleur}"></div>
      <div>
        <div class="spot__nom">${echapper(spot.nom)}</div>
        <div class="spot__meta">${spot.altitude ?? '?'} m · ${echapper(spot.hydro.texture)} · ${Math.round(distanceToulouse(spot))} km</div>
      </div>
      <div class="spot__etat" style="color:${jour.etat.couleur}">
        ${jour.etat.court}
        <span class="spot__indice">indice ${jour.indice}</span>
      </div>`;

    li.addEventListener('click', () => selectionner(spot.id, { recentrer: true }));
    ul.append(li);
  }
}

/* ------------------------------------------------------------------ */
/* Détail                                                              */
/* ------------------------------------------------------------------ */

function selectionner(id, { recentrer }) {
  etat.selection = id;
  dessinerListe();

  for (const [autreId, noeud] of etat.marqueurs) {
    noeud.classList.toggle('marqueur--actif', autreId === id);
  }

  const spot = etat.spots.find((s) => s.id === id);
  if (recentrer) {
    etat.carte.flyTo({ center: [spot.lon, spot.lat], zoom: 10.5, duration: 700 });
  }

  dessinerDetail(spot);
  el('detail').hidden = false;
  el('detail').scrollTop = 0;
}

function fermerDetail() {
  etat.selection = null;
  el('detail').hidden = true;
  for (const noeud of etat.marqueurs.values()) noeud.classList.remove('marqueur--actif');
  dessinerListe();
}

function dessinerDetail(spot) {
  const jours = etat.bilans.get(spot.id);
  const idx = etat.indexAujourdhui.get(spot.id);
  const jour = jours[idx];

  const debut = Math.max(0, idx - JOURS_PASSES);
  const fin = Math.min(jours.length, idx + JOURS_FUTURS + 1);
  const fenetre = jours.slice(debut, fin);
  const pluieMax = Math.max(6, ...fenetre.map((j) => j.pluie + j.neige));

  const cellules = fenetre
    .map((j, i) => {
      const position = debut + i;
      const classes = [
        'jour',
        position > idx ? 'jour--futur' : '',
        position === idx ? 'jour--aujourdhui' : '',
      ]
        .filter(Boolean)
        .join(' ');

      const precip = j.pluie + j.neige;
      const hauteur = precip > 0 ? Math.max(3, (precip / pluieMax) * 100) : 0;
      const date = new Date(`${j.date}T12:00:00`);

      return `
        <div class="${classes}" title="${echapper(infobulle(j))}">
          <div class="jour__date">
            ${date.toLocaleDateString('fr-FR', { weekday: 'short' }).replace('.', '')}
            <strong>${date.getDate()}</strong>
          </div>
          <div class="jour__pluie">
            <div class="jour__pluie-barre" style="height:${hauteur}%"></div>
          </div>
          <div class="jour__pluie-valeur">${precip >= 0.5 ? precip.toFixed(0) : ''}</div>
          <div class="jour__etat" style="background:${j.etat.couleur}">${j.indice}</div>
        </div>`;
    })
    .join('');

  const h = spot.hydro;
  const total = spot.sol.argile + spot.sol.limon + spot.sol.sable || 100;

  el('detail-contenu').innerHTML = `
    <h2>${echapper(spot.nom)}</h2>
    <p class="detail__meta">
      ${echapper(spot.zone)} · ${spot.altitude ?? '?'} m · pente ${spot.pentePct ?? '?'} %
      · versant ${cardinal(spot.exposition)} · ${Math.round(distanceToulouse(spot))} km de Toulouse
    </p>

    <div class="verdict" style="border-left-color:${jour.etat.couleur}">
      <span class="verdict__etat" style="color:${jour.etat.couleur}">${jour.etat.label}</span>
      <span class="verdict__texte">${echapper(conseil(jours, idx))}</span>
    </div>

    <div class="frise">${cellules}</div>
    <div class="frise-legende">
      <span>← 7 jours passés (observé)</span>
      <span>barres : précipitations mm · pastille : indice de boue 0-100</span>
      <span>aujourd’hui encadré · 7 jours à venir (prévu, hachuré) →</span>
    </div>

    <div class="fiches">
      <div class="fiche">
        <h3>Nature du sol</h3>
        <div class="texture">
          <span style="width:${(spot.sol.argile / total) * 100}%;background:${COULEURS_TEXTURE.argile}"></span>
          <span style="width:${(spot.sol.limon / total) * 100}%;background:${COULEURS_TEXTURE.limon}"></span>
          <span style="width:${(spot.sol.sable / total) * 100}%;background:${COULEURS_TEXTURE.sable}"></span>
        </div>
        <div class="texture-legende">
          <span><i style="background:${COULEURS_TEXTURE.argile}"></i>argile ${spot.sol.argile} %</span>
          <span><i style="background:${COULEURS_TEXTURE.limon}"></i>limon ${spot.sol.limon} %</span>
          <span><i style="background:${COULEURS_TEXTURE.sable}"></i>sable ${spot.sol.sable} %</span>
        </div>
        <p class="note">
          ${echapper(h.texture)} sur ${echapper(spot.lithologie.descr ?? 'lithologie inconnue')}
          (BRGM) — ${echapper(vitesseSechage(h.drainage))}.
        </p>
      </div>

      <div class="fiche">
        <h3>Bilan hydrique aujourd’hui</h3>
        <dl>
          <dt>Réserve du sol</dt><dd>${jour.stock} mm</dd>
          <dt>Capacité au champ</dt><dd>${h.stockFc.toFixed(0)} mm</dd>
          <dt>Saturation</dt><dd>${Math.round(jour.humidite * 100)} %</dd>
          <dt>Pluie 7 j. passés</dt><dd>${cumulPluie(jours, idx - 1, JOURS_PASSES)} mm</dd>
          <dt>Pluie 7 j. à venir</dt><dd>${cumulPluieFuture(jours, idx)} mm</dd>
          ${jour.manteauNeigeux > 1 ? `<dt>Manteau neigeux</dt><dd>${jour.manteauNeigeux} mm eq.</dd>` : ''}
        </dl>
      </div>

      <div class="fiche">
        <h3>Paramètres du modèle</h3>
        <dl>
          <dt>Drainage / jour</dt><dd>${(h.drainage * 100).toFixed(0)} %</dd>
          <dt>Ruissellement</dt><dd>${(h.ruissellementBase * 100).toFixed(0)} %</dd>
          <dt>Effet d’exposition</dt><dd>×${h.kcExposition.toFixed(2)}</dd>
          <dt>Réservoir 0-15 cm</dt><dd>${h.stockWp.toFixed(0)}–${h.stockSat.toFixed(0)} mm</dd>
        </dl>
        <p class="note" id="signal-modele">Signal modèle Open-Meteo : chargement…</p>
      </div>
    </div>`;

  chargerSignalModele(spot, jours, idx);
}

/**
 * Compare notre bilan a l'humidite de sol simulee par Open-Meteo.
 * C'est un controle de coherence sur la dynamique, pas une verite terrain :
 * le modele meteo ignore le sol local.
 */
async function chargerSignalModele(spot, jours, idx) {
  const cible = el('signal-modele');
  try {
    const parJour = await humiditeModele(spot);
    // La carte peut avoir change de spot pendant la requete.
    if (etat.selection !== spot.id || !cible.isConnected) return;
    if (!parJour) {
      cible.textContent = 'Signal modèle Open-Meteo : indisponible.';
      return;
    }

    const valeurs = jours
      .slice(Math.max(0, idx - JOURS_PASSES), idx + 1)
      .map((j) => parJour[j.date])
      .filter(Number.isFinite);

    if (valeurs.length < 2) {
      cible.textContent = 'Signal modèle Open-Meteo : indisponible.';
      return;
    }

    const actuel = valeurs.at(-1);
    const tendance = actuel - valeurs[0];
    // Seuil large : sous 2 points d'humidite volumique, la derive du modele
    // ne se distingue pas d'une vraie tendance.
    const sens = tendance > 0.02 ? 'en charge' : tendance < -0.02 ? 'en ressuyage' : 'stable';
    cible.textContent =
      `Signal modèle Open-Meteo : ${(actuel * 100).toFixed(0)} % d’humidité de sol, ${sens} ` +
      `sur 7 jours. Grille de plusieurs km, à lire comme une tendance.`;
  } catch {
    if (cible.isConnected) cible.textContent = 'Signal modèle Open-Meteo : indisponible.';
  }
}

/* ------------------------------------------------------------------ */
/* Formulation du conseil                                              */
/* ------------------------------------------------------------------ */

function conseil(jours, idx) {
  const jour = jours[idx];
  const delai = delaiAvantSechage(jours, idx);
  const pluieAVenir = cumulPluieFuture(jours, idx);

  if (jour.etat.cle === 'neige') return 'Sentiers sous la neige — plutôt raquettes que VTT.';
  if (jour.etat.cle === 'gele') return 'Sol gelé, donc dur et roulant. Attention au verglas en dévers.';
  if (jour.etat.cle === 'degel')
    return 'Sol en dégel : c’est le moment où l’on abîme le plus les sentiers. À éviter.';

  if (delai === 0) {
    const degradation = jours
      .slice(idx + 1, idx + 1 + JOURS_FUTURS)
      .findIndex((j) => ['gras', 'bourbier'].includes(j.etat.cle));
    if (degradation >= 0) {
      return `Ça roule. Ça se dégrade dans ${degradation + 1} j (${pluieAVenir} mm annoncés).`;
    }
    return pluieAVenir > 5
      ? `Ça roule, et ça devrait tenir malgré les ${pluieAVenir} mm annoncés.`
      : 'Ça roule, et rien de méchant à l’horizon.';
  }

  if (delai === null) {
    return `Gras, et ça ne ressuie pas sur la fenêtre de prévision (${pluieAVenir} mm à venir).`;
  }
  return delai === 1
    ? 'Encore gras aujourd’hui, ça devrait être bon dès demain.'
    : `Encore gras. Compter ${delai} jours avant que ça redevienne roulant.`;
}

function cumulPluieFuture(jours, idx) {
  let total = 0;
  for (let i = idx + 1; i <= Math.min(jours.length - 1, idx + JOURS_FUTURS); i++) {
    total += jours[i].pluie + jours[i].neige;
  }
  return Math.round(total * 10) / 10;
}

function infobulle(j) {
  const morceaux = [
    j.date,
    j.etat.label,
    `indice ${j.indice}`,
    `réserve ${j.stock} mm`,
    `pluie ${j.pluie} mm`,
  ];
  if (j.neige > 0) morceaux.push(`neige ${j.neige} cm`);
  if (j.tmin !== null && j.tmax !== null) morceaux.push(`${Math.round(j.tmin)}/${Math.round(j.tmax)} °C`);
  return morceaux.join(' · ');
}

/* ------------------------------------------------------------------ */
/* Utilitaires                                                         */
/* ------------------------------------------------------------------ */

function jourCourant(id) {
  const jours = etat.bilans.get(id);
  if (!jours) return null;
  return jours[etat.indexAujourdhui.get(id)];
}

/** Date du jour dans le fuseau de Paris, au format ISO court. */
function dateDuJour() {
  return new Intl.DateTimeFormat('fr-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function formaterDateCourte(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

function distanceToulouse(spot) {
  const R = 6371;
  const dLat = ((spot.lat - TOULOUSE.lat) * Math.PI) / 180;
  const dLon = ((spot.lon - TOULOUSE.lon) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((TOULOUSE.lat * Math.PI) / 180) *
      Math.cos((spot.lat * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const POINTS_CARDINAUX = ['nord', 'nord-est', 'est', 'sud-est', 'sud', 'sud-ouest', 'ouest', 'nord-ouest'];

function cardinal(azimut) {
  if (azimut === null || !Number.isFinite(azimut)) return 'plat';
  return POINTS_CARDINAUX[Math.round(azimut / 45) % 8];
}

function echapper(texte) {
  const div = document.createElement('div');
  div.textContent = texte ?? '';
  return div.innerHTML;
}

function afficherErreur(message) {
  const boite = el('erreur');
  boite.textContent = message;
  boite.hidden = false;
}
