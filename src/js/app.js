/**
 * Meteo Boue — assemblage de l'interface.
 *
 * Chaine complete :
 *   spots.enriched.json (sol fige) + Open-Meteo (meteo du jour)
 *     -> bilan hydrique quotidien
 *     -> etat de sol par jour, sur 7 jours passes et 7 jours a venir.
 *
 * L'interface est organisee autour d'une seule question : « ou et quand ? ».
 * D'ou la grille spots x jours plutot qu'une liste, et un jour actif qui
 * recolore la carte et reordonne les spots.
 */

import {
  bilanHydrique,
  delaiAvantSechage,
  cumulPluie,
  couleurEtat,
  ETATS_ROULABLES,
} from './mud-model.js';
import { vitesseSechage } from './soil.js';
import { meteoTousSpots, humiditeModele, JOURS_PASSES, JOURS_FUTURS } from './weather.js';

const TOULOUSE = { lat: 43.6045, lon: 1.4442 };
const COULEURS_TEXTURE = { argile: '#9a3412', limon: '#ca8a04', sable: '#fcd34d' };

/** Detour routier moyen par rapport a la distance a vol d'oiseau. */
const FACTEUR_ROUTE = 1.3;
/** Vitesse moyenne retenue pour estimer un temps de trajet, en km/h. */
const VITESSE_MOYENNE = 68;

const el = (id) => document.getElementById(id);

const etat = {
  spots: [],
  jours: new Map(), // id -> bilan journalier complet
  idxAuj: 0, // index d'aujourd'hui dans les series
  jourActif: 0, // index du jour selectionne
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

  const meteo = await meteoTousSpots(spots);
  calculerBilans(spots, meteo);
  etat.jourActif = etat.idxAuj;

  el('chargement').remove();
  el('horodatage').textContent = `Sol : relevé ${formaterDateCourte(genere)}`;

  dessinerTableau();
  dessinerMarqueurs();
  dessinerVerdict();

  el('filtre-distance').addEventListener('change', rafraichirVues);
  el('tri').addEventListener('change', rafraichirVues);
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

    etat.jours.set(spot.id, bilanHydrique(donnees.daily, spot.hydro));

    // Toutes les series viennent du meme appel : l'axe des dates est commun.
    if (!etat.dates) {
      etat.dates = donnees.daily.time;
      const trouve = etat.dates.indexOf(aujourdhui);
      // Filet de securite si le fuseau de l'API et celui du navigateur divergent.
      etat.idxAuj = trouve === -1 ? etat.dates.length - JOURS_FUTURS - 1 : trouve;
    }
  }
}

/** Les 15 index affiches : 7 jours passes, aujourd'hui, 7 a venir. */
function fenetre() {
  const debut = Math.max(0, etat.idxAuj - JOURS_PASSES);
  const fin = Math.min((etat.dates?.length ?? 0) - 1, etat.idxAuj + JOURS_FUTURS);
  const index = [];
  for (let i = debut; i <= fin; i++) index.push(i);
  return index;
}

function rafraichirVues() {
  dessinerTableau();
  majMarqueurs();
  dessinerVerdict();
}

/* ------------------------------------------------------------------ */
/* Selection des spots affiches                                        */
/* ------------------------------------------------------------------ */

function spotsAffiches() {
  const distanceMax = Number(el('filtre-distance').value) || Infinity;
  const tri = el('tri').value;

  const liste = etat.spots.filter(
    (s) => etat.jours.has(s.id) && distanceVol(s) <= distanceMax
  );

  liste.sort((a, b) => {
    switch (tri) {
      case 'nom':
        return a.nom.localeCompare(b.nom, 'fr');
      case 'altitude':
        return (b.altitude ?? 0) - (a.altitude ?? 0);
      case 'distance':
        return distanceVol(a) - distanceVol(b);
      default: {
        // Meilleur le jour choisi, puis le plus proche a qualite egale.
        const ecart = jourDe(b.id).etat.roulabilite - jourDe(a.id).etat.roulabilite;
        return ecart !== 0 ? ecart : distanceVol(a) - distanceVol(b);
      }
    }
  });

  return liste;
}

/* ------------------------------------------------------------------ */
/* Bandeau de verdict                                                  */
/* ------------------------------------------------------------------ */

function dessinerVerdict() {
  const boite = el('verdict-jour');
  const liste = spotsAffiches();
  boite.hidden = false;

  if (!liste.length) {
    boite.innerHTML = `<p class="verdict-jour__texte">Aucun spot dans ce rayon.</p>`;
    return;
  }

  const roulables = liste.filter((s) => ETATS_ROULABLES.includes(jourDe(s.id).etat.cle));
  const aEviter = liste.filter((s) => jourDe(s.id).etat.roulabilite < 40);
  const quand = nomJour(etat.jourActif);

  let phrase;
  if (!roulables.length) {
    const moinsPire = liste[0];
    phrase =
      `Rien de vraiment roulant ${quand}. Le moins mauvais : ` +
      `<strong>${echapper(moinsPire.nom)}</strong> (${trajet(moinsPire)}, ` +
      `${jourDe(moinsPire.id).etat.label.toLowerCase()}).`;
  } else {
    // Le plus proche qui roule est presque toujours le choix pratique.
    const proche = [...roulables].sort((a, b) => distanceVol(a) - distanceVol(b))[0];
    phrase =
      `<strong>${roulables.length} spots sur ${liste.length}</strong> sont roulants ${quand}. ` +
      `Le plus proche : <strong>${echapper(proche.nom)}</strong> (${trajet(proche)}, ` +
      `${jourDe(proche.id).etat.label.toLowerCase()}).`;
    if (aEviter.length) {
      const noms = aEviter.slice(0, 3).map((s) => echapper(s.nom)).join(', ');
      phrase += ` À éviter : ${noms}${aEviter.length > 3 ? '…' : ''}.`;
    }
  }

  const couleur = couleurEtat(jourDe(liste[0].id).etat);
  boite.innerHTML = `
    <span class="verdict-jour__pastille" style="background:${couleur}"></span>
    <p class="verdict-jour__texte">${phrase}</p>`;
}

/* ------------------------------------------------------------------ */
/* Grille spots x jours                                                */
/* ------------------------------------------------------------------ */

function dessinerTableau() {
  const conteneur = el('tableau');
  const index = fenetre();
  const liste = spotsAffiches();

  conteneur.style.setProperty('--nb-jours', index.length);
  conteneur.replaceChildren();

  // --- En-tete : les colonnes de jours servent de selecteur ---
  const entete = document.createElement('div');
  entete.className = 'tab__ligne tab__ligne--entete';
  entete.append(cellule('div', 'tab__coin', 'Spot'));

  for (const i of index) {
    const date = new Date(`${etat.dates[i]}T12:00:00`);
    const bouton = document.createElement('button');
    bouton.type = 'button';
    bouton.className =
      'tab__jour' +
      (i === etat.jourActif ? ' tab__jour--actif' : '') +
      (i === etat.idxAuj ? ' tab__jour--aujourdhui' : '') +
      (i > etat.idxAuj ? ' tab__jour--futur' : '');
    bouton.innerHTML =
      `<span>${date.toLocaleDateString('fr-FR', { weekday: 'short' }).replace('.', '')}</span>` +
      `<strong>${date.getDate()}</strong>`;
    bouton.title = `Voir ${nomJour(i)}`;
    bouton.addEventListener('click', () => choisirJour(i));
    entete.append(bouton);
  }
  conteneur.append(entete);

  // --- Une ligne par spot ---
  const corps = document.createElement('div');
  corps.className = 'tab__corps';

  for (const spot of liste) {
    const ligne = document.createElement('div');
    ligne.className = 'tab__ligne' + (spot.id === etat.selection ? ' tab__ligne--active' : '');

    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'tab__label';
    label.innerHTML =
      `<span class="tab__nom">${echapper(spot.nom)}</span>` +
      `<span class="tab__meta">${trajet(spot)} · ${spot.altitude ?? '?'} m</span>`;
    label.addEventListener('click', () => selectionner(spot.id, { recentrer: true }));
    ligne.append(label);

    const jours = etat.jours.get(spot.id);
    for (const i of index) {
      const j = jours[i];
      const c = document.createElement('button');
      c.type = 'button';
      c.className =
        'tab__cellule' +
        (i === etat.jourActif ? ' tab__cellule--colonne' : '') +
        (i > etat.idxAuj ? ' tab__cellule--futur' : '');
      c.style.background = couleurEtat(j.etat);
      c.title = `${spot.nom} — ${nomJour(i)} : ${j.etat.label}${j.pluie >= 0.5 ? `, ${j.pluie} mm de pluie` : ''}`;
      if (j.etat.glyphe) {
        c.innerHTML = `<span class="tab__glyphe">${j.etat.glyphe}</span>`;
      }
      c.addEventListener('click', () => {
        choisirJour(i);
        selectionner(spot.id, { recentrer: true });
      });
      ligne.append(c);
    }

    corps.append(ligne);
  }

  conteneur.append(corps);
}

function choisirJour(i) {
  etat.jourActif = i;
  rafraichirVues();
  if (etat.selection) dessinerDetail(etat.spots.find((s) => s.id === etat.selection));
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
    zoom: 7.6,
  });

  etat.carte.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  etat.carte.addControl(new maplibregl.ScaleControl({ maxWidth: 90, unit: 'metric' }));
}

function dessinerMarqueurs() {
  for (const spot of etat.spots) {
    if (!etat.jours.has(spot.id)) continue;

    const noeud = document.createElement('div');
    noeud.className = 'marqueur';
    noeud.addEventListener('click', (e) => {
      e.stopPropagation();
      selectionner(spot.id, { recentrer: false });
    });

    new maplibregl.Marker({ element: noeud }).setLngLat([spot.lon, spot.lat]).addTo(etat.carte);
    etat.marqueurs.set(spot.id, noeud);
  }
  majMarqueurs();
}

/** Recolore la carte pour le jour actif, et masque les spots filtres. */
function majMarqueurs() {
  const visibles = new Set(spotsAffiches().map((s) => s.id));

  for (const [id, noeud] of etat.marqueurs) {
    const j = jourDe(id);
    noeud.style.background = couleurEtat(j.etat);
    noeud.textContent = j.etat.glyphe ?? '';
    noeud.title = `${etat.spots.find((s) => s.id === id).nom} — ${j.etat.label}`;
    noeud.classList.toggle('marqueur--estompe', !visibles.has(id));
    noeud.classList.toggle('marqueur--actif', id === etat.selection);
  }
}

/* ------------------------------------------------------------------ */
/* Détail                                                              */
/* ------------------------------------------------------------------ */

function selectionner(id, { recentrer }) {
  etat.selection = id;
  dessinerTableau();
  majMarqueurs();

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
  dessinerTableau();
  majMarqueurs();
}

function dessinerDetail(spot) {
  const jours = etat.jours.get(spot.id);
  const idx = etat.jourActif;
  const jour = jours[idx];
  const index = fenetre();
  const pluieMax = Math.max(6, ...index.map((i) => jours[i].pluie + jours[i].neige));

  const colonnes = index
    .map((i) => {
      const j = jours[i];
      const precip = j.pluie + j.neige;
      const hauteur = precip > 0 ? Math.max(3, (precip / pluieMax) * 100) : 0;
      const date = new Date(`${j.date}T12:00:00`);
      const classes = [
        'jour',
        i > etat.idxAuj ? 'jour--futur' : '',
        i === etat.jourActif ? 'jour--actif' : '',
      ]
        .filter(Boolean)
        .join(' ');

      return `
        <div class="${classes}" title="${echapper(infobulle(j))}">
          <div class="jour__date">
            ${date.toLocaleDateString('fr-FR', { weekday: 'short' }).replace('.', '')}
            <strong>${date.getDate()}</strong>
          </div>
          <div class="jour__pluie"><div class="jour__pluie-barre" style="height:${hauteur}%"></div></div>
          <div class="jour__pluie-valeur">${precip >= 0.5 ? precip.toFixed(0) : ''}</div>
          <div class="jour__etat" style="background:${couleurEtat(j.etat)}">${j.etat.glyphe ?? ''}</div>
        </div>`;
    })
    .join('');

  const h = spot.hydro;
  const total = spot.sol.argile + spot.sol.limon + spot.sol.sable || 100;

  el('detail-contenu').innerHTML = `
    <h2>${echapper(spot.nom)}</h2>
    <p class="detail__meta">
      ${echapper(spot.zone)} · ${trajet(spot)} · ${spot.altitude ?? '?'} m
      · pente ${spot.pentePct ?? '?'} % · versant ${cardinal(spot.exposition)}
    </p>

    <div class="verdict" style="border-left-color:${couleurEtat(jour.etat)}">
      <span class="verdict__quand">${majuscule(nomJour(idx))}</span>
      <span class="verdict__etat" style="color:${couleurEtat(jour.etat)}">${jour.etat.label}</span>
      <span class="verdict__texte">${echapper(conseil(jours, idx))}</span>
    </div>

    <div class="frise">${colonnes}</div>
    <div class="frise-legende">
      <span>← 7 jours passés (observé)</span>
      <span>barres bleues : précipitations en mm</span>
      <span>7 jours à venir (prévu, hachuré) →</span>
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
        <h3>Bilan hydrique</h3>
        <dl>
          <dt>Saturation</dt><dd>${Math.round(jour.humidite * 100)} %</dd>
          <dt>Réserve du sol</dt><dd>${jour.stock} mm</dd>
          <dt>Capacité au champ</dt><dd>${h.stockFc.toFixed(0)} mm</dd>
          <dt>Pluie 7 j. passés</dt><dd>${cumulPluie(jours, etat.idxAuj - 1, JOURS_PASSES)} mm</dd>
          <dt>Pluie 7 j. à venir</dt><dd>${cumulPluieFuture(jours)} mm</dd>
          ${jour.manteauNeigeux > 1 ? `<dt>Manteau neigeux</dt><dd>${jour.manteauNeigeux} mm eq.</dd>` : ''}
        </dl>
      </div>

      <div class="fiche">
        <h3>Paramètres du modèle</h3>
        <dl>
          <dt>Indice de boue</dt><dd>${jour.indice} / 100</dd>
          <dt>Drainage / jour</dt><dd>${(h.drainage * 100).toFixed(0)} %</dd>
          <dt>Ruissellement</dt><dd>${(h.ruissellementBase * 100).toFixed(0)} %</dd>
          <dt>Effet d’exposition</dt><dd>×${h.kcExposition.toFixed(2)}</dd>
        </dl>
        <p class="note" id="signal-modele">Signal modèle Open-Meteo : chargement…</p>
      </div>
    </div>`;

  chargerSignalModele(spot, jours);
}

/**
 * Compare notre bilan a l'humidite de sol simulee par Open-Meteo.
 * C'est un controle de coherence sur la dynamique, pas une verite terrain :
 * le modele meteo ignore le sol local.
 */
async function chargerSignalModele(spot, jours) {
  const cible = el('signal-modele');
  try {
    const parJour = await humiditeModele(spot);
    if (etat.selection !== spot.id || !cible.isConnected) return;
    if (!parJour) {
      cible.textContent = 'Signal modèle Open-Meteo : indisponible.';
      return;
    }

    const valeurs = jours
      .slice(Math.max(0, etat.idxAuj - JOURS_PASSES), etat.idxAuj + 1)
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
  const pluieAVenir = cumulPluieFuture(jours);

  if (jour.etat.cle === 'neige') return 'Sentiers sous la neige — plutôt raquettes que VTT.';
  if (jour.etat.cle === 'gele') return 'Sol dur et roulant. Attention au verglas en dévers.';
  if (jour.etat.cle === 'degel')
    return 'C’est le moment où l’on abîme le plus les sentiers. À éviter.';

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
    return `Ça ne ressuie pas sur la fenêtre de prévision (${pluieAVenir} mm à venir).`;
  }
  return delai === 1
    ? 'Ça devrait être bon dès le lendemain.'
    : `Compter ${delai} jours avant que ça redevienne roulant.`;
}

function cumulPluieFuture(jours) {
  let total = 0;
  for (let i = etat.idxAuj + 1; i <= Math.min(jours.length - 1, etat.idxAuj + JOURS_FUTURS); i++) {
    total += jours[i].pluie + jours[i].neige;
  }
  return Math.round(total * 10) / 10;
}

function infobulle(j) {
  const morceaux = [j.date, j.etat.label, `indice ${j.indice}`, `pluie ${j.pluie} mm`];
  if (j.neige > 0) morceaux.push(`neige ${j.neige} cm`);
  if (j.tmin !== null && j.tmax !== null) {
    morceaux.push(`${Math.round(j.tmin)}/${Math.round(j.tmax)} °C`);
  }
  return morceaux.join(' · ');
}

/* ------------------------------------------------------------------ */
/* Utilitaires                                                         */
/* ------------------------------------------------------------------ */

/** Etat d'un spot le jour actif. */
function jourDe(id) {
  return etat.jours.get(id)[etat.jourActif];
}

/** Nom relatif d'un jour : « aujourd'hui », « demain », « samedi 5 »… */
function nomJour(i) {
  const ecart = i - etat.idxAuj;
  const relatifs = { '-2': 'avant-hier', '-1': 'hier', 0: 'aujourd’hui', 1: 'demain', 2: 'après-demain' };
  if (relatifs[ecart]) return relatifs[ecart];

  const date = new Date(`${etat.dates[i]}T12:00:00`);
  const jour = date.toLocaleDateString('fr-FR', { weekday: 'long' });
  return `${ecart < 0 ? `${jour} dernier` : jour} ${date.getDate()}`;
}

/** Distance a vol d'oiseau depuis Toulouse, en km. */
function distanceVol(spot) {
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

/**
 * Estimation de trajet depuis Toulouse. Volontairement grossiere : elle part
 * de la distance a vol d'oiseau, sans calcul d'itineraire.
 */
function trajet(spot) {
  const km = distanceVol(spot);
  const minutes = Math.round(((km * FACTEUR_ROUTE) / VITESSE_MOYENNE) * 60 + 8);
  const duree = minutes >= 60 ? `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}` : `${minutes} min`;
  return `~${duree}`;
}

const POINTS_CARDINAUX = ['nord', 'nord-est', 'est', 'sud-est', 'sud', 'sud-ouest', 'ouest', 'nord-ouest'];

function cardinal(azimut) {
  if (azimut === null || !Number.isFinite(azimut)) return 'plat';
  return POINTS_CARDINAUX[Math.round(azimut / 45) % 8];
}

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

function cellule(balise, classe, texte) {
  const n = document.createElement(balise);
  n.className = classe;
  n.textContent = texte;
  return n;
}

function majuscule(t) {
  return t.charAt(0).toUpperCase() + t.slice(1);
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
